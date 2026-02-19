// DealUpdates - Deal Health Score module
// Computes a composite health score (0-100) per deal from 6 weighted components.
// Shared by app.js (browser) and generate-golden.js (Node.js) via UMD.

(function(exports) {
    'use strict';

    // ==================== Default Configuration ====================

    function defaultWeights() {
        return {
            stageProbability: 25,
            velocity: 20,
            activityRecency: 15,
            closeDateIntegrity: 10,
            acv: 15,
            notesSignal: 15
        };
    }

    const DEFAULT_STAGE_SCORES = {
        'discovery': 20,
        'qualification': 35,
        'proposal': 55,
        'negotiation': 75,
        'verbal commit': 90
    };

    const POSITIVE_KEYWORDS = [
        'budget confirmed',
        'legal engaged',
        'exec sponsor',
        'timeline committed',
        'verbal commit',
        'procurement'
    ];

    const NEGATIVE_KEYWORDS = [
        'no response',
        'circling back',
        'waiting on approval',
        'reviewing internally',
        'pushed',
        'delayed',
        'stalled'
    ];

    const PUSH_SIGNALS = ['pushed', 'delayed', 'moved out', 'rescheduled'];

    // ==================== Component Scoring Functions ====================

    function scoreStageProbability(stage, stageScoreMap) {
        if (!stage) return 35;
        const map = stageScoreMap || DEFAULT_STAGE_SCORES;
        const key = stage.trim().toLowerCase();
        return (key in map) ? map[key] : 35;
    }

    function scoreVelocity(deal, medianDaysInStage) {
        if (!deal || !medianDaysInStage) return 70;

        const stage = (deal.stage || '').trim().toLowerCase();
        const benchmark = medianDaysInStage[stage];

        if (!benchmark || benchmark <= 0) return 70;

        const daysSince = (typeof deal.daysSince === 'number' && !isNaN(deal.daysSince))
            ? deal.daysSince : 0;
        const ratio = daysSince / benchmark;

        if (ratio <= 0.8) return 100;
        if (ratio <= 1.2) return 70;
        if (ratio <= 1.5) return 40;
        return 10;
    }

    function scoreActivityRecency(daysSince) {
        if (daysSince == null || isNaN(daysSince) || daysSince >= 999) return 40;
        if (daysSince <= 7) return 100;
        if (daysSince <= 14) return 70;
        if (daysSince <= 30) return 40;
        return 10;
    }

    function scoreCloseDateIntegrity(deal) {
        if (!deal) return 60;

        var base;
        var daysUntil = deal.daysUntilClosing;

        if (daysUntil == null) {
            base = 60;
        } else if (daysUntil < 0) {
            // Past due and not closed won
            var stageLower = (deal.stage || '').trim().toLowerCase();
            if (stageLower === 'closed won') {
                base = 100;
            } else {
                base = 10;
            }
        } else if (daysUntil <= 30) {
            base = 70;
        } else {
            base = 100;
        }

        // Scan notes for push signals
        var text = ((deal.notesCanonical || '') + ' ' + (deal.noteContent || '')).toLowerCase();
        var pushCount = 0;
        for (var i = 0; i < PUSH_SIGNALS.length; i++) {
            if (text.indexOf(PUSH_SIGNALS[i]) !== -1) {
                pushCount++;
            }
        }

        base -= pushCount * 20;
        return Math.max(10, Math.min(100, base));
    }

    function scoreAcv(acv, acvDistribution) {
        if (acv == null || isNaN(acv) || acv === 0) return 40;
        if (!acvDistribution || acvDistribution.length === 0) return 40;

        // Compute percentile rank
        var below = 0;
        for (var i = 0; i < acvDistribution.length; i++) {
            if (acvDistribution[i] < acv) below++;
        }
        var percentile = below / acvDistribution.length;

        // Top 20% => 100, 20-60% => 70, bottom 40% => 40
        if (percentile >= 0.8) return 100;
        if (percentile >= 0.4) return 70;
        return 40;
    }

    function scoreNotesSignal(noteContent, notesCanonical) {
        var text = ((noteContent || '') + ' ' + (notesCanonical || '')).toLowerCase();
        var score = 50;
        var positiveMatched = [];
        var negativeMatched = [];

        for (var i = 0; i < POSITIVE_KEYWORDS.length; i++) {
            if (text.indexOf(POSITIVE_KEYWORDS[i]) !== -1) {
                positiveMatched.push(POSITIVE_KEYWORDS[i]);
                score += 10;
            }
        }
        for (var i = 0; i < NEGATIVE_KEYWORDS.length; i++) {
            if (text.indexOf(NEGATIVE_KEYWORDS[i]) !== -1) {
                negativeMatched.push(NEGATIVE_KEYWORDS[i]);
                score -= 10;
            }
        }

        return {
            score: Math.max(0, Math.min(100, score)),
            positive: positiveMatched,
            negative: negativeMatched
        };
    }

    // ==================== Context Building ====================

    function buildContext(deals) {
        if (!deals || deals.length === 0) {
            return { acvDistribution: [], medianDaysInStage: {} };
        }

        // ACV distribution: sorted array of all non-zero ACV values
        var acvValues = [];
        for (var i = 0; i < deals.length; i++) {
            var acv = deals[i].acv;
            if (acv != null && !isNaN(acv) && acv > 0) {
                acvValues.push(acv);
            }
        }
        acvValues.sort(function(a, b) { return a - b; });

        // Median days-in-stage by stage (approximated from daysSince)
        var stageGroups = {};
        for (var i = 0; i < deals.length; i++) {
            var stage = (deals[i].stage || '').trim().toLowerCase();
            if (!stage) continue;
            var ds = deals[i].daysSince;
            if (ds == null || isNaN(ds) || ds >= 999) continue;
            if (!stageGroups[stage]) stageGroups[stage] = [];
            stageGroups[stage].push(ds);
        }

        var medianDaysInStage = {};
        var stages = Object.keys(stageGroups);
        for (var i = 0; i < stages.length; i++) {
            var vals = stageGroups[stages[i]].sort(function(a, b) { return a - b; });
            var mid = Math.floor(vals.length / 2);
            medianDaysInStage[stages[i]] = (vals.length % 2 === 0)
                ? (vals[mid - 1] + vals[mid]) / 2
                : vals[mid];
        }

        return {
            acvDistribution: acvValues,
            medianDaysInStage: medianDaysInStage
        };
    }

    // ==================== Main Scoring Function ====================

    function computeDealHealthScore(deal, context, config) {
        var weights = (config && config.weights) || defaultWeights();
        var stageScoreMap = (config && config.stageScoreMap) || DEFAULT_STAGE_SCORES;
        var ctx = context || { acvDistribution: [], medianDaysInStage: {} };

        // Compute each component
        var stageProbability = scoreStageProbability(deal.stage, stageScoreMap);
        var velocity = scoreVelocity(deal, ctx.medianDaysInStage);
        var activityRecency = scoreActivityRecency(deal.daysSince);
        var closeDateIntegrity = scoreCloseDateIntegrity(deal);
        var acvScore = scoreAcv(deal.acv, ctx.acvDistribution);
        var notesResult = scoreNotesSignal(deal.noteContent, deal.notesCanonical);

        var components = {
            stageProbability: stageProbability,
            velocity: velocity,
            activityRecency: activityRecency,
            closeDateIntegrity: closeDateIntegrity,
            acv: acvScore,
            notesSignal: notesResult.score
        };

        // Weighted sum
        var totalWeight = 0;
        var weightedSum = 0;
        var keys = Object.keys(weights);
        for (var i = 0; i < keys.length; i++) {
            var w = weights[keys[i]] || 0;
            var c = components[keys[i]] || 0;
            weightedSum += w * c;
            totalWeight += w;
        }

        var score = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
        score = Math.max(0, Math.min(100, score));

        // Velocity ratio for debug
        var stage = (deal.stage || '').trim().toLowerCase();
        var benchmark = ctx.medianDaysInStage[stage];
        var velocityRatio = (benchmark && benchmark > 0 && deal.daysSince != null)
            ? deal.daysSince / benchmark : null;

        // ACV percentile for debug
        var acvPercentile = null;
        if (deal.acv > 0 && ctx.acvDistribution.length > 0) {
            var below = 0;
            for (var j = 0; j < ctx.acvDistribution.length; j++) {
                if (ctx.acvDistribution[j] < deal.acv) below++;
            }
            acvPercentile = Math.round((below / ctx.acvDistribution.length) * 100);
        }

        return {
            score: score,
            components: components,
            debug: {
                notesKeywordsMatched: {
                    positive: notesResult.positive,
                    negative: notesResult.negative
                },
                velocityRatio: velocityRatio,
                acvPercentile: acvPercentile,
                velocityBenchmark: benchmark || null
            }
        };
    }

    // ==================== Exports ====================
    exports.defaultWeights = defaultWeights;
    exports.computeDealHealthScore = computeDealHealthScore;
    exports.buildContext = buildContext;
    exports.scoreStageProbability = scoreStageProbability;
    exports.scoreVelocity = scoreVelocity;
    exports.scoreActivityRecency = scoreActivityRecency;
    exports.scoreCloseDateIntegrity = scoreCloseDateIntegrity;
    exports.scoreAcv = scoreAcv;
    exports.scoreNotesSignal = scoreNotesSignal;
    exports.DEFAULT_STAGE_SCORES = DEFAULT_STAGE_SCORES;
    exports.POSITIVE_KEYWORDS = POSITIVE_KEYWORDS;
    exports.NEGATIVE_KEYWORDS = NEGATIVE_KEYWORDS;

})(typeof module !== 'undefined' && module.exports
    ? module.exports
    : (self.DealHealthScore = {}));
