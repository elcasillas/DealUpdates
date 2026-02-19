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
    // Parsing rules:
    //   Currency detection (case-insensitive, checked in order):
    //     USD  — contains "USD", starts with "US$"
    //     EUR  — contains "EUR", starts with "€"
    //     CAD  — contains "CAD", "CA$", "C$"
    //     bare "$" with no other marker → treated as CAD (our default)
    //     no input / empty → { value: 0, currency: "CAD", isCAD: true }
    //   Numeric extraction:
    //     strips currency symbols, letters, spaces
    //     handles thousand separators: commas (1,234) and spaces (1 234)
    //     handles parenthesised negatives: ($1,234) → -1234
    //     returns 0 for unparseable values
    function parseACV(value) {
        if (!value || typeof value !== 'string') {
            return { value: 0, currency: 'CAD', isCAD: true, raw: value ?? '' };
        }

        const raw = value;
        const upper = value.trim().toUpperCase();

        // Detect currency
        let currency;
        if (upper.includes('USD') || /^US\$/.test(upper)) {
            currency = 'USD';
        } else if (upper.includes('EUR') || /^€/.test(upper.replace(/\s/g, ''))) {
            currency = 'EUR';
        } else if (upper.includes('CAD') || /CA\$|C\$/.test(upper)) {
            currency = 'CAD';
        } else {
            // Bare "$" or plain number — treat as CAD (our CRM default)
            currency = 'CAD';
        }

        const isCAD = currency === 'CAD';

        // Detect parenthesised negative: ($1,234.56) or (1234)
        const isNegative = /\(.*\)/.test(upper);

        // Strip everything except digits, dots, and minus signs
        let numeric = upper.replace(/[^0-9.,-]/g, '');

        // Disambiguate commas vs dots as decimal/thousand separators:
        //   Multiple commas → all are thousand separators (e.g. 1,234,567)
        //   One comma after last dot, ≤2 digits after → European decimal (e.g. 12.345,67)
        //   One comma, no dot, ≤2 digits after → European decimal (e.g. 1234,56)
        //   Otherwise commas are thousands (e.g. 1,234)
        if (numeric.includes(',')) {
            const commaCount = (numeric.match(/,/g) || []).length;
            const lastComma = numeric.lastIndexOf(',');
            const digitsAfterComma = numeric.length - lastComma - 1;

            if (commaCount === 1 && digitsAfterComma <= 2 && lastComma > numeric.lastIndexOf('.')) {
                // Single comma is decimal separator — strip dots, replace comma
                numeric = numeric.replace(/\./g, '').replace(',', '.');
            } else {
                // Commas are thousand separators — strip them
                numeric = numeric.replace(/,/g, '');
            }
        }

        let amount = parseFloat(numeric) || 0;
        if (isNegative && amount > 0) amount = -amount;

        return { value: amount, currency, isCAD, raw };
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

    function calculateDaysSince(date, referenceDate) {
        if (!date) return 999; // High number for unknown dates

        const today = referenceDate ? new Date(referenceDate) : new Date();
        today.setHours(0, 0, 0, 0);

        const diffTime = today - date;
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

        return Math.max(0, diffDays);
    }

    function calculateDaysUntilClosing(date, referenceDate) {
        if (!date) return null;
        const today = referenceDate ? new Date(referenceDate) : new Date();
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

    function getHealthLevel(score) {
        if (score >= 80) return 'good';
        if (score >= 60) return 'watch';
        if (score >= 40) return 'risk';
        return 'dead';
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
    exports.getHealthLevel = getHealthLevel;

})(typeof module !== 'undefined' && module.exports
    ? module.exports
    : (self.DealDomain = {}));
