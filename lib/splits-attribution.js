// ============================================================================
// lib/splits-attribution.js — empirical splits / handle-vs-tickets attribution
// ============================================================================
// Answers: "Do DK-reported money% vs tickets% divergences predict model pick
// outcomes?" with explicit sample-size gates and 95% CIs.
//
// Input: graded tracker entries that include `splitsSnapshot` at lock time.
// Conventions match public/index.html findAllDivergences().
// ============================================================================

const DEFAULT_MIN_N = 30;

const GLOSSARY = {
  tickets_pct: {
    term: 'Tickets % (Bets %)',
    technical:
      'Share of wager *count* on a side. A proxy for recreational participation; many small tickets inflate this.',
    plain:
      'How many individual bets (not dollars) are on this side. High tickets % often means the public crowd.',
    interpret:
      'Alone it does not prove sharp action. Compare to money % on the same side.'
  },
  money_pct: {
    term: 'Money % (Handle %)',
    technical:
      'Share of reported handle (stake dollars) on a side from the splits source (VSiN/DK feed).',
    plain:
      'What fraction of the *dollars* bet are on this side. Few large bets can dominate.',
    interpret:
      'When money % ≫ tickets % on a side, books are taking bigger bets there — often called "sharp" or pro lean.'
  },
  magnitude: {
    term: 'Magnitude (money − tickets gap)',
    technical:
      'On the qualifying sharp side: handle% − tickets% in percentage points. Requires money%>50 and money%>tickets on that side.',
    plain:
      'How much heavier the dollars are than the bet-count on the "sharp" side. Bigger = stronger split signal.',
    interpret:
      '4–6 = weak; 7–11 = moderate; 12–17 = strong (RLM threshold in app); 18+ = very strong.'
  },
  agrees_with_lock: {
    term: 'Agrees with Lock',
    technical:
      'Boolean: the splits sharp side (team or Over/Under) matches the model Lock side for that market.',
    plain:
      'The public money signal points the same way the model bet does.',
    interpret:
      'Agree + positive ROI suggests splits add confidence. Oppose + positive ROI suggests price edge beats crowd narrative.'
  },
  roi_pct: {
    term: 'ROI %',
    technical:
      '100 × (sum profit units) / (sum staked units) over graded picks in the slice.',
    plain:
      'Return on the model\'s unit stakes for that group.',
    interpret:
      'Positive ROI with n≥minN and CI excluding 0 is evidence the slice is profitable *in sample*. Not a guarantee forward.'
  },
  roi_ci95: {
    term: 'ROI 95% CI',
    technical:
      'Normal-approximation confidence interval on mean per-pick P/L, scaled to ROI%. Adequate for n≳30; flagged when n is small.',
    plain:
      'A range that likely contains the true long-run ROI for this group.',
    interpret:
      'If the interval crosses 0%, you cannot claim a real edge yet — even if ROI looks positive.'
  },
  win_pct: {
    term: 'Win %',
    technical:
      'Wins / (wins + losses), pushes excluded.',
    plain:
      'How often the pick won outright.',
    interpret:
      'Misleading at plus-money without ROI. Use with units P/L.'
  },
  avg_ev_pct: {
    term: 'Avg EV % (at lock)',
    technical:
      'Mean model-reported EV% at the time the Lock was first logged.',
    plain:
      'How big the model thought the edge was when it surfaced the play.',
    interpret:
      'If a splits slice wins but avg EV is low, splits may be doing the work. If EV is high but slice loses, splits may be noise.'
  },
  volume_confidence: {
    term: 'Volume confidence',
    technical:
      'Heuristic score from book count, vig, time-to-game, league tier, sharp-book presence (client calcVolumeConfidence).',
    plain:
      'Whether the split percentages reflect a real market or a thin trickle of bets.',
    interpret:
      'Prefer conclusions from "high" volume games. Low volume splits can be random.'
  },
  trustworthy: {
    term: 'Trustworthy slice',
    technical:
      `n ≥ minN (default ${DEFAULT_MIN_N}) AND ROI 95% CI excludes 0%.`,
    plain:
      'Enough picks and a statistically distinguishable ROI.',
    interpret:
      'Only trustworthy slices support "this scenario has an edge." Others are exploratory.'
  },
  source: {
    term: 'Splits source',
    technical:
      'VSiN betting-splits scrape, typically DraftKings-reported handle (source=DK). Not Pinnacle sharp flow.',
    plain:
      'Where the ticket/money numbers come from.',
    interpret:
      'This is retail-book reporting, not true sharp-book position data.'
  }
};

