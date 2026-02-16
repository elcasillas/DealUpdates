// DealUpdates - CRM Deal Notes Dashboard
// Main Application JavaScript

(function() {
    'use strict';

    // ==================== Domain imports ====================
    const { URGENCY_THRESHOLDS, CLOSING_SOON_DAYS, normalizeString, makeDealKey,
            sha256Hex, buildNotesCanonical, parseACV, parseDate,
            calculateDaysSince, getUrgencyLevel, calculateDaysUntilClosing,
            getClosingStatus } = window.DealDomain;

    // ==================== Ingest imports ====================
    const { COLUMN_MAPPINGS, parseCSV, parseCSVText, processRow, validateRow,
            deduplicateDeals, applyAISummaries, stripHTML, formatCurrency,
            generateFallbackSummary } = window.DealIngest;

    // ==================== Configuration ====================
    const STORAGE_KEY = 'dealUpdates_data';
    const SCHEMA_VERSION_KEY = 'dealUpdates_schema_version';
    const SCHEMA_VERSION = 1;
    const BATCH_SIZE = 500;

    // ==================== Supabase Client ====================
    let supabaseClient = null;
    let isOnline = false;
    let dateSelectionController = null;

    function initSupabase() {
        try {
            if (window.UI_ONLY) {
                console.log('UI-only mode: Supabase disabled. Using localStorage + CSV only.');
                return;
            }
            if (typeof SUPABASE_URL === 'undefined' || typeof SUPABASE_ANON_KEY === 'undefined') {
                console.warn('Supabase config not loaded. Running in offline/localStorage mode.');
                return;
            }
            if (SUPABASE_URL === 'https://YOUR_PROJECT.supabase.co' || SUPABASE_ANON_KEY === 'YOUR_ANON_KEY_HERE') {
                console.warn('Supabase not configured (still has placeholder values). Running in offline/localStorage mode.');
                return;
            }
            if (typeof window.supabase === 'undefined' || typeof window.supabase.createClient !== 'function') {
                console.error('Supabase JS library not loaded. Check CDN script tag.');
                return;
            }
            supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
            isOnline = true;
            console.log('Supabase connected to:', SUPABASE_URL);
        } catch (e) {
            console.error('Supabase initialization failed:', e);
        }
    }

    // ==================== Supabase CRUD ====================
    async function fetchUploadDates() {
        if (!supabaseClient) return [];
        const { data, error } = await supabaseClient
            .from('uploads')
            .select('id, generated_date, deal_count, uploaded_at, filename')
            .order('generated_date', { ascending: false })
            .order('uploaded_at', { ascending: false });
        if (error) {
            console.error('Error fetching uploads:', error);
            return [];
        }
        return data || [];
    }

    async function fetchDealsByUploadId(uploadId, signal) {
        if (!supabaseClient) return [];
        let query = supabaseClient
            .from('deals')
            .select('*')
            .eq('upload_id', uploadId);
        if (signal) query = query.abortSignal(signal);
        const { data, error } = await query;
        if (error) {
            if (error.name === 'AbortError' || signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            console.error('Error fetching deals:', error);
            return [];
        }
        return data || [];
    }

    async function deleteUpload(uploadId) {
        if (!supabaseClient) return false;
        // Delete deals first (foreign key dependency)
        const { error: dealsError } = await supabaseClient
            .from('deals')
            .delete()
            .eq('upload_id', uploadId);
        if (dealsError) {
            console.error('Error deleting deals:', dealsError);
            return false;
        }
        const { error: uploadError } = await supabaseClient
            .from('uploads')
            .delete()
            .eq('id', uploadId);
        if (uploadError) {
            console.error('Error deleting upload:', uploadError);
            return false;
        }
        return true;
    }

    async function insertUpload(generatedDate, filename, dealCount) {
        if (!supabaseClient) return null;
        const payload = {
            generated_date: generatedDate,
            filename: filename,
            deal_count: dealCount
        };
        console.log('insertUpload payload:', JSON.stringify(payload));
        const { data, error } = await supabaseClient
            .from('uploads')
            .insert(payload)
            .select()
            .single();
        if (error) {
            console.error('Error inserting upload:', error);
            return null;
        }
        return data;
    }

    async function insertDealsBatch(uploadId, deals) {
        if (!supabaseClient) return false;
        const rows = deals.map(deal => ({
            upload_id: uploadId,
            deal_owner: deal.dealOwner,
            deal_name: deal.dealName,
            stage: deal.stage,
            acv: deal.acv || 0,
            closing_date: deal.closingDate ? deal.closingDate.toISOString().slice(0, 10) : null,
            modified_date: deal.modifiedDate ? deal.modifiedDate.toISOString().slice(0, 10) : null,
            note_content: deal.noteContent,
            description: deal.description,
            notes_summary: deal.notesSummary
        }));

        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
            const batch = rows.slice(i, i + BATCH_SIZE);
            const { error } = await supabaseClient.from('deals').insert(batch);
            if (error) {
                console.error('Error inserting deals batch:', error);
                return false;
            }
        }
        return true;
    }

    // ==================== Deal Owner Contacts CRUD ====================
    async function fetchAllOwnerContacts() {
        if (!supabaseClient) return [];
        const { data, error } = await supabaseClient
            .from('deal_owners')
            .select('*')
            .order('owner_name', { ascending: true });
        if (error) {
            console.error('Error fetching owner contacts:', error);
            return [];
        }
        return data || [];
    }

    async function upsertOwnerContact(ownerName, email, phone) {
        if (!supabaseClient) return null;
        const { data, error } = await supabaseClient
            .from('deal_owners')
            .upsert({
                owner_name: ownerName,
                email: email || null,
                phone: phone || null
            }, { onConflict: 'owner_name' })
            .select()
            .single();
        if (error) {
            console.error('Error upserting owner contact:', error);
            return null;
        }
        return data;
    }

    // ==================== State ====================
    let allDeals = [];
    let filteredDeals = [];
    let currentSort = { column: 'daysSince', direction: 'desc' };
    let changesSummary = null;
    let ownerContactsCache = {};

    async function loadOwnerContacts() {
        const contacts = await fetchAllOwnerContacts();
        ownerContactsCache = {};
        for (const contact of contacts) {
            ownerContactsCache[contact.owner_name.toLowerCase().trim()] = contact;
        }
    }

    function getOwnerContact(ownerName) {
        if (!ownerName) return null;
        return ownerContactsCache[ownerName.toLowerCase().trim()] || null;
    }

    function updateOwnerContactCache(contact) {
        ownerContactsCache[contact.owner_name.toLowerCase().trim()] = contact;
    }

    // ==================== DOM Elements ====================
    const elements = {
        uploadZone: document.getElementById('upload-zone'),
        fileInput: document.getElementById('file-input'),
        statsSection: document.getElementById('stats-section'),
        filtersSection: document.getElementById('filters-section'),
        tableSection: document.getElementById('table-section'),
        tbody: document.getElementById('deals-tbody'),
        noResults: document.getElementById('no-results'),
        searchInput: document.getElementById('search-input'),
        filterOwner: document.getElementById('filter-owner'),
        filterStage: document.getElementById('filter-stage'),
        filterUrgency: document.getElementById('filter-urgency'),
        filterChanges: document.getElementById('filter-changes'),
        filterChangesGroup: document.getElementById('filter-changes-group'),
        changesSummaryEl: document.getElementById('changes-summary'),
        resetFiltersBtn: document.getElementById('reset-filters-btn'),
        exportBtn: document.getElementById('export-csv-btn'),
        rowCount: document.getElementById('row-count'),
        statTotal: document.getElementById('stat-total'),
        statAcv: document.getElementById('stat-acv'),
        statAvgDays: document.getElementById('stat-avg-days'),
        statStale: document.getElementById('stat-stale'),
        statOverdue: document.getElementById('stat-overdue'),
        ownerCards: document.getElementById('owner-cards'),
        reuploadZone: document.getElementById('reupload-zone'),
        reuploadDropzone: document.getElementById('reupload-dropzone'),
        reuploadFileInput: document.getElementById('reupload-file-input'),
        datePickerSection: document.getElementById('date-picker-section'),
        dateSelectPrimary: document.getElementById('date-select-primary'),
        dateSelectCompare: document.getElementById('date-select-compare'),
        loadingOverlay: document.getElementById('loading-overlay')
    };

    // ==================== Loading State ====================
    function showLoading(text) {
        document.getElementById('loading-text').textContent = text || 'Loading...';
        elements.loadingOverlay.classList.remove('hidden');
    }

    function hideLoading() {
        elements.loadingOverlay.classList.add('hidden');
    }

    async function generateAISummaries(deals, notesMap) {
        if (!supabaseClient) return null;

        // Build cache-first payload with deal_key, notes_hash, notes_canonical
        const payload = deals
            .filter(deal => deal.notesCanonical && deal.notesCanonical.length > 0)
            .map(deal => ({
                deal_key: deal.dealKey,
                notes_hash: deal.notesHash,
                notes_canonical: deal.notesCanonical,
                dealName: deal.dealName
            }));

        if (payload.length === 0) return null;

        try {
            console.log(`Requesting AI summaries for ${payload.length} deals...`);
            const { data, error } = await supabaseClient.functions.invoke('summarize-notes', {
                body: { deals: payload }
            });

            if (error) {
                console.warn('AI summary failed, using fallback:', error.message);
                return null;
            }

            console.log('AI summary response:', JSON.stringify(data));
            const summaries = data?.summaries;

            // New format: array of { deal_key, notes_hash, summary, cached }
            if (Array.isArray(summaries)) {
                const result = {};
                let cachedCount = 0;
                for (const s of summaries) {
                    if (s.summary) result[s.deal_key] = s.summary;
                    if (s.cached) cachedCount++;
                }
                console.log(`AI summaries: ${Object.keys(result).length} received, ${cachedCount} from server cache.`);
                return result;
            }

            // Legacy fallback: object keyed by dealName
            if (summaries && typeof summaries === 'object') {
                console.log('AI summaries received (legacy format).');
                return summaries;
            }

            console.warn('AI summary response missing summaries field:', data);
            return null;
        } catch (e) {
            console.warn('AI summary failed, using fallback:', e);
            return null;
        }
    }

    // ==================== Diff ====================
    function diffDeals(oldDeals, newDeals) {
        // Build lookup from old deals
        const oldMap = new Map();
        for (const deal of oldDeals) {
            oldMap.set(deal.dealKey || makeDealKey(deal.dealName, deal.dealOwner), deal);
        }

        let newCount = 0;
        let updatedCount = 0;
        let unchangedCount = 0;

        // Tag each new deal
        const newKeys = new Set();
        for (const deal of newDeals) {
            const key = deal.dealKey || makeDealKey(deal.dealName, deal.dealOwner);
            newKeys.add(key);
            const old = oldMap.get(key);

            if (!old) {
                deal.changeType = 'new';
                deal.changes = [];
                newCount++;
            } else {
                const changes = [];
                if (deal.stage !== old.stage) {
                    changes.push(`Stage: ${old.stage || '-'} \u2192 ${deal.stage || '-'}`);
                }
                if (Math.round(deal.acv || 0) !== Math.round(old.acv || 0)) {
                    changes.push(`ACV: ${formatCurrencyCompact(old.acv)} \u2192 ${formatCurrencyCompact(deal.acv)}`);
                }
                if ((deal.noteContent || '').trim() !== (old.noteContent || '').trim()) {
                    changes.push('Note updated');
                }

                if (changes.length > 0) {
                    deal.changeType = 'updated';
                    deal.changes = changes;
                    updatedCount++;
                } else {
                    deal.changeType = 'unchanged';
                    deal.changes = [];
                    unchangedCount++;
                }
            }
        }

        // Count removed deals
        let removedCount = 0;
        for (const key of oldMap.keys()) {
            if (!newKeys.has(key)) removedCount++;
        }

        return {
            newCount,
            updatedCount,
            removedCount,
            unchangedCount
        };
    }

    // ==================== Storage (offline fallback) ====================
    function saveToStorage(deals) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(deals));
        } catch (e) {
            console.error('Failed to save to localStorage:', e);
        }
    }

    function loadFromStorage() {
        try {
            const data = localStorage.getItem(STORAGE_KEY);
            if (data) {
                const deals = JSON.parse(data);
                // Restore Date objects
                return deals.map(deal => {
                    const closingDate = deal.closingDate ? new Date(deal.closingDate) : null;
                    const modifiedDate = deal.modifiedDate ? new Date(deal.modifiedDate) : null;
                    const daysSince = calculateDaysSince(modifiedDate);
                    const daysUntilClosing = calculateDaysUntilClosing(closingDate);
                    return {
                        ...deal,
                        closingDate,
                        modifiedDate,
                        daysSince,
                        urgency: getUrgencyLevel(daysSince),
                        daysUntilClosing,
                        closingStatus: getClosingStatus(daysUntilClosing)
                    };
                });
            }
        } catch (e) {
            console.error('Failed to load from localStorage:', e);
        }
        return null;
    }

    function checkSchemaVersion() {
        const stored = localStorage.getItem(SCHEMA_VERSION_KEY);
        if (stored === null) {
            // Fresh install or pre-versioning data — clear stale data, set version
            localStorage.removeItem(STORAGE_KEY);
            localStorage.setItem(SCHEMA_VERSION_KEY, String(SCHEMA_VERSION));
            return;
        }
        const version = parseInt(stored, 10);
        if (version < SCHEMA_VERSION) {
            console.warn(`Schema upgraded ${version} → ${SCHEMA_VERSION}. Clearing local cache.`);
            localStorage.removeItem(STORAGE_KEY);
            localStorage.setItem(SCHEMA_VERSION_KEY, String(SCHEMA_VERSION));
            return;
        }
        if (version > SCHEMA_VERSION) {
            console.warn(`Local data has schema v${version}, app expects v${SCHEMA_VERSION}. Data left untouched.`);
        }
    }

    function clearLocalData() {
        if (!confirm('Clear all locally stored deal data? This cannot be undone.')) return;
        localStorage.removeItem(STORAGE_KEY);
        localStorage.setItem(SCHEMA_VERSION_KEY, String(SCHEMA_VERSION));
        location.reload();
    }

    // ==================== Supabase Date Picker ====================
    async function populateDatePicker() {
        const primarySelect = elements.dateSelectPrimary;
        const compareSelect = elements.dateSelectCompare;

        if (!isOnline) {
            primarySelect.innerHTML = '<option value="">Supabase not connected</option>';
            primarySelect.disabled = true;
            compareSelect.innerHTML = '<option value="">Supabase not connected</option>';
            compareSelect.disabled = true;
            return;
        }

        primarySelect.disabled = false;
        compareSelect.disabled = false;

        const uploads = await fetchUploadDates();

        primarySelect.innerHTML = '<option value="">Select a date...</option>';
        compareSelect.innerHTML = '<option value="">None (no comparison)</option>';

        for (const upload of uploads) {
            const label = formatUploadLabel(upload);

            const opt1 = document.createElement('option');
            opt1.value = upload.id;
            opt1.textContent = label;
            primarySelect.appendChild(opt1);

            const opt2 = document.createElement('option');
            opt2.value = upload.id;
            opt2.textContent = label;
            compareSelect.appendChild(opt2);
        }

    }

    function formatUploadLabel(upload) {
        const date = new Date(upload.generated_date + 'T00:00:00');
        const formatted = date.toLocaleDateString('en-CA', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
        const uploadTime = new Date(upload.uploaded_at).toLocaleTimeString('en-CA', {
            hour: 'numeric',
            minute: '2-digit'
        });
        return `${formatted} (${upload.deal_count} deals) - uploaded ${uploadTime}`;
    }

    function supabaseRowToInternal(row) {
        const closingDate = row.closing_date ? new Date(row.closing_date + 'T00:00:00') : null;
        const modifiedDate = row.modified_date ? new Date(row.modified_date + 'T00:00:00') : null;
        const daysSince = calculateDaysSince(modifiedDate);
        const daysUntilClosing = calculateDaysUntilClosing(closingDate);
        return {
            dealOwner: row.deal_owner,
            dealName: row.deal_name,
            stage: row.stage,
            acv: parseFloat(row.acv) || 0,
            acvFormatted: formatCurrency(parseFloat(row.acv) || 0),
            closingDate,
            modifiedDate,
            daysSince,
            urgency: getUrgencyLevel(daysSince),
            daysUntilClosing,
            closingStatus: getClosingStatus(daysUntilClosing),
            noteContent: row.note_content || '',
            description: row.description || '',
            notesSummary: row.notes_summary || ''
        };
    }

    async function loadUploadById(uploadId, signal) {
        const rawDeals = await fetchDealsByUploadId(uploadId, signal);
        return rawDeals.map(supabaseRowToInternal);
    }

    async function handleDateSelection() {
        const primaryId = elements.dateSelectPrimary.value;
        const compareId = elements.dateSelectCompare.value;

        if (!primaryId) return;

        // Abort any pending date selection fetch
        if (dateSelectionController) dateSelectionController.abort();
        dateSelectionController = new AbortController();
        const signal = dateSelectionController.signal;

        showLoading();
        try {
            const primaryDeals = await loadUploadById(primaryId, signal);

            if (compareId) {
                const compareDeals = await loadUploadById(compareId, signal);
                // Compare: "compare" is the baseline, "primary" is the newer
                changesSummary = diffDeals(compareDeals, primaryDeals);
            } else {
                changesSummary = null;
                for (const deal of primaryDeals) {
                    deal.changeType = null;
                    deal.changes = [];
                }
            }

            allDeals = primaryDeals;
            filteredDeals = [...allDeals];
            saveToStorage(allDeals);
            populateFilterDropdowns(allDeals);
            renderStats(allDeals);
            applySorting();
            renderTable(filteredDeals);
            updateSortIndicators();
            updateRowCount();
            renderChangesSummary();
            showDashboard();
        } catch (e) {
            if (e.name === 'AbortError') return; // Superseded by a newer selection
            console.error('Error loading upload:', e);
            alert('Error loading data from Supabase.');
        } finally {
            hideLoading();
        }
    }

    // ==================== UI Rendering ====================
    function formatDate(date) {
        if (!date) return '-';
        return date.toLocaleDateString('en-CA', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    }

    function renderStats(deals) {
        const totalDeals = deals.length;
        const totalACV = deals.reduce((sum, d) => sum + (d.acv || 0), 0);
        const avgDays = deals.length > 0
            ? Math.round(deals.reduce((sum, d) => sum + d.daysSince, 0) / deals.length)
            : 0;
        const staleDeals = deals.filter(d => d.daysSince > 30).length;
        const overdueDeals = deals.filter(d => d.closingStatus === 'overdue').length;

        elements.statTotal.textContent = totalDeals.toLocaleString();
        elements.statAcv.textContent = formatCurrency(totalACV);
        elements.statAvgDays.textContent = avgDays;
        elements.statStale.textContent = staleDeals;
        elements.statOverdue.textContent = overdueDeals;

        // Render owner cards
        renderOwnerCards(deals);
    }

    function renderOwnerCards(deals) {
        // Group deals by owner
        const ownerStats = {};
        for (const deal of deals) {
            const owner = deal.dealOwner || 'Unknown';
            if (!ownerStats[owner]) {
                ownerStats[owner] = {
                    name: owner,
                    deals: 0,
                    totalACV: 0,
                    totalDays: 0,
                    overdue: 0
                };
            }
            ownerStats[owner].deals++;
            ownerStats[owner].totalACV += deal.acv || 0;
            ownerStats[owner].totalDays += deal.daysSince || 0;
            if (deal.closingStatus === 'overdue') ownerStats[owner].overdue++;
        }

        // Convert to array and sort by total ACV descending
        const owners = Object.values(ownerStats)
            .map(o => ({
                ...o,
                avgDays: o.deals > 0 ? Math.round(o.totalDays / o.deals) : 0
            }))
            .sort((a, b) => b.totalACV - a.totalACV);

        // Render cards
        elements.ownerCards.innerHTML = owners.map(owner => {
            const contact = getOwnerContact(owner.name);
            const contactIndicator = contact && contact.email
                ? `<div class="owner-card__contact"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 4L12 13 2 4"/></svg>${escapeHTML(contact.email)}</div>`
                : '<div class="owner-card__contact owner-card__contact--empty">No email set</div>';
            return `
            <div class="owner-card" data-owner="${escapeHTML(owner.name)}">
                <div class="owner-card__name">${escapeHTML(owner.name)}</div>
                ${contactIndicator}
                <div class="owner-card__stats">
                    <div class="owner-card__stat">
                        <span class="owner-card__stat-value">${owner.deals}</span>
                        <span class="owner-card__stat-label">Deals</span>
                    </div>
                    <div class="owner-card__stat">
                        <span class="owner-card__stat-value">${formatCurrencyCompact(owner.totalACV)}</span>
                        <span class="owner-card__stat-label">ACV</span>
                    </div>
                    <div class="owner-card__stat">
                        <span class="owner-card__stat-value">${owner.avgDays}</span>
                        <span class="owner-card__stat-label">Avg Days</span>
                    </div>
                    <div class="owner-card__stat">
                        <span class="owner-card__stat-value${owner.overdue > 0 ? ' owner-card__stat-value--danger' : ''}">${owner.overdue}</span>
                        <span class="owner-card__stat-label">Overdue</span>
                    </div>
                </div>
            </div>
        `}).join('');

        // Attach click handlers to owner cards
        elements.ownerCards.querySelectorAll('.owner-card').forEach(card => {
            card.addEventListener('click', () => {
                const ownerName = card.dataset.owner;
                if (elements.filterOwner.value === ownerName) {
                    elements.filterOwner.value = '';
                } else {
                    elements.filterOwner.value = ownerName;
                }
                applyFilters();
            });
        });

        updateOwnerCardActiveState();
    }

    function updateOwnerCardActiveState() {
        const activeOwner = elements.filterOwner.value;
        elements.ownerCards.querySelectorAll('.owner-card').forEach(card => {
            card.classList.toggle('owner-card--active', card.dataset.owner === activeOwner);
        });
    }

    function formatCurrencyCompact(value) {
        if (value >= 1000000) {
            return '$' + (value / 1000000).toFixed(1) + 'M';
        } else if (value >= 1000) {
            return '$' + (value / 1000).toFixed(0) + 'K';
        }
        return '$' + value.toFixed(0);
    }

    function renderTable(deals) {
        elements.tbody.innerHTML = '';

        if (deals.length === 0) {
            elements.noResults.classList.remove('hidden');
            return;
        }
        elements.noResults.classList.add('hidden');

        for (const deal of deals) {
            const row = document.createElement('tr');
            row.style.cursor = 'pointer';
            if (deal.changeType === 'new' || deal.changeType === 'updated') {
                row.classList.add(`change--${deal.changeType}`);
            }
            const changeDetail = deal.changeType === 'updated' && deal.changes && deal.changes.length > 0
                ? `<div class="change-detail">${deal.changes.map(c => escapeHTML(c)).join(' &middot; ')}</div>`
                : deal.changeType === 'new'
                ? '<div class="change-detail">New deal</div>'
                : '';
            row.innerHTML = `
                <td>${escapeHTML(deal.dealOwner)}</td>
                <td>${escapeHTML(deal.dealName)}${changeDetail}</td>
                <td>${escapeHTML(deal.stage)}</td>
                <td class="acv-value">${deal.acvFormatted}</td>
                <td class="date-value">${formatDate(deal.closingDate)}${deal.closingStatus === 'overdue' ? ' <span class="closing-badge closing-badge--overdue">Overdue</span>' : deal.closingStatus === 'soon' ? ' <span class="closing-badge closing-badge--soon">Closing Soon</span>' : ''}</td>
                <td class="date-value">${formatDate(deal.modifiedDate)}</td>
                <td>
                    <span class="urgency-badge urgency-badge--${deal.urgency}">
                        ${deal.daysSince} days
                    </span>
                </td>
                <td class="note-cell">
                    <div class="note-preview">${escapeHTML(deal.noteContent) || '-'}</div>
                </td>
            `;
            row.addEventListener('click', () => openDealModal(deal));
            elements.tbody.appendChild(row);
        }
    }

    // ==================== Deal Detail Modal ====================
    let currentModalDeal = null;

    function openDealModal(deal) {
        currentModalDeal = deal;
        document.getElementById('modal-deal-name').textContent = deal.dealName || '-';
        document.getElementById('modal-deal-owner').textContent = deal.dealOwner || '-';
        document.getElementById('modal-stage').textContent = deal.stage || '-';
        document.getElementById('modal-acv').textContent = deal.acvFormatted || '-';
        document.getElementById('modal-closing-date').innerHTML = formatDate(deal.closingDate) +
            (deal.closingStatus === 'overdue' ? ' <span class="closing-badge closing-badge--overdue">Overdue</span>' :
             deal.closingStatus === 'soon' ? ' <span class="closing-badge closing-badge--soon">Closing Soon</span>' : '');
        document.getElementById('modal-modified-date').textContent = formatDate(deal.modifiedDate) || '-';
        document.getElementById('modal-days-since').innerHTML =
            `<span class="urgency-badge urgency-badge--${deal.urgency}">${deal.daysSince} days</span>`;
        document.getElementById('modal-description').textContent = deal.description || 'No description available.';
        document.getElementById('modal-notes').textContent = deal.noteContent || 'No notes available.';
        document.getElementById('modal-notes-summary').textContent = deal.notesSummary || 'No summary available.';
        document.getElementById('deal-modal').classList.remove('hidden');
    }

    function closeDealModal() {
        document.getElementById('deal-modal').classList.add('hidden');
        currentModalDeal = null;
    }

    function emailDealOwner() {
        if (!currentModalDeal) return;
        const deal = currentModalDeal;
        const contact = getOwnerContact(deal.dealOwner);
        const toAddress = contact?.email || '';
        const firstName = (deal.dealOwner || '').split(' ')[0];

        if (!toAddress) {
            if (confirm(`No email address found for ${deal.dealOwner}.\n\nWould you like to open Manage Contacts to add their info?`)) {
                closeDealModal();
                openContactsModal(deal.dealOwner);
            }
            return;
        }

        const subject = `Update Request - ${deal.dealName}`;

        const lines = [
            `Hi ${firstName},`,
            '',
            'Could you please provide an update on the following deal?',
            '',
            '---',
            `Deal Name: ${deal.dealName}`,
            `Deal Owner: ${deal.dealOwner}`,
            `Stage: ${deal.stage || '-'}`,
            `ACV (CAD): ${deal.acvFormatted || '-'}`,
            `Closing Date: ${formatDate(deal.closingDate)}${deal.closingStatus === 'overdue' ? ' (Overdue)' : deal.closingStatus === 'soon' ? ' (Closing Soon)' : ''}`,
            `Modified Date: ${formatDate(deal.modifiedDate)}`,
            `Days Since Update: ${deal.daysSince} days`,
            '',
            `Description: ${deal.description || 'No description available.'}`,
            '',
            `Notes: ${deal.noteContent || 'No notes available.'}`,
            '---',
            '',
            'Thanks,'
        ];

        const body = lines.join('\n');
        const mailto = `mailto:${encodeURIComponent(toAddress)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        window.open(mailto, '_blank');
    }

    // ==================== Manage Contacts Modal ====================
    function openContactsModal(focusOwnerName) {
        renderContactsList();
        document.getElementById('contacts-modal').classList.remove('hidden');
        document.getElementById('contacts-search-input').value = '';

        if (focusOwnerName) {
            const normalizedName = focusOwnerName.toLowerCase().trim();
            const row = document.querySelector(
                `.contacts-modal__row[data-owner-normalized="${CSS.escape(normalizedName)}"]`
            );
            if (row) {
                row.scrollIntoView({ block: 'center' });
                startEditingContactRow(row);
            }
        }
    }

    function closeContactsModal() {
        document.getElementById('contacts-modal').classList.add('hidden');
    }

    function renderContactsList(filter) {
        const container = document.getElementById('contacts-list');
        const ownerNames = [...new Set(allDeals.map(d => d.dealOwner).filter(Boolean))].sort();

        const filterLower = (filter || '').toLowerCase();
        const filtered = filterLower
            ? ownerNames.filter(name => name.toLowerCase().includes(filterLower))
            : ownerNames;

        if (filtered.length === 0) {
            container.innerHTML = '<div class="contacts-modal__empty">No owners found.</div>';
            return;
        }

        container.innerHTML = filtered.map(name => {
            const contact = getOwnerContact(name);
            const normalizedName = name.toLowerCase().trim();
            const email = contact?.email || '';
            const phone = contact?.phone || '';

            return `
            <div class="contacts-modal__row" data-owner="${escapeHTML(name)}" data-owner-normalized="${escapeHTML(normalizedName)}">
                <div class="contacts-modal__row-display">
                    <div class="contacts-modal__owner-name">${escapeHTML(name)}</div>
                    <div class="contacts-modal__owner-email">${email ? escapeHTML(email) : '<span class="contacts-modal__not-set">No email</span>'}</div>
                    <div class="contacts-modal__owner-phone">${phone ? escapeHTML(phone) : '<span class="contacts-modal__not-set">No phone</span>'}</div>
                    <button class="contacts-modal__edit-btn" title="Edit contact">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                    </button>
                </div>
                <div class="contacts-modal__row-form hidden">
                    <div class="contacts-modal__field">
                        <label>Email</label>
                        <input type="email" class="contacts-modal__email-input" value="${escapeHTML(email)}" placeholder="owner@example.com">
                    </div>
                    <div class="contacts-modal__field">
                        <label>Phone</label>
                        <input type="tel" class="contacts-modal__phone-input" value="${escapeHTML(phone)}" placeholder="+1 (555) 000-0000">
                    </div>
                    <div class="contacts-modal__row-actions">
                        <button class="contacts-modal__save-btn">Save</button>
                        <button class="contacts-modal__cancel-btn">Cancel</button>
                    </div>
                </div>
            </div>`;
        }).join('');

        // Attach event listeners
        container.querySelectorAll('.contacts-modal__edit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                startEditingContactRow(e.target.closest('.contacts-modal__row'));
            });
        });

        container.querySelectorAll('.contacts-modal__save-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const row = e.target.closest('.contacts-modal__row');
                saveOwnerContactRow(row.dataset.owner, row.querySelector('.contacts-modal__email-input'), row.querySelector('.contacts-modal__phone-input'), row);
            });
        });

        container.querySelectorAll('.contacts-modal__cancel-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                cancelEditingContactRow(e.target.closest('.contacts-modal__row'));
            });
        });
    }

    function startEditingContactRow(row) {
        row.querySelector('.contacts-modal__row-display').classList.add('hidden');
        row.querySelector('.contacts-modal__row-form').classList.remove('hidden');
        row.querySelector('.contacts-modal__email-input').focus();
    }

    function cancelEditingContactRow(row) {
        const contact = getOwnerContact(row.dataset.owner);
        row.querySelector('.contacts-modal__email-input').value = contact?.email || '';
        row.querySelector('.contacts-modal__phone-input').value = contact?.phone || '';
        row.querySelector('.contacts-modal__row-display').classList.remove('hidden');
        row.querySelector('.contacts-modal__row-form').classList.add('hidden');
    }

    function setContactRowDisplayMode(row, contact) {
        const emailEl = row.querySelector('.contacts-modal__owner-email');
        const phoneEl = row.querySelector('.contacts-modal__owner-phone');
        emailEl.innerHTML = contact.email
            ? escapeHTML(contact.email)
            : '<span class="contacts-modal__not-set">No email</span>';
        phoneEl.innerHTML = contact.phone
            ? escapeHTML(contact.phone)
            : '<span class="contacts-modal__not-set">No phone</span>';
        row.querySelector('.contacts-modal__row-display').classList.remove('hidden');
        row.querySelector('.contacts-modal__row-form').classList.add('hidden');
    }

    async function saveOwnerContactRow(ownerName, emailInput, phoneInput, row) {
        const email = emailInput.value.trim();
        const phone = phoneInput.value.trim();

        const result = await upsertOwnerContact(ownerName, email, phone);
        if (result) {
            updateOwnerContactCache(result);
            setContactRowDisplayMode(row, result);
            if (allDeals.length > 0) {
                renderOwnerCards(allDeals);
            }
        } else {
            alert('Failed to save contact info. Check browser console for details.');
        }
    }

    function escapeHTML(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function populateFilterDropdowns(deals) {
        // Populate owners
        const owners = [...new Set(deals.map(d => d.dealOwner).filter(Boolean))].sort();
        elements.filterOwner.innerHTML = '<option value="">All Owners</option>';
        owners.forEach(owner => {
            const option = document.createElement('option');
            option.value = owner;
            option.textContent = owner;
            elements.filterOwner.appendChild(option);
        });

        // Populate stages
        const stages = [...new Set(deals.map(d => d.stage).filter(Boolean))].sort();
        elements.filterStage.innerHTML = '<option value="">All Stages</option>';
        stages.forEach(stage => {
            const option = document.createElement('option');
            option.value = stage;
            option.textContent = stage;
            elements.filterStage.appendChild(option);
        });
    }

    // ==================== Export ====================
    function escapeCSVField(value) {
        const str = String(value == null ? '' : value);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }

    function exportToCSV() {
        const headers = ['Deal Owner', 'Deal Name', 'Stage', 'ACV (CAD)', 'Closing Date', 'Modified Date', 'Days Since', 'Notes'];
        const rows = filteredDeals.map(deal => [
            escapeCSVField(deal.dealOwner),
            escapeCSVField(deal.dealName),
            escapeCSVField(deal.stage),
            escapeCSVField(deal.acv),
            escapeCSVField(deal.closingDate ? formatDate(deal.closingDate) : ''),
            escapeCSVField(deal.modifiedDate ? formatDate(deal.modifiedDate) : ''),
            escapeCSVField(deal.daysSince),
            escapeCSVField(deal.noteContent)
        ].join(','));

        const csv = [headers.join(','), ...rows].join('\r\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);

        const today = new Date().toISOString().slice(0, 10);
        const link = document.createElement('a');
        link.href = url;
        link.download = `deal-updates-${today}.csv`;
        link.click();
        URL.revokeObjectURL(url);
    }

    function updateRowCount() {
        const total = allDeals.length;
        const shown = filteredDeals.length;
        const hasFilters = elements.searchInput.value ||
            elements.filterOwner.value ||
            elements.filterStage.value ||
            elements.filterUrgency.value ||
            elements.filterChanges.value;

        if (hasFilters) {
            elements.rowCount.textContent = `Showing ${shown} of ${total} deals`;
        } else {
            elements.rowCount.textContent = `Showing all ${total} deals`;
        }
    }

    function renderChangesSummary() {
        if (!changesSummary) {
            elements.changesSummaryEl.classList.add('hidden');
            elements.filterChangesGroup.classList.add('hidden');
            return;
        }

        const { newCount, updatedCount, removedCount, unchangedCount } = changesSummary;
        elements.changesSummaryEl.innerHTML = `
            <span class="changes-summary__label">Changes detected:</span>
            <span class="changes-summary__counts">
                <span class="changes-summary__count changes-summary__count--new">${newCount} new</span>
                <span class="changes-summary__count changes-summary__count--updated">${updatedCount} updated</span>
                <span class="changes-summary__count changes-summary__count--removed">${removedCount} removed</span>
                <span class="changes-summary__count changes-summary__count--unchanged">${unchangedCount} unchanged</span>
            </span>
            <button class="changes-summary__dismiss" id="dismiss-changes-btn">Dismiss</button>
        `;
        elements.changesSummaryEl.classList.remove('hidden');
        elements.filterChangesGroup.classList.remove('hidden');

        // Attach dismiss handler
        document.getElementById('dismiss-changes-btn').addEventListener('click', clearChanges);
    }

    function clearChanges() {
        changesSummary = null;
        for (const deal of allDeals) {
            deal.changeType = null;
            deal.changes = [];
        }
        elements.filterChanges.value = '';
        renderChangesSummary();
        applyFilters();
    }

    function showDashboard() {
        elements.uploadZone.classList.add('hidden');
        elements.statsSection.classList.remove('hidden');
        elements.datePickerSection.classList.remove('hidden');
        elements.filtersSection.classList.remove('hidden');
        elements.reuploadZone.classList.remove('hidden');
        elements.rowCount.classList.remove('hidden');
        elements.tableSection.classList.remove('hidden');
    }

    function showUploadZone() {
        elements.uploadZone.classList.remove('hidden');
        elements.statsSection.classList.add('hidden');
        elements.datePickerSection.classList.add('hidden');
        elements.filtersSection.classList.add('hidden');
        elements.reuploadZone.classList.add('hidden');
        elements.rowCount.classList.add('hidden');
        elements.tableSection.classList.add('hidden');
    }

    // ==================== Filtering & Sorting ====================
    function resetFilters() {
        elements.searchInput.value = '';
        elements.filterOwner.value = '';
        elements.filterStage.value = '';
        elements.filterUrgency.value = '';
        elements.filterChanges.value = '';
        applyFilters();
    }

    function applyFilters() {
        const searchTerm = elements.searchInput.value.toLowerCase();
        const ownerFilter = elements.filterOwner.value;
        const stageFilter = elements.filterStage.value;
        const urgencyFilter = elements.filterUrgency.value;
        const changesFilter = elements.filterChanges.value;

        filteredDeals = allDeals.filter(deal => {
            // Search across all fields
            if (searchTerm) {
                const searchableText = [
                    deal.dealOwner,
                    deal.dealName,
                    deal.stage,
                    deal.noteContent
                ].join(' ').toLowerCase();

                if (!searchableText.includes(searchTerm)) {
                    return false;
                }
            }

            // Owner filter
            if (ownerFilter && deal.dealOwner !== ownerFilter) {
                return false;
            }

            // Stage filter
            if (stageFilter && deal.stage !== stageFilter) {
                return false;
            }

            // Urgency filter
            if (urgencyFilter && deal.urgency !== urgencyFilter) {
                return false;
            }

            // Changes filter
            if (changesFilter && deal.changeType !== changesFilter) {
                return false;
            }

            return true;
        });

        applySorting();
        renderTable(filteredDeals);
        updateRowCount();
        updateOwnerCardActiveState();
    }

    function applySorting() {
        const { column, direction } = currentSort;

        filteredDeals.sort((a, b) => {
            let valA = a[column];
            let valB = b[column];

            // Handle dates
            if (valA instanceof Date) valA = valA ? valA.getTime() : 0;
            if (valB instanceof Date) valB = valB ? valB.getTime() : 0;

            // Handle strings
            if (typeof valA === 'string') valA = valA.toLowerCase();
            if (typeof valB === 'string') valB = valB.toLowerCase();

            // Handle nulls
            if (valA == null) valA = '';
            if (valB == null) valB = '';

            let comparison = 0;
            if (valA < valB) comparison = -1;
            if (valA > valB) comparison = 1;

            return direction === 'asc' ? comparison : -comparison;
        });
    }

    function handleSort(column) {
        if (currentSort.column === column) {
            currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
        } else {
            currentSort.column = column;
            currentSort.direction = 'asc';
        }

        updateSortIndicators();
        applyFilters();
    }

    function updateSortIndicators() {
        document.querySelectorAll('th[data-sort]').forEach(th => {
            th.classList.remove('sort-asc', 'sort-desc');
            if (th.dataset.sort === currentSort.column) {
                th.classList.add(`sort-${currentSort.direction}`);
                th.setAttribute('aria-sort', currentSort.direction === 'asc' ? 'ascending' : 'descending');
            } else {
                th.setAttribute('aria-sort', 'none');
            }
        });
    }

    // ==================== File Handling ====================
    function handleFile(file) {
        if (!file.name.endsWith('.csv')) {
            alert('Please upload a CSV file.');
            return;
        }

        const reader = new FileReader();
        reader.onload = function(e) {
            processCSVData(e.target.result, file.name);
        };
        reader.readAsText(file);
    }

    // ==================== Web Worker Ingest ====================
    let activeWorker = null;

    function runIngestWorker(csvText, existingDeals) {
        return new Promise((resolve, reject) => {
            const worker = new Worker('js/ingest-worker.js');
            activeWorker = worker;

            worker.onmessage = function(e) {
                const msg = e.data;
                if (msg.type === 'progress') {
                    showLoading(msg.phase);
                } else if (msg.type === 'complete') {
                    activeWorker = null;
                    worker.terminate();
                    resolve({ deals: msg.deals, generatedDate: msg.generatedDate });
                } else if (msg.type === 'error') {
                    activeWorker = null;
                    worker.terminate();
                    reject(new Error(msg.message));
                }
            };

            worker.onerror = function(err) {
                activeWorker = null;
                worker.terminate();
                reject(new Error(err.message || 'Worker error'));
            };

            worker.postMessage({ csvText, existingDeals });
        });
    }

    async function processCSVData(csvText, filename) {
        showLoading('Processing...');
        try {
            // Run parse + process + validate + dedup in Web Worker
            const { deals: workerDeals, generatedDate: genDateISO } = await runIngestWorker(csvText, allDeals);

            // Determine upload date
            const uploadDate = genDateISO
                ? genDateISO.slice(0, 10)
                : new Date().toISOString().slice(0, 10);

            console.log('Upload date:', uploadDate);

            // Apply AI summaries on main thread (needs supabaseClient)
            showLoading('Generating summaries...');
            let processed = await applyAISummaries(workerDeals, allDeals, generateAISummaries);
            console.log(`After worker + AI: ${processed.length} deals`);

            if (processed.length === 0) {
                alert('No valid CAD deals found in the CSV file.');
                return;
            }

            // Upload to Supabase if online
            if (isOnline) {
                console.log('Supabase is online. Inserting upload record...');
                const upload = await insertUpload(uploadDate, filename || 'unknown.csv', processed.length);
                if (upload) {
                    console.log('Upload record created:', upload.id, '- Inserting', processed.length, 'deals...');
                    const success = await insertDealsBatch(upload.id, processed);
                    if (success) {
                        console.log('Successfully uploaded', processed.length, 'deals to Supabase.');
                        // Refresh date picker and auto-select this upload
                        await populateDatePicker();
                        elements.dateSelectPrimary.value = upload.id;
                        elements.dateSelectCompare.value = '';
                    } else {
                        alert('Error: Failed to insert deals into Supabase. Check browser console (F12) for details.');
                    }
                } else {
                    alert('Error: Failed to create upload record in Supabase. Check browser console (F12) for details.');
                }
            } else {
                console.warn('Supabase offline - data saved to localStorage only.');
            }

            // Diff against previous data if loaded
            if (allDeals.length > 0) {
                changesSummary = diffDeals(allDeals, processed);
            } else {
                changesSummary = null;
            }

            // Store and display
            allDeals = processed;
            filteredDeals = [...allDeals];

            saveToStorage(allDeals);
            populateFilterDropdowns(allDeals);
            renderStats(allDeals);
            applySorting();
            renderTable(filteredDeals);
            updateSortIndicators();
            updateRowCount();
            renderChangesSummary();
            showDashboard();
        } catch (error) {
            alert('Error processing CSV: ' + error.message);
            console.error(error);
        } finally {
            hideLoading();
        }
    }

    // ==================== Event Listeners ====================
    function setupEventListeners() {
        // File input
        elements.fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                handleFile(e.target.files[0]);
            }
        });

        // Drag and drop
        elements.uploadZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            elements.uploadZone.classList.add('drag-over');
        });

        elements.uploadZone.addEventListener('dragleave', () => {
            elements.uploadZone.classList.remove('drag-over');
        });

        elements.uploadZone.addEventListener('drop', (e) => {
            e.preventDefault();
            elements.uploadZone.classList.remove('drag-over');
            if (e.dataTransfer.files.length > 0) {
                handleFile(e.dataTransfer.files[0]);
            }
        });

        // Click to upload
        elements.uploadZone.addEventListener('click', (e) => {
            if (e.target !== elements.fileInput && !e.target.closest('.upload-btn')) {
                elements.fileInput.click();
            }
        });

        // Filters
        elements.searchInput.addEventListener('input', applyFilters);
        elements.filterOwner.addEventListener('change', applyFilters);
        elements.filterStage.addEventListener('change', applyFilters);
        elements.filterUrgency.addEventListener('change', applyFilters);
        elements.filterChanges.addEventListener('change', applyFilters);

        // Sorting
        document.querySelectorAll('th[data-sort]').forEach(th => {
            th.addEventListener('click', () => handleSort(th.dataset.sort));
        });

        // Reupload drop zone - file input
        elements.reuploadFileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                handleFile(e.target.files[0]);
                e.target.value = '';
            }
        });

        // Reupload drop zone - drag & drop
        elements.reuploadDropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            elements.reuploadDropzone.classList.add('drag-over');
        });

        elements.reuploadDropzone.addEventListener('dragleave', () => {
            elements.reuploadDropzone.classList.remove('drag-over');
        });

        elements.reuploadDropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            elements.reuploadDropzone.classList.remove('drag-over');
            if (e.dataTransfer.files.length > 0) {
                handleFile(e.dataTransfer.files[0]);
            }
        });

        // Click drop zone to open file picker
        elements.reuploadDropzone.addEventListener('click', (e) => {
            if (!e.target.closest('.upload-btn')) {
                elements.reuploadFileInput.click();
            }
        });

        // Date picker
        const deleteUploadBtn = document.getElementById('delete-upload-btn');
        elements.dateSelectPrimary.addEventListener('change', () => {
            deleteUploadBtn.disabled = !elements.dateSelectPrimary.value;
            handleDateSelection();
        });
        elements.dateSelectCompare.addEventListener('change', () => {
            if (elements.dateSelectPrimary.value) {
                handleDateSelection();
            }
        });

        // Delete upload
        deleteUploadBtn.addEventListener('click', async () => {
            const uploadId = elements.dateSelectPrimary.value;
            if (!uploadId) return;
            const selectedText = elements.dateSelectPrimary.options[elements.dateSelectPrimary.selectedIndex].text;
            if (!confirm(`Delete upload "${selectedText}"?\n\nThis will permanently remove this upload and all its deals.`)) return;

            showLoading();
            const success = await deleteUpload(uploadId);
            if (success) {
                await populateDatePicker();
                // Auto-select the latest remaining upload
                if (elements.dateSelectPrimary.options.length > 1) {
                    elements.dateSelectPrimary.selectedIndex = 1;
                    deleteUploadBtn.disabled = false;
                    await handleDateSelection();
                } else {
                    allDeals = [];
                    filteredDeals = [];
                    deleteUploadBtn.disabled = true;
                    hideLoading();
                }
            } else {
                alert('Failed to delete upload. Check browser console for details.');
                hideLoading();
            }
        });

        // Clear local data
        document.getElementById('clear-data-btn').addEventListener('click', clearLocalData);

        // Reset filters
        elements.resetFiltersBtn.addEventListener('click', resetFilters);

        // Export CSV
        elements.exportBtn.addEventListener('click', exportToCSV);

        // Deal detail modal
        document.getElementById('modal-email-btn').addEventListener('click', emailDealOwner);
        document.getElementById('modal-close').addEventListener('click', closeDealModal);
        document.getElementById('deal-modal').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) closeDealModal();
        });

        // Manage Contacts modal
        document.getElementById('manage-contacts-btn').addEventListener('click', () => openContactsModal());
        document.getElementById('contacts-modal-close').addEventListener('click', closeContactsModal);
        document.getElementById('contacts-modal').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) closeContactsModal();
        });
        document.getElementById('contacts-search-input').addEventListener('input', (e) => {
            renderContactsList(e.target.value);
        });

        // Escape key — close whichever modal is open
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (!document.getElementById('contacts-modal').classList.contains('hidden')) {
                    closeContactsModal();
                } else {
                    closeDealModal();
                }
            }
        });
    }

    // ==================== Initialization ====================
    async function init() {
        checkSchemaVersion();
        setupEventListeners();
        initSupabase();

        if (window.UI_ONLY) {
            if (elements.datePickerSection) elements.datePickerSection.classList.add('hidden');
            var badge = document.getElementById('ui-only-badge');
            if (badge) badge.classList.remove('hidden');
        }

        // Show Manage Contacts button only when online
        document.getElementById('manage-contacts-btn').classList.toggle('hidden', !isOnline);

        if (isOnline) {
            try {
                showLoading();
                await loadOwnerContacts();
                await populateDatePicker();

                // Auto-select the most recent upload
                const primarySelect = elements.dateSelectPrimary;
                if (primarySelect.options.length > 1) {
                    primarySelect.selectedIndex = 1;
                    await handleDateSelection();
                } else {
                    // No uploads yet - show upload zone
                    hideLoading();
                }
            } catch (e) {
                console.error('Failed to connect to Supabase, falling back to localStorage:', e);
                isOnline = false;
                hideLoading();
                loadFromLocalStorageFallback();
            }
        } else {
            loadFromLocalStorageFallback();
        }
    }

    function loadFromLocalStorageFallback() {
        populateDatePicker(); // Shows disabled state when offline
        const savedDeals = loadFromStorage();
        if (savedDeals && savedDeals.length > 0) {
            allDeals = savedDeals;
            filteredDeals = [...allDeals];
            populateFilterDropdowns(allDeals);
            renderStats(allDeals);
            applySorting();
            renderTable(filteredDeals);
            updateSortIndicators();
            updateRowCount();
            showDashboard();
        }
    }

    // Expose core functions for test harness (no-op in production)
    window._testAPI = {
        parseCSV,
        parseCSVText,
        processRow,
        validateRow,
        deduplicateDeals,
        parseACV,
        parseDate,
        stripHTML,
        generateFallbackSummary,
        normalizeString,
        makeDealKey,
        sha256Hex,
        buildNotesCanonical,
        COLUMN_MAPPINGS
    };

    // Start the application
    init();
})();
