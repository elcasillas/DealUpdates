#!/usr/bin/env node
/**
 * Golden file generator for DealUpdates test harness.
 * Replicates the exact parsing pipeline from js/app.js.
 *
 * Usage: node fixtures/generate-golden.js
 *
 * Writes JSON snapshots to fixtures/expected/<fixture>.json
 */

const fs = require('fs');
const path = require('path');

// Ensure Web Crypto API is available for domain.js sha256Hex
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
    globalThis.crypto = require('crypto');
}

// ==================== Shared domain functions ====================
const { normalizeString, makeDealKey, sha256Hex, buildNotesCanonical,
        parseACV, parseDate } = require('../js/domain.js');

// ==================== Local functions (app-specific / DOM-dependent) ====================

const COLUMN_MAPPINGS = {
    'Deal Owner': 'dealOwner',
    'Deal Name': 'dealName',
    'Stage': 'stage',
    'Annual Contract Value': 'acv',
    'Closing Date': 'closingDate',
    'Modified Time (Notes)': 'modifiedDate',
    'Note Content': 'noteContent',
    'Description': 'description'
};

function parseCSVText(text) {
    const rows = [];
    let currentRow = [];
    let currentField = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const nextChar = text[i + 1];

        if (inQuotes) {
            if (char === '"') {
                if (nextChar === '"') {
                    currentField += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                currentField += char;
            }
        } else {
            if (char === '"') {
                inQuotes = true;
            } else if (char === ',') {
                currentRow.push(currentField);
                currentField = '';
            } else if (char === '\r') {
                if (nextChar === '\n') i++;
                currentRow.push(currentField);
                rows.push(currentRow);
                currentRow = [];
                currentField = '';
            } else if (char === '\n') {
                currentRow.push(currentField);
                rows.push(currentRow);
                currentRow = [];
                currentField = '';
            } else {
                currentField += char;
            }
        }
    }

    if (currentField || currentRow.length > 0) {
        currentRow.push(currentField);
        rows.push(currentRow);
    }

    return rows;
}

function parseCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) {
        text = text.slice(1);
    }

    const allRows = parseCSVText(text);
    if (allRows.length === 0) throw new Error('No data found in CSV file.');

    let headerRowIndex = -1;
    let headers = [];

    for (let i = 0; i < Math.min(allRows.length, 20); i++) {
        const row = allRows[i];
        if (row.includes('Deal Owner') && row.includes('Deal Name')) {
            headerRowIndex = i;
            headers = row;
            break;
        }
    }

    if (headerRowIndex === -1) {
        throw new Error('Could not find header row.');
    }

    const expectedColumns = headers.length;
    const rows = [];
    for (let i = headerRowIndex + 1; i < allRows.length; i++) {
        const values = allRows[i];
        if (values.length === 0 || (values.length === 1 && !values[0])) continue;
        const row = {};
        headers.forEach((header, index) => {
            row[header] = values[index] || '';
        });
        rows.push(row);
    }

    return { rows };
}

// Minimal HTML stripping for Node.js (matches browser's textContent behavior)
function stripHTML(html) {
    if (!html) return '';
    // Remove HTML tags (replicates browser's temp.textContent behavior)
    return html.replace(/<[^>]*>/g, '');
}

function validateRow(deal) {
    if (!deal) return false;
    const owner = deal.dealOwner || '';
    if (!owner || owner.length > 100 || owner.split(' ').length > 5) return false;
    if (!deal.dealName || deal.dealName.trim().length === 0) return false;
    return true;
}

function processRow(row) {
    const deal = {};
    for (const [csvCol, internalField] of Object.entries(COLUMN_MAPPINGS)) {
        deal[internalField] = row[csvCol] || '';
    }

    const acvResult = parseACV(deal.acv);
    if (!acvResult.isCAD) return null;
    deal.acv = acvResult.value;

    deal.closingDate = parseDate(deal.closingDate);
    deal.modifiedDate = parseDate(deal.modifiedDate);

    // daysSince and urgency are date-dependent, not included in golden snapshot
    deal.noteContent = stripHTML(deal.noteContent);

    deal.dealKey = makeDealKey(deal.dealName, deal.dealOwner);

    return deal;
}