const MAG_BUCKETS = [
  { id: 'no_signal', label: 'No signal (<4 pts)', min: null, max: 3.99 },
  { id: 'weak', label: 'Weak (4–6 pts)', min: 4, max: 6.99 },
  { id: 'moderate', label: 'Moderate (7–11 pts)', min: 7, max: 11.99 },
  { id: 'strong', label: 'Strong (12–17 pts)', min: 12, max: 17.99 },
  { id: 'very_strong', label: 'Very strong (18+ pts)', min: 18, max: Infinity }
];

function magBucket(magnitude) {
  if (magnitude == null || !isFinite(magnitude)) return 'no_signal';
  for (const b of MAG_BUCKETS) {
    if (b.min == null && magnitude < 4) return b.id;
    if (b.min != null && magnitude >= b.min && magnitude <= b.max) return b.id;
  }
  return 'no_signal';
}

function isGraded(e) {
  return e && (e.result === 'win' || e.result === 'loss' || e.result === 'push');
}

function isDecided(e) {
  return e && (e.result === 'win' || e.result === 'loss');
}

function profitUnits(e) {
  if (e.profitUnits != null && isFinite(e.profitUnits)) return e.profitUnits;
  if (!isGraded(e) || !e.units) return 0;
  if (e.result === 'push') return 0;
  if (e.result === 'loss') return -e.units;
  if (e.result === 'win' && e.pubOdds != null) {
    const dec = e.pubOdds > 0 ? e.pubOdds / 100 : 100 / Math.abs(e.pubOdds);
    return e.units * dec;
  }
  return 0;
}

function scoreSlice(entries, minN) {
  const n = entries.length;
  if (n === 0) {
    return { n: 0, trustworthy: false, note: 'empty' };
  }
  const graded = entries.filter(isGraded);
  const decided = entries.filter(isDecided);
  const wins = decided.filter(e => e.result === 'win').length;
  const pls = graded.map(profitUnits);
  const staked = graded.reduce((a, e) => a + (e.units || 0), 0);
  const sumPL = pls.reduce((a, b) => a + b, 0);
  const roi = staked > 0 ? (sumPL / staked) * 100 : 0;

  const mean = sumPL / Math.max(1, graded.length);
  const variance =
    pls.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, graded.length - 1);
  const se = Math.sqrt(variance / Math.max(1, graded.length));
  const ciHalf = 1.96 * se * 100;
  const ciLo = Math.round((roi - ciHalf) * 100) / 100;
  const ciHi = Math.round((roi + ciHalf) * 100) / 100;

  const evVals = entries.map(e => e.ev).filter(v => v != null);
  const avgEV = evVals.length
    ? Math.round((evVals.reduce((a, b) => a + b, 0) / evVals.length) * 10) / 10
    : null;

  const trustworthy = graded.length >= minN && (ciLo > 0 || ciHi < 0);

  return {
    n,
    graded: graded.length,
    decided: decided.length,
    win_pct: decided.length
      ? Math.round((wins / decided.length) * 1000) / 10
      : null,
    roi_pct: Math.round(roi * 100) / 100,
    roi_ci95: [ciLo, ciHi],
    units_pl: Math.round(sumPL * 1000) / 1000,
    avg_ev_pct: avgEV,
    trustworthy,
    note: graded.length < minN
      ? `insufficient sample (graded n=${graded.length} < ${minN})`
      : ciLo <= 0 && ciHi >= 0
        ? 'sample ok but ROI CI still spans 0 — unproven'
        : 'trustworthy'
  };
}

function entryHasSplits(e) {
  return e.splitsSnapshot && e.splitsSnapshot.available === true;
}

