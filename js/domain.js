// DealUpdates - Pure domain functions
// Shared by app.js (browser) and generate-golden.js (Node.js)

(function(exports) {
    'use strict';

    // ==================== Configuration ====================
    const URGENCY_THRESHOLDS = {
        fresh: 14,
        warning: 30,
        stale: 60
    };
    const CLOSING_SOON_DAYS = 14;

    // ==================== Identity ====================
    function normalizeString(s) {
        return (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    }

    function makeDealKey(dealName, dealOwner) {
        return normalizeString(dealName) + '||' + normalizeString(dealOwner);
    }

    // ==================== Hashing ====================
    async function sha256Hex(str) {
        const data = new TextEncoder().encode(str);
        const buf = await crypto.subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // ==================== Notes ====================
    function buildNotesCanonical(rawNotes) {
        const unique = [...new Set(rawNotes.map(n => n.trim()).filter(Boolean))].sort();
        return { canonical: unique.join('\n---\n'), count: unique.length };
    }

    // ==================== ACV Parsing ====================
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

    // ==================== Date Helpers ====================
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

    function calculateDaysUntilClosing(date) {
        if (!date) return null;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const diffTime = date - today;
        return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    }

    // ==================== Urgency / Closing Status ====================
    function getUrgencyLevel(days) {
        if (days <= URGENCY_THRESHOLDS.fresh) return 'fresh';
        if (days <= URGENCY_THRESHOLDS.warning) return 'warning';
        if (days <= URGENCY_THRESHOLDS.stale) return 'stale';
        return 'critical';
    }

    function getClosingStatus(daysUntil) {
        if (daysUntil === null) return null;
        if (daysUntil < 0) return 'overdue';
        if (daysUntil <= CLOSING_SOON_DAYS) return 'soon';
        return 'normal';
    }

    // ==================== Exports ====================
    exports.URGENCY_THRESHOLDS = URGENCY_THRESHOLDS;
    exports.CLOSING_SOON_DAYS = CLOSING_SOON_DAYS;
    exports.normalizeString = normalizeString;
    exports.makeDealKey = makeDealKey;
    exports.sha256Hex = sha256Hex;
    exports.buildNotesCanonical = buildNotesCanonical;
    exports.parseACV = parseACV;
    exports.parseDate = parseDate;
    exports.calculateDaysSince = calculateDaysSince;
    exports.calculateDaysUntilClosing = calculateDaysUntilClosing;
    exports.getUrgencyLevel = getUrgencyLevel;
    exports.getClosingStatus = getClosingStatus;

})(typeof module !== 'undefined' && module.exports
    ? module.exports
    : (self.DealDomain = {}));
