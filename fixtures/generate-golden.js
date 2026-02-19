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
    const { webcrypto } = require('crypto');
    if (!webcrypto || !webcrypto.subtle) {
        throw new Error('Node.js 15+ required for WebCrypto support. Please upgrade Node.');
    }
    globalThis.crypto = webcrypto;
}

// ==================== Shared modules ====================
const { parseCSV, processRow, validateRow,
        deduplicateDeals } = require('../js/ingest.js');
const { computeDealHealthScore, buildContext: buildHealthContext } = require('../js/dealHealthScore.js');

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
            notes_summary_length: (d.notesSummary || '').length,
            health_score: d.healthScore != null ? d.healthScore : null
        }))
        .sort((a, b) => a.deal_key.localeCompare(b.deal_key));
}

// ==================== Main ====================

const FIXTURES = [
    '01_clean_small',
    '02_multiline_notes',
    '03_malformed_rows',
    '04_duplicate_deals',
    '05_large_mixed',
    '06_currency_edge_cases'
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
        const deduped = await deduplicateDeals(processed, [], async () => null);
        // Attach health scores
        const ctx = buildHealthContext(deduped);
        for (const deal of deduped) {
            const result = computeDealHealthScore(deal, ctx);
            deal.healthScore = result.score;
        }
        const snapshot = buildSnapshot(deduped);

        const outPath = path.join(expectedDir, `${name}.json`);
        fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n');

        console.log(`  OK    ${name}.csv → ${snapshot.length} deals → expected/${name}.json`);
        generated++;
    }

    console.log(`\nGenerated ${generated}/${total} golden files in fixtures/expected/`);
})();