function buildScenarioPredicates() {
  return {
    all_graded_with_splits: e => entryHasSplits(e) && isGraded(e),
    all_locks: e => true,
    splits_available: e => entryHasSplits(e),

    agrees_magnitude_4_plus: e =>
      entryHasSplits(e) && e.splitsSnapshot.agreesWithLock && (e.splitsSnapshot.magnitude || 0) >= 4,
    agrees_magnitude_7_plus: e =>
      entryHasSplits(e) && e.splitsSnapshot.agreesWithLock && (e.splitsSnapshot.magnitude || 0) >= 7,
    agrees_magnitude_12_plus: e =>
      entryHasSplits(e) && e.splitsSnapshot.agreesWithLock && (e.splitsSnapshot.magnitude || 0) >= 12,
    agrees_magnitude_18_plus: e =>
      entryHasSplits(e) && e.splitsSnapshot.agreesWithLock && (e.splitsSnapshot.magnitude || 0) >= 18,

    opposes_magnitude_4_plus: e =>
      entryHasSplits(e) && e.splitsSnapshot.agreesWithLock === false &&
      (e.splitsSnapshot.magnitude || 0) >= 4,
    opposes_magnitude_12_plus: e =>
      entryHasSplits(e) && e.splitsSnapshot.agreesWithLock === false &&
      (e.splitsSnapshot.magnitude || 0) >= 12,

    no_splits_signal: e =>
      entryHasSplits(e) && (e.splitsSnapshot.magnitude == null || e.splitsSnapshot.magnitude < 4),

    market_ml: e => entryHasSplits(e) && e.splitsSnapshot.market === 'ML',
    market_spread: e => entryHasSplits(e) && e.splitsSnapshot.market === 'Spread',
    market_total: e => entryHasSplits(e) && e.splitsSnapshot.market === 'Total',

    vol_high_agrees: e =>
      entryHasSplits(e) && e.splitsSnapshot.agreesWithLock &&
      e.splitsSnapshot.volumeTier === 'high',
    vol_low_any: e =>
      entryHasSplits(e) && e.splitsSnapshot.volumeTier === 'low',

    cross_market_strongest_not_lock_market: e =>
      entryHasSplits(e) && e.splitsSnapshot.usedStrongestFallback === true,

    ev_2_plus_agrees: e =>
      entryHasSplits(e) && e.splitsSnapshot.agreesWithLock && (e.ev || 0) >= 2,
    ev_2_plus_opposes: e =>
      entryHasSplits(e) && e.splitsSnapshot.agreesWithLock === false && (e.ev || 0) >= 2
  };
}

function analyzeByMagnitudeBuckets(entries, minN) {
  const graded = entries.filter(e => entryHasSplits(e) && isGraded(e));
  const out = {};
  for (const b of MAG_BUCKETS) {
    const sub = graded.filter(e => magBucket(e.splitsSnapshot.magnitude) === b.id);
    out[b.id] = {
      label: b.label,
      ...scoreSlice(sub, minN)
    };
  }
  return out;
}

function analyzeCrossTab(entries, minN) {
  const graded = entries.filter(e => entryHasSplits(e) && isGraded(e));
  const agrees = ['yes', 'no'];
  const buckets = ['weak', 'moderate', 'strong', 'very_strong'];
  const grid = {};
  for (const a of agrees) {
    grid[a] = {};
    for (const b of buckets) {
      const sub = graded.filter(e => {
        const ag = e.splitsSnapshot.agreesWithLock ? 'yes' : 'no';
        const mb = magBucket(e.splitsSnapshot.magnitude);
        return ag === a && mb === b;
      });
      grid[a][b] = scoreSlice(sub, minN);
    }
  }
  return grid;
}