function generateFallbackSummary(notes) {
    const unique = [...new Set(notes)];
    if (unique.length === 0) return '';
    const sentences = unique.map(note => {
        const match = note.match(/^(.+?[.!?])\s/);
        if (match && match[1].length <= 150) return match[1];
        return note.length > 150 ? note.slice(0, 147) + '...' : note;
    });
    let summary = sentences.join(' | ');
    if (summary.length > 500) summary = summary.slice(0, 497) + '...';
    return summary;
}

async function deduplicateDeals(deals) {
    const dealMap = new Map();
    const notesMap = new Map();

    for (const deal of deals) {
        const key = deal.dealKey;
        const existing = dealMap.get(key);

        if (!notesMap.has(key)) notesMap.set(key, []);
        if (deal.noteContent && deal.noteContent.trim()) {
            notesMap.get(key).push(deal.noteContent.trim());
        }

        if (!existing) {
            dealMap.set(key, deal);
        } else {
            if (deal.modifiedDate && existing.modifiedDate) {
                if (deal.modifiedDate > existing.modifiedDate) dealMap.set(key, deal);
            } else if (deal.modifiedDate) {
                dealMap.set(key, deal);
            }
        }
    }

    const result = Array.from(dealMap.values());

    // Generate canonical notes, hash, fallback summaries (no AI in test/Node context)
    for (const deal of result) {
        const rawNotes = notesMap.get(deal.dealKey) || [];
        const { canonical, count } = buildNotesCanonical(rawNotes);
        deal.notesCanonical = canonical;
        deal.notesCount = count;
        deal.notesHash = await sha256Hex(canonical);
        deal.notesSummary = generateFallbackSummary(rawNotes);
        deal.summaryHash = deal.notesHash;
    }

    return result;
}

// ==================== Snapshot building ====================

function buildSnapshot(deals) {
    return deals
        .map(d => ({
            deal_key: d.dealKey,
            deal_owner: d.dealOwner,
            stage: d.stage,
            acv: d.acv,
            closing_date: d.closingDate ? d.closingDate.toISOString().slice(0, 10) : null,
            modified_date: d.modifiedDate ? d.modifiedDate.toISOString().slice(0, 10) : null,
            notes_count: d.notesCount,
            notes_hash: d.notesHash,
            notes_summary_length: (d.notesSummary || '').length
        }))
        .sort((a, b) => a.deal_key.localeCompare(b.deal_key));
}

// ==================== Main ====================

const FIXTURES = [
    '01_clean_small',
    '02_multiline_notes',
    '03_malformed_rows',
    '04_duplicate_deals',
    '05_large_mixed'
];

(async function main() {
    const fixturesDir = path.join(__dirname);
    const expectedDir = path.join(fixturesDir, 'expected');

    if (!fs.existsSync(expectedDir)) {
        fs.mkdirSync(expectedDir, { recursive: true });
    }

    let total = 0;
    let generated = 0;

    for (const name of FIXTURES) {
        total++;
        const csvPath = path.join(fixturesDir, `${name}.csv`);
        if (!fs.existsSync(csvPath)) {
            console.error(`  SKIP  ${name}.csv (not found)`);
            continue;
        }

        const csvText = fs.readFileSync(csvPath, 'utf-8');
        const { rows: rawRows } = parseCSV(csvText);
        const processed = rawRows.map(processRow).filter(d => d !== null).filter(validateRow);
        const deduped = await deduplicateDeals(processed);
        const snapshot = buildSnapshot(deduped);

        const outPath = path.join(expectedDir, `${name}.json`);
        fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n');

        console.log(`  OK    ${name}.csv → ${snapshot.length} deals → expected/${name}.json`);
        generated++;
    }

    console.log(`\nGenerated ${generated}/${total} golden files in fixtures/expected/`);
})();
