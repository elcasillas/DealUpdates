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

    // ==================== State ====================
    let allDeals = [];
    let filteredDeals = [];
    let currentSort = { column: 'daysSince', direction: 'desc' };

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
        clearBtn: document.getElementById('clear-data-btn'),
        statTotal: document.getElementById('stat-total'),
        statAcv: document.getElementById('stat-acv'),
        statAvgDays: document.getElementById('stat-avg-days'),
        statStale: document.getElementById('stat-stale'),
        ownerCards: document.getElementById('owner-cards')
    };

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

        // Find header row by looking for "Deal Owner" and "Deal Name"
        let headerRowIndex = -1;
        let headers = [];

        for (let i = 0; i < Math.min(allRows.length, 20); i++) {
            const row = allRows[i];
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
        return rows;
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

    // ==================== Storage ====================
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
                return deals.map(deal => ({
                    ...deal,
                    closingDate: deal.closingDate ? new Date(deal.closingDate) : null,
                    modifiedDate: deal.modifiedDate ? new Date(deal.modifiedDate) : null,
                    daysSince: calculateDaysSince(deal.modifiedDate ? new Date(deal.modifiedDate) : null),
                    urgency: getUrgencyLevel(calculateDaysSince(deal.modifiedDate ? new Date(deal.modifiedDate) : null))
                }));
            }
        } catch (e) {
            console.error('Failed to load from localStorage:', e);
        }
        return null;
    }

    function clearStorage() {
        localStorage.removeItem(STORAGE_KEY);
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

        elements.statTotal.textContent = totalDeals.toLocaleString();
        elements.statAcv.textContent = formatCurrency(totalACV);
        elements.statAvgDays.textContent = avgDays;
        elements.statStale.textContent = staleDeals;

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
                    totalDays: 0
                };
            }
            ownerStats[owner].deals++;
            ownerStats[owner].totalACV += deal.acv || 0;
            ownerStats[owner].totalDays += deal.daysSince || 0;
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
            <div class="owner-card">
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
                </div>
            </div>
        `).join('');
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
            row.innerHTML = `
                <td>${escapeHTML(deal.dealOwner)}</td>
                <td>${escapeHTML(deal.dealName)}</td>
                <td>${escapeHTML(deal.stage)}</td>
                <td class="acv-value">${deal.acvFormatted}</td>
                <td class="date-value">${formatDate(deal.closingDate)}</td>
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

    function showDashboard() {
        elements.uploadZone.classList.add('hidden');
        elements.statsSection.classList.remove('hidden');
        elements.filtersSection.classList.remove('hidden');
        elements.tableSection.classList.remove('hidden');
    }

    function showUploadZone() {
        elements.uploadZone.classList.remove('hidden');
        elements.statsSection.classList.add('hidden');
        elements.filtersSection.classList.add('hidden');
        elements.tableSection.classList.add('hidden');
    }

    // ==================== Filtering & Sorting ====================
    function applyFilters() {
        const searchTerm = elements.searchInput.value.toLowerCase();
        const ownerFilter = elements.filterOwner.value;
        const stageFilter = elements.filterStage.value;
        const urgencyFilter = elements.filterUrgency.value;

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

            return true;
        });

        applySorting();
        renderTable(filteredDeals);
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
            try {
                processCSVData(e.target.result);
            } catch (error) {
                alert('Error processing CSV: ' + error.message);
                console.error(error);
            }
        };
        reader.readAsText(file);
    }

    function processCSVData(csvText) {
        // Parse CSV
        const rawRows = parseCSV(csvText);
        console.log(`Parsed ${rawRows.length} rows from CSV`);

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

        // Store and display
        allDeals = processed;
        filteredDeals = [...allDeals];

        saveToStorage(allDeals);
        populateFilterDropdowns(allDeals);
        renderStats(allDeals);
        applySorting();
        renderTable(filteredDeals);
        updateSortIndicators();
        showDashboard();
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

        // Sorting
        document.querySelectorAll('th[data-sort]').forEach(th => {
            th.addEventListener('click', () => handleSort(th.dataset.sort));
        });

        // Clear data
        elements.clearBtn.addEventListener('click', () => {
            if (confirm('Are you sure you want to clear all data?')) {
                clearStorage();
                allDeals = [];
                filteredDeals = [];
                elements.tbody.innerHTML = '';
                showUploadZone();
            }
        });
    }

    // ==================== Initialization ====================
    function init() {
        setupEventListeners();

        // Check for saved data
        const savedDeals = loadFromStorage();
        if (savedDeals && savedDeals.length > 0) {
            allDeals = savedDeals;
            filteredDeals = [...allDeals];
            populateFilterDropdowns(allDeals);
            renderStats(allDeals);
            applySorting();
            renderTable(filteredDeals);
            updateSortIndicators();
            showDashboard();
        }
    }

    // Start the application
    init();
})();
