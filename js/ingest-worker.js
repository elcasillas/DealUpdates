// DealUpdates - Web Worker for CSV ingest pipeline
// Offloads parsing, processing, validation, and deduplication from the main thread.
'use strict';

importScripts('domain.js', 'ingest.js');

const { parseCSV, processRow, validateRow, deduplicateDeals } = self.DealIngest;

self.onmessage = async function(e) {
    try {
        const { csvText, existingDeals } = e.data;

        // Phase 1: Parse CSV
        postMessage({ type: 'progress', phase: 'Parsing CSV...' });
        const { rows: rawRows, generatedDate } = parseCSV(csvText);

        // Phase 2: Process + validate rows with progress
        const processed = [];
        for (let i = 0; i < rawRows.length; i++) {
            const deal = processRow(rawRows[i]);
            if (deal !== null && validateRow(deal)) {
                processed.push(deal);
            }
            if ((i + 1) % 200 === 0 || i === rawRows.length - 1) {
                postMessage({
                    type: 'progress',
                    phase: `Processing rows... ${i + 1}/${rawRows.length}`
                });
            }
        }

        // Phase 3: Deduplicate and compute hashes (no AI in worker)
        postMessage({ type: 'progress', phase: `Deduplicating ${processed.length} deals...` });
        const deduped = await deduplicateDeals(processed, existingDeals || [], async () => null);

        // Return result
        postMessage({
            type: 'complete',
            deals: deduped,
            generatedDate: generatedDate ? generatedDate.toISOString() : null
        });
    } catch (err) {
        postMessage({ type: 'error', message: err.message });
    }
};
