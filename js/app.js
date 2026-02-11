// DealUpdates - CRM Deal Notes Dashboard
// Main Application JavaScript

(function() {
    'use strict';

    // ==================== Configuration ====================
    const STORAGE_KEY = 'dealUpdates_data';
    const URGENCY_THRESHOLDS = {
        fresh: 14,
        warning: 30,
        stale: 60
    };
    const CLOSING_SOON_DAYS = 14;
    const BATCH_SIZE = 500;

    // Column mappings for CSV parsing
    const COLUMN_MAPPINGS = {
        'Deal Owner': 'dealOwner',
        'Deal Name': 'dealName',
        'Stage': 'stage',
        'Annual Contract Value': 'acv',
        'Closing Date': 'closingDate',
        'Modified Time (Notes)': 'modifiedDate',
        'Note Content': 'noteContent'
    };

    // ==================== Supabase Client ====================
    let supabaseClient = null;
    let isOnline = false;

    function initSupabase() {
        try {
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
            .order('generated_date', { ascending: false });
        if (error) {
            console.error('Error fetching uploads:', error);
            return [];
        }
        return data || [];
    }

    async function fetchDealsByUploadId(uploadId) {
        if (!supabaseClient) return [];
        const { data, error } = await supabaseClient
            .from('deals')
            .select('*')
            .eq('upload_id', uploadId);
        if (error) {
            console.error('Error fetching deals:', error);
            return [];
        }
        return data || [];
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
            note_content: deal.noteContent
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

    // ==================== State ====================
    let allDeals = [];
    let filteredDeals = [];
    let currentSort = { column: 'daysSince', direction: 'desc' };
    let changesSummary = null;

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
    function showLoading() {
        elements.loadingOverlay.classList.remove('hidden');
    }

    function hideLoading() {
        elements.loadingOverlay.classList.add('hidden');
    }

    // ==================== CSV Parsing ====================
    function parseCSV(text) {
        // Remove BOM if present
        if (text.charCodeAt(0) === 0xFEFF) {
            text = text.slice(1);
        }

        // Parse all rows handling multiline quoted fields
        const allRows = parseCSVText(text);

        console.log('Total rows parsed:', allRows.length);
        console.log('First 3 rows:', allRows.slice(0, 3));

        if (allRows.length === 0) {
            throw new Error('No data found in CSV file.');
        }

        // Find header row and extract "Generated by" date
        let headerRowIndex = -1;
        let headers = [];
        let generatedDate = null;

        for (let i = 0; i < Math.min(allRows.length, 20); i++) {
            const row = allRows[i];

            // Check for "Generated by" row before finding header
            if (headerRowIndex === -1) {
                const joinedRow = row.join(' ').trim();
                if (/generated\s+by/i.test(joinedRow)) {
                    // Try to extract a date from this row
                    // Match patterns: 2/10/2026, 2026-02-10, Feb 10 2026, February 10, 2026, etc.
                    const datePatterns = [
                        /(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/,
                        /(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/,
                        /(\w+\s+\d{1,2},?\s+\d{4})/,
                        /(\d{1,2}\s+\w+\s+\d{4})/
                    ];
                    for (const pattern of datePatterns) {
                        const match = joinedRow.match(pattern);
                        if (match) {
                            const parsed = new Date(match[1]);
                            if (!isNaN(parsed.getTime())) {
                                generatedDate = parsed;
                                console.log('Extracted "Generated by" date:', generatedDate);
                                break;
                            }
                        }
                    }
                    if (!generatedDate) {
                        console.warn('Found "Generated by" row but could not parse date:', joinedRow);
                    }
                }
            }

            if (row.includes('Deal Owner') && row.includes('Deal Name')) {
                headerRowIndex = i;
                headers = row;
                console.log('Found header at row', i, ':', headers);
                break;
            }
        }

        if (headerRowIndex === -1) {
            throw new Error('Could not find header row. Looking for "Deal Owner" and "Deal Name" columns.');
        }

        const expectedColumns = headers.length;
        console.log('Expected columns:', expectedColumns);

        // Convert data rows to objects
        const rows = [];
        for (let i = headerRowIndex + 1; i < allRows.length; i++) {
            const values = allRows[i];

            // Skip completely empty rows
            if (values.length === 0 || (values.length === 1 && !values[0])) continue;

            // Log rows with unexpected column counts
            if (values.length !== expectedColumns) {
                console.log('Row', i, 'has', values.length, 'columns (expected', expectedColumns, '):', values[0]);
            }

            // Convert to object
            const row = {};
            headers.forEach((header, index) => {
                row[header] = values[index] || '';
            });
            rows.push(row);
        }

        console.log('Total data rows:', rows.length);
        return { rows, generatedDate };
    }

    // Parse entire CSV text, properly handling multiline quoted fields
    function parseCSVText(text) {
        const rows = [];
        let currentRow = [];
        let currentField = '';
        let inQuotes = false;

        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            const nextChar = text[i + 1];

            if (inQuotes) {
                // Inside a quoted field
                if (char === '"') {
                    if (nextChar === '"') {
                        // Escaped quote ("") - add single quote and skip next
                        currentField += '"';
                        i++;
                    } else {
                        // End of quoted field
                        inQuotes = false;
                    }
                } else {
                    // Any character inside quotes (including newlines) is part of the field
                    currentField += char;
                }
            } else {
                // Outside quotes
                if (char === '"') {
                    // Start of quoted field
                    inQuotes = true;
                } else if (char === ',') {
                    // Field separator - end current field
                    currentRow.push(currentField);
                    currentField = '';
                } else if (char === '\r') {
                    // Carriage return - check for Windows line ending
                    if (nextChar === '\n') {
                        i++; // Skip the \n
                    }
                    // End of row
                    currentRow.push(currentField);
                    rows.push(currentRow);
                    currentRow = [];
                    currentField = '';
                } else if (char === '\n') {
                    // Unix line ending - end of row
                    currentRow.push(currentField);
                    rows.push(currentRow);
                    currentRow = [];
                    currentField = '';
                } else {
                    // Regular character
                    currentField += char;
                }
            }
        }

        // Don't forget the last field and row
        if (currentField || currentRow.length > 0) {
            currentRow.push(currentField);
            rows.push(currentRow);
        }

        return rows;
    }

    // ==================== Data Processing ====================
    function processRow(row) {
        const deal = {};

        // Map columns
        for (const [csvCol, internalField] of Object.entries(COLUMN_MAPPINGS)) {
            deal[internalField] = row[csvCol] || '';
        }

        // Parse ACV - only keep CAD values
        const acvResult = parseACV(deal.acv);
        if (!acvResult.isCAD) {
            return null; // Skip non-CAD values
        }
        deal.acv = acvResult.value;
        deal.acvFormatted = formatCurrency(acvResult.value);

        // Parse and format dates
        deal.closingDate = parseDate(deal.closingDate);
        deal.modifiedDate = parseDate(deal.modifiedDate);

        // Calculate days since
        deal.daysSince = calculateDaysSince(deal.modifiedDate);
        deal.urgency = getUrgencyLevel(deal.daysSince);

        // Closing date awareness
        deal.daysUntilClosing = calculateDaysUntilClosing(deal.closingDate);
        deal.closingStatus = getClosingStatus(deal.daysUntilClosing);

        // Strip HTML from notes
        deal.noteContent = stripHTML(deal.noteContent);

        return deal;
    }

    function parseACV(value) {
        if (!value || typeof value !== 'string') {
            return { value: 0, isCAD: true }; // Assume CAD if no currency specified
        }

        const cleanValue = value.trim().toUpperCase();

        // Check for currency prefixes
        const isUSD = cleanValue.includes('USD') || cleanValue.startsWith('US$');
        const isEUR = cleanValue.includes('EUR') || cleanValue.startsWith('€');
        const isCAD = cleanValue.includes('CAD') || (!isUSD && !isEUR);

        // Extract numeric value
        const numericString = cleanValue.replace(/[^0-9.-]/g, '');
        const numericValue = parseFloat(numericString) || 0;

        return { value: numericValue, isCAD };
    }

    function parseDate(dateStr) {
        if (!dateStr) return null;

        // Try parsing the date string
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) return null;

        // Return date only (strip time)
        return new Date(date.getFullYear(), date.getMonth(), date.getDate());
    }

    function calculateDaysSince(date) {
        if (!date) return 999; // High number for unknown dates

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const diffTime = today - date;
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

        return Math.max(0, diffDays);
    }

    function getUrgencyLevel(days) {
        if (days <= URGENCY_THRESHOLDS.fresh) return 'fresh';
        if (days <= URGENCY_THRESHOLDS.warning) return 'warning';
        if (days <= URGENCY_THRESHOLDS.stale) return 'stale';
        return 'critical';
    }

    function calculateDaysUntilClosing(date) {
        if (!date) return null;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const diffTime = date - today;
        return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    }

    function getClosingStatus(daysUntil) {
        if (daysUntil === null) return null;
        if (daysUntil < 0) return 'overdue';
        if (daysUntil <= CLOSING_SOON_DAYS) return 'soon';
        return 'normal';
    }

    function stripHTML(html) {
        if (!html) return '';
        // Create a temporary element to parse HTML
        const temp = document.createElement('div');
        temp.innerHTML = html;
        return temp.textContent || temp.innerText || '';
    }

    function validateRow(deal) {
        if (!deal) return false;

        // Check Deal Owner format - should be a name, not a sentence
        const owner = deal.dealOwner || '';
        if (!owner || owner.length > 100 || owner.split(' ').length > 5) {
            return false;
        }

        // Check Deal Name exists
        if (!deal.dealName || deal.dealName.trim().length === 0) {
            return false;
        }

        return true;
    }

    function deduplicateDeals(deals) {
        const dealMap = new Map();

        for (const deal of deals) {
            const key = deal.dealName.toLowerCase().trim();
            const existing = dealMap.get(key);

            if (!existing) {
                dealMap.set(key, deal);
            } else {
                // Keep the one with newer modified date
                if (deal.modifiedDate && existing.modifiedDate) {
                    if (deal.modifiedDate > existing.modifiedDate) {
                        dealMap.set(key, deal);
                    }
                } else if (deal.modifiedDate) {
                    dealMap.set(key, deal);
                }
            }
        }

        return Array.from(dealMap.values());
    }

    // ==================== Diff ====================
    function diffDeals(oldDeals, newDeals) {
        // Build lookup from old deals
        const oldMap = new Map();
        for (const deal of oldDeals) {
            oldMap.set(deal.dealName.toLowerCase().trim(), deal);
        }

        let newCount = 0;
        let updatedCount = 0;
        let unchangedCount = 0;

        // Tag each new deal
        const newKeys = new Set();
        for (const deal of newDeals) {
            const key = deal.dealName.toLowerCase().trim();
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
                if ((deal.noteContent || '') !== (old.noteContent || '')) {
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
            noteContent: row.note_content || ''
        };
    }

    async function loadUploadById(uploadId) {
        const rawDeals = await fetchDealsByUploadId(uploadId);
        return rawDeals.map(supabaseRowToInternal);
    }

    async function handleDateSelection() {
        const primaryId = elements.dateSelectPrimary.value;
        const compareId = elements.dateSelectCompare.value;

        if (!primaryId) return;

        showLoading();
        try {
            const primaryDeals = await loadUploadById(primaryId);

            if (compareId) {
                const compareDeals = await loadUploadById(compareId);
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
            console.error('Error loading upload:', e);
            alert('Error loading data from Supabase.');
        } finally {
            hideLoading();
        }
    }

    // ==================== UI Rendering ====================
    function formatCurrency(value) {
        return new Intl.NumberFormat('en-CA', {
            style: 'currency',
            currency: 'CAD',
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
        }).format(value);
    }

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
        elements.ownerCards.innerHTML = owners.map(owner => `
            <div class="owner-card" data-owner="${escapeHTML(owner.name)}">
                <div class="owner-card__name">${escapeHTML(owner.name)}</div>
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
        `).join('');

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
                    ${deal.noteContent ? `<div class="note-tooltip">${escapeHTML(deal.noteContent)}</div>` : ''}
                </td>
            `;
            elements.tbody.appendChild(row);
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

    async function processCSVData(csvText, filename) {
        showLoading();
        try {
            // Parse CSV -- now returns { rows, generatedDate }
            const { rows: rawRows, generatedDate } = parseCSV(csvText);
            console.log(`Parsed ${rawRows.length} rows from CSV`);

            // Determine upload date
            const uploadDate = generatedDate
                ? generatedDate.toISOString().slice(0, 10)
                : new Date().toISOString().slice(0, 10);

            console.log('Upload date:', uploadDate);

            // Process rows
            let processed = rawRows
                .map(processRow)
                .filter(deal => deal !== null)
                .filter(validateRow);

            console.log(`After processing and validation: ${processed.length} deals`);

            // Deduplicate
            processed = deduplicateDeals(processed);
            console.log(`After deduplication: ${processed.length} deals`);

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
        elements.dateSelectPrimary.addEventListener('change', handleDateSelection);
        elements.dateSelectCompare.addEventListener('change', () => {
            if (elements.dateSelectPrimary.value) {
                handleDateSelection();
            }
        });

        // Export CSV
        elements.exportBtn.addEventListener('click', exportToCSV);
    }

    // ==================== Initialization ====================
    async function init() {
        setupEventListeners();
        initSupabase();

        if (isOnline) {
            try {
                showLoading();
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

    // Start the application
    init();
})();
