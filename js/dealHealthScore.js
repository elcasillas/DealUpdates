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

    // Constant benchmark: expected days a deal spends in each stage
    var STAGE_BENCHMARKS = {
        'discovery': 14,
        'qualification': 21,
        'proposal': 21,
        'negotiation': 28,
        'verbal commit': 14
    };

    var MS_PER_DAY = 86400000;

    // ==================== Component Scoring Functions ====================

    function scoreStageProbability(stage, stageScoreMap) {
        if (!stage) return 35;
        const map = stageScoreMap || DEFAULT_STAGE_SCORES;
        const key = stage.trim().toLowerCase();
        return (key in map) ? map[key] : 35;
    }

    function scoreVelocity(daysInStage, benchmarkDays) {
        if (daysInStage == null || benchmarkDays == null || benchmarkDays <= 0) return 70;
        var ratio = daysInStage / benchmarkDays;
        if (ratio <= 0.8) return 100;
        if (ratio <= 1.2) return 70;
        if (ratio <= 1.5) return 40;
        return 10;
    }

    function scoreActivityRecency(lastActivityDaysSince) {
        if (lastActivityDaysSince == null || isNaN(lastActivityDaysSince) || lastActivityDaysSince >= 999) return 40;
        if (lastActivityDaysSince <= 7) return 100;
        if (lastActivityDaysSince <= 14) return 70;
        if (lastActivityDaysSince <= 30) return 40;
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

    function scoreNotesSignal(noteContent, notesCanonical, posKw, negKw) {
        var text = ((noteContent || '') + ' ' + (notesCanonical || '')).toLowerCase();
        var score = 50;
        var positiveMatched = [];
        var negativeMatched = [];
        var posWords = posKw || POSITIVE_KEYWORDS;
        var negWords = negKw || NEGATIVE_KEYWORDS;

        for (var i = 0; i < posWords.length; i++) {
            if (text.indexOf(posWords[i].toLowerCase()) !== -1) {
                positiveMatched.push(posWords[i]);
                score += 10;
            }
        }
        for (var i = 0; i < negWords.length; i++) {
            if (text.indexOf(negWords[i].toLowerCase()) !== -1) {
                negativeMatched.push(negWords[i]);
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

    function buildContext(deals, options) {
        var now = (options && options.now) ? options.now : Date.now();

        if (!deals || deals.length === 0) {
            return { now: now, acvDistribution: [], stageBenchmarks: STAGE_BENCHMARKS };
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

        // Dataset median days-in-stage by stage (approximated from daysSince)
        var stageGroups = {};
        for (var i = 0; i < deals.length; i++) {
            var stage = (deals[i].stage || '').trim().toLowerCase();
            if (!stage) continue;
            var ds = deals[i].daysSince;
            if (ds == null || isNaN(ds) || ds >= 999) continue;
            if (!stageGroups[stage]) stageGroups[stage] = [];
            stageGroups[stage].push(ds);
        }

        // Start with constant benchmarks, overlay dataset medians where available
        var stageBenchmarks = {};
        var k;
        for (k in STAGE_BENCHMARKS) {
            stageBenchmarks[k] = STAGE_BENCHMARKS[k];
        }
        var stageKeys = Object.keys(stageGroups);
        for (var i = 0; i < stageKeys.length; i++) {
            var vals = stageGroups[stageKeys[i]].sort(function(a, b) { return a - b; });
            if (vals.length >= 3) {
                // Only override constant if we have enough data
                var mid = Math.floor(vals.length / 2);
                stageBenchmarks[stageKeys[i]] = (vals.length % 2 === 0)
                    ? (vals[mid - 1] + vals[mid]) / 2
                    : vals[mid];
            }
        }

        return {
            now: now,
            acvDistribution: acvValues,
            stageBenchmarks: stageBenchmarks
        };
    }

    // ==================== Per-Deal Metric Derivation ====================

    function deriveDealMetrics(deal, ctx) {
        var now = ctx.now || Date.now();

        // Last activity date: max of modifiedDate (which is "Modified Time (Notes)")
        // In the current data model these are the same field; this picks the
        // most recent date available per deal to be forward-compatible.
        var lastActivityDate = null;
        if (deal.modifiedDate) {
            lastActivityDate = deal.modifiedDate instanceof Date
                ? deal.modifiedDate : new Date(deal.modifiedDate);
        }

        var lastActivityDaysSince;
        if (lastActivityDate && !isNaN(lastActivityDate.getTime())) {
            var todayMidnight = new Date(now);
            todayMidnight.setHours(0, 0, 0, 0);
            lastActivityDaysSince = Math.max(0, Math.floor((todayMidnight - lastActivityDate) / MS_PER_DAY));
        } else {
            lastActivityDaysSince = 999;
        }

        // Days in stage: approximate from earliest record at current stage.
        // After dedup we have one record per deal, so we fall back to daysSince
        // as the best proxy (time since last modification while in this stage).
        var daysInStage = null;
        if (typeof deal.daysInStage === 'number') {
            daysInStage = deal.daysInStage; // pre-computed upstream
        } else if (typeof deal.daysSince === 'number' && deal.daysSince < 999) {
            daysInStage = deal.daysSince; // best available approximation
        }

        var stage = (deal.stage || '').trim().toLowerCase();
        var benchmark = (ctx.stageBenchmarks || STAGE_BENCHMARKS)[stage] || null;

        return {
            lastActivityDate: lastActivityDate,
            lastActivityDaysSince: lastActivityDaysSince,
            daysInStage: daysInStage,
            stageBenchmark: benchmark
        };
    }

    // ==================== Main Scoring Function ====================

    function computeDealHealthScore(deal, context, config) {
        var weights = (config && config.weights) || defaultWeights();
        var stageScoreMap = (config && config.stageScoreMap) || DEFAULT_STAGE_SCORES;
        var ctx = context || { now: Date.now(), acvDistribution: [], stageBenchmarks: STAGE_BENCHMARKS };

        // Derive per-deal metrics
        var metrics = deriveDealMetrics(deal, ctx);

        // Compute each component
        var stageProbability = scoreStageProbability(deal.stage, stageScoreMap);
        var velocity = scoreVelocity(metrics.daysInStage, metrics.stageBenchmark);
        var activityRecency = scoreActivityRecency(metrics.lastActivityDaysSince);
        var closeDateIntegrity = scoreCloseDateIntegrity(deal);
        var acvScore = scoreAcv(deal.acv, ctx.acvDistribution);
        var posKw = (config && config.positiveKeywords) || null;
        var negKw = (config && config.negativeKeywords) || null;
        var notesResult = scoreNotesSignal(deal.noteContent, deal.notesCanonical, posKw, negKw);

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
        var velocityRatio = (metrics.stageBenchmark && metrics.daysInStage != null)
            ? metrics.daysInStage / metrics.stageBenchmark : null;

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
                lastActivityDaysSince: metrics.lastActivityDaysSince,
                daysInStage: metrics.daysInStage,
                stageBenchmark: metrics.stageBenchmark,
                velocityRatio: velocityRatio,
                acvPercentile: acvPercentile,
                notesKeywordsMatched: {
                    positive: notesResult.positive,
                    negative: notesResult.negative
                }
            }
        };
    }

    // ==================== Exports ====================
    exports.defaultWeights = defaultWeights;
    exports.computeDealHealthScore = computeDealHealthScore;
    exports.buildContext = buildContext;
    exports.deriveDealMetrics = deriveDealMetrics;
    exports.scoreStageProbability = scoreStageProbability;
    exports.scoreVelocity = scoreVelocity;
    exports.scoreActivityRecency = scoreActivityRecency;
    exports.scoreCloseDateIntegrity = scoreCloseDateIntegrity;
    exports.scoreAcv = scoreAcv;
    exports.scoreNotesSignal = scoreNotesSignal;
    exports.DEFAULT_STAGE_SCORES = DEFAULT_STAGE_SCORES;
    exports.STAGE_BENCHMARKS = STAGE_BENCHMARKS;
    exports.POSITIVE_KEYWORDS = POSITIVE_KEYWORDS;
    exports.NEGATIVE_KEYWORDS = NEGATIVE_KEYWORDS;

})(typeof module !== 'undefined' && module.exports
    ? module.exports
    : (self.DealHealthScore = {}));