function topInsights(ranked, minN) {
  const tips = [];
  const trust = ranked.filter(r => r.stats.trustworthy);
  if (!trust.length) {
    tips.push({
      level: 'info',
      text:
        'No scenario has met the sample-size and confidence-interval bar yet. ' +
        'Keep logging Locks with splits enabled; check back after more games grade.'
    });
    return tips;
  }
  const best = trust[0];
  tips.push({
    level: 'success',
    text:
      `Strongest trustworthy scenario so far: "${best.label}" — ` +
      `ROI ${best.stats.roi_pct}% (95% CI ${best.stats.roi_ci95[0]}% to ${best.stats.roi_ci95[1]}%), ` +
      `n=${best.stats.graded} graded picks.`
  });
  const worst = trust[trust.length - 1];
  if (worst.stats.roi_pct < 0) {
    tips.push({
      level: 'warn',
      text:
        `Weakest trustworthy scenario: "${worst.label}" — ROI ${worst.stats.roi_pct}%. ` +
        'Consider deprioritizing that splits profile even if it "feels" sharp.'
    });
  }
  tips.push({
    level: 'info',
    text:
      'Splits measure DK-reported handle skew, not Pinnacle order flow. ' +
      'Combine with model EV (price vs sharp fair line) — splits alone are not stakes advice.'
  });
  return tips;
}

function analyzeSplitsAttribution(entries, options) {
  const minN = Math.max(5, parseInt(options && options.minN, 10) || DEFAULT_MIN_N);
  const all = Array.isArray(entries) ? entries : [];
  const withSplits = all.filter(entryHasSplits);
  const graded = all.filter(isGraded);
  const gradedWithSplits = withSplits.filter(isGraded);
  const legacy = all.filter(e => !entryHasSplits(e));

  const preds = buildScenarioPredicates();
  const slices = {};
  for (const [name, pred] of Object.entries(preds)) {
    const sub = graded.filter(pred);
    slices[name] = {
      label: name.replace(/_/g, ' '),
      ...scoreSlice(sub, minN)
    };
  }

  const magnitude_buckets = analyzeByMagnitudeBuckets(all, minN);
  const cross_agrees_x_magnitude = analyzeCrossTab(all, minN);

  const ranked = Object.entries(slices)
    .filter(([k]) => k !== 'all_locks' && k !== 'splits_available')
    .map(([k, v]) => ({ key: k, label: v.label, stats: v }))
    .filter(r => r.stats.graded > 0)
    .sort((a, b) => b.stats.roi_pct - a.stats.roi_pct);

  const ranked_trustworthy = ranked.filter(r => r.stats.trustworthy);

  return {
    version: 1,
    minN,
    glossary: GLOSSARY,
    methodology: {
      hypothesis:
        'Handle% exceeding tickets% on the same side (with money majority) identifies larger bettors; ' +
        'when aligned with a positive-EV Lock, outcomes may improve versus locks without that signal.',
      design:
        'Observational cohort study on first-seen Lock snapshots. Splits frozen at log time (no lookahead). ' +
        'Primary outcome: units P/L and ROI; secondary: win%. Inference: normal-approx ROI CI with explicit minN.',
      limitations: [
        'VSiN/DK splits ≠ true sharp-book positions; latency and rounding unknown.',
        'Multiple comparisons across scenarios inflate false-discovery risk — treat exploratory slices cautiously.',
        'Survivorship: only games with splits scraped are included.',
        'Legacy tracker rows without splitsSnapshot are excluded from splits cohort.'
      ],
      reading_order: [
        'Check cohort counts (graded with splits vs legacy).',
        'Inspect magnitude_buckets monotonicity — does ROI rise with gap?',
        'Compare agrees_* vs opposes_* at same magnitude floor.',
        'Trust only slices where trustworthy=true.',
        'Cross-check avg_ev_pct — price edge may dominate splits narrative.'
      ]
    },
    cohort: {
      total_logged: all.length,
      graded: graded.length,
      with_splits_snapshot: withSplits.length,
      graded_with_splits: gradedWithSplits.length,
      legacy_without_splits: legacy.length
    },
    magnitude_buckets,
    cross_agrees_x_magnitude,
    slices,
    ranked,
    ranked_trustworthy,
    insights: topInsights(ranked_trustworthy, minN)
  };
}

module.exports = {
  GLOSSARY,
  MAG_BUCKETS,
  magBucket,
  scoreSlice,
  analyzeSplitsAttribution,
  DEFAULT_MIN_N
};
