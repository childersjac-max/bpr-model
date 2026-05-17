// ============================================================================
// /api/attribution — honest signal-by-signal performance
// ============================================================================
// The analytical payoff of the whole data layer. Answers, from YOUR stored
// history (not estimates): which signals and signal COMBINATIONS actually
// produced positive ROI and positive CLV, and whether the sample is large
// enough to believe it.
//
// Every aggregate ships with a 95% confidence interval on ROI. Below a
// minimum graded sample the point estimate is returned but flagged
// insufficient — because a 55% and a 50% bettor are statistically
// indistinguishable at n=50, and pretending otherwise is how tools lie.
//
// Query params:
//   sport   optional sport_key filter
//   market  optional (Moneyline|Spread|Total)
//   minN    minimum graded picks to consider a slice "trustworthy" (default 200)
// ============================================================================

const db = require('../lib/db');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!db.isEnabled()) {
    return res.status(200).json({
      enabled: false,
      note: 'DB layer dormant. Configure POSTGRES_URL and let the crons ' +
            'collect history; attribution needs graded picks to report.'
    });
  }

  const sport = req.query.sport || null;
  const market = req.query.market || null;
  const minN = Math.max(1, parseInt(req.query.minN || '200', 10));

  const where = [`lp.graded = TRUE`, `lp.result IN ('win','loss','push')`];
  const args = [];
  if (sport) { args.push(sport); where.push(`lp.sport_key = $${args.length}`); }
  if (market) { args.push(market); where.push(`lp.market = $${args.length}`); }
  const W = where.join(' AND ');

  try {
    // Each pick is tagged with which signals fired for it at generation time
    // (we read this from the stored dossier so it reflects real time, never
    // hindsight). We expose a boolean per signal via the dossier JSON.
    const rows = (await db.query(
      `SELECT lp.result, lp.units_pl, lp.clv_pct, lp.ev_pct,
              COALESCE((lp.dossier->'signals'->>'steam')::boolean,false)  AS steam,
              COALESCE((lp.dossier->'signals'->>'rlm')::boolean,false)    AS rlm,
              COALESCE((lp.dossier->'signals'->>'xmarket')::boolean,false) AS xmarket,
              COALESCE(lp.is_alt,false)                                    AS alt,
              COALESCE((lp.dossier->'signals'->>'stale')::boolean,false)  AS stale
         FROM lock_picks lp
        WHERE ${W}`,
      args
    )).rows;

    if (rows.length === 0) {
      return res.status(200).json({
        enabled: true, total_graded: 0,
        note: 'No graded picks yet. Let the crons run through some slates.'
      });
    }

    // A "slice" is a predicate over a pick. We score each slice the same way.
    const slices = {
      'all_picks':                  () => true,
      'price_only_no_signals':      r => !r.steam && !r.rlm && !r.xmarket && !r.alt,
      'steam':                      r => r.steam,
      'rlm':                        r => r.rlm,
      'steam_AND_rlm':              r => r.steam && r.rlm,
      'cross_market_agreement':     r => r.xmarket,
      'alt_line_edge':              r => r.alt,
      'steam_OR_rlm':               r => r.steam || r.rlm,
      'any_signal_plus_alt':        r => (r.steam || r.rlm || r.xmarket) && r.alt,
      'stale_flagged':              r => r.stale,
      'high_ev_3pct_plus':          r => (r.ev_pct ?? 0) >= 3,
      'high_ev_plus_any_signal':    r => (r.ev_pct ?? 0) >= 3 && (r.steam || r.rlm || r.xmarket)
    };

    const out = {};
    for (const [name, pred] of Object.entries(slices)) {
      const sub = rows.filter(pred);
      out[name] = scoreSlice(sub, minN);
    }

    // Rank trustworthy slices by ROI so the answer to "which combo wins
    // most" is immediate.
    const ranked = Object.entries(out)
      .filter(([, v]) => v.trustworthy)
      .sort((a, b) => b[1].roi_pct - a[1].roi_pct)
      .map(([k, v]) => ({ slice: k, roi_pct: v.roi_pct,
                          ci95: v.roi_ci95, n: v.n,
                          avg_clv_pct: v.avg_clv_pct }));

    return res.status(200).json({
      enabled: true,
      filters: { sport, market, minN },
      total_graded: rows.length,
      slices: out,
      ranked_trustworthy: ranked,
      reading_guide:
        'Trust a slice only when trustworthy=true (n >= minN AND the ROI ' +
        '95% CI excludes 0). avg_clv_pct is the leading indicator; it ' +
        'stabilizes faster than ROI. A slice with positive CLV but ' +
        'still-wide ROI CI is promising but unproven.'
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

// Score one slice: ROI, win%, CLV, and a 95% CI on ROI via the normal
// approximation on per-bet P/L (adequate for n in the hundreds; we flag
// small n rather than pretending the CI is tight).
function scoreSlice(rows, minN) {
  const n = rows.length;
  if (n === 0) {
    return { n: 0, trustworthy: false, note: 'empty' };
  }
  const decided = rows.filter(r => r.result !== 'push');
  const wins = decided.filter(r => r.result === 'win').length;
  const pls = rows.map(r => Number(r.units_pl || 0));
  const staked = rows.length; // 1u per pick by convention in lock_picks
  const sumPL = pls.reduce((a, b) => a + b, 0);
  const roi = staked > 0 ? (sumPL / staked) * 100 : 0;

  // std of per-bet P/L for CI on mean P/L → scale to ROI%
  const mean = sumPL / n;
  const variance =
    pls.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
  const se = Math.sqrt(variance / n);          // SE of mean units P/L
  const ciHalf = 1.96 * se * 100;              // as ROI %
  const ciLo = Math.round((roi - ciHalf) * 100) / 100;
  const ciHi = Math.round((roi + ciHalf) * 100) / 100;

  const clvVals = rows.map(r => r.clv_pct).filter(v => v != null);
  const avgCLV = clvVals.length
    ? Math.round((clvVals.reduce((a, b) => a + b, 0) / clvVals.length) * 100) / 100
    : null;

  const trustworthy = n >= minN && (ciLo > 0 || ciHi < 0);

  return {
    n,
    decided: decided.length,
    win_pct: decided.length
      ? Math.round((wins / decided.length) * 1000) / 10 : null,
    roi_pct: Math.round(roi * 100) / 100,
    roi_ci95: [ciLo, ciHi],
    avg_clv_pct: avgCLV,
    trustworthy,
    note: n < minN
      ? `insufficient sample (n=${n} < ${minN}); estimate unreliable`
      : (ciLo <= 0 && ciHi >= 0)
        ? 'sample ok but ROI CI still spans 0 — unproven'
        : 'trustworthy'
  };
}
