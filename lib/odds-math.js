// ============================================================================
// lib/odds-math.js — canonical betting math, server-side
// ============================================================================
// This is the SAME math the v3.5 client uses (deVig2Way / evFromFair /
// unitsFromEdge), lifted out of the 8k-line HTML so the crons and the
// CLV/attribution engine all compute identically. One source of truth.
//
// Conventions:
//   * American odds in, probabilities 0..1 out.
//   * "fair prob" always means a two-way de-vigged probability from a SINGLE
//     book (cross-book de-vig is mathematically invalid — both prices must
//     come from the same market or the implieds don't sum coherently).
// ============================================================================

function impliedProb(american) {
  if (american == null) return null;
  return american > 0
    ? 100 / (american + 100)
    : Math.abs(american) / (Math.abs(american) + 100);
}

function americanToDecimal(american) {
  if (american == null) return null;
  return american > 0 ? american / 100 + 1 : 100 / Math.abs(american) + 1;
}

// Two-way de-vig: divide each side's implied prob by their sum. Removes the
// book hold symmetrically. Returns fair prob for the side priced at sideO.
function deVig2Way(sideO, otherO) {
  if (sideO == null || otherO == null) return null;
  const p1 = impliedProb(sideO);
  const p2 = impliedProb(otherO);
  const sum = p1 + p2;
  if (!isFinite(sum) || sum <= 0) return null;
  return p1 / sum;
}

// EV% given a de-vigged fair prob and the price you would actually bet at.
function evFromFair(fairProb, betAmerican) {
  if (fairProb == null || betAmerican == null) return null;
  const dec = americanToDecimal(betAmerican);
  return Math.round((fairProb * dec - 1) * 1000) / 10; // one decimal, %
}

// Real half-Kelly fraction (0..1). f* = (b*p - q)/b, then /2.
function halfKelly(fairProb, betAmerican) {
  if (fairProb == null || betAmerican == null) return 0;
  const dec = americanToDecimal(betAmerican);
  const b = dec - 1;
  if (b <= 0) return 0;
  const p = fairProb;
  const q = 1 - p;
  const f = (b * p - q) / b;
  if (f <= 0) return 0;
  return f / 2;
}

// Discrete unit tiers, matching v3.4/v3.5 thresholds.
function unitsFromHalfKelly(hk) {
  if (hk >= 0.05) return 5;
  if (hk >= 0.035) return 4;
  if (hk >= 0.025) return 3;
  if (hk >= 0.0175) return 2;
  if (hk >= 0.01) return 1;
  return 0;
}

// ----------------------------------------------------------------------------
// True CLV. Given the fair prob you got at bet time and the fair prob implied
// by the CLOSING line (same de-vig method), CLV is the probability-points
// improvement and its percentage form. Positive = you beat the close.
//
// The literature treats ~1% CLV ≈ ~1% long-run ROI in major markets, so we
// report both the raw probability delta and the percentage so the
// attribution engine can use whichever is appropriate.
// ----------------------------------------------------------------------------
function computeCLV(betFairProb, closingFairProb) {
  if (betFairProb == null || closingFairProb == null) {
    return { clv_prob_pts: null, clv_pct: null };
  }
  const pts = betFairProb - closingFairProb;
  const pct = closingFairProb > 0 ? (pts / closingFairProb) * 100 : null;
  return {
    clv_prob_pts: Math.round(pts * 1e5) / 1e5,
    clv_pct: pct == null ? null : Math.round(pct * 100) / 100
  };
}

// Grade a moneyline/spread/total pick against a final score.
// Returns 'win' | 'loss' | 'push' | null (null = cannot grade here).
function gradeAgainstScore(market, side, line, homeTeam, awayTeam,
                           homeScore, awayScore) {
  if (homeScore == null || awayScore == null) return null;
  const m = (market || '').toLowerCase();

  if (m.startsWith('money') || m === 'h2h') {
    const winner = homeScore > awayScore ? homeTeam
                 : awayScore > homeScore ? awayTeam : null;
    if (winner == null) return 'push'; // ties (rare; e.g. some soccer h2h)
    return side === winner ? 'win' : 'loss';
  }

  if (m.startsWith('spread')) {
    // line is the spread for `side`. side covers if its score + line > opp.
    const isHome = side === homeTeam;
    const own = isHome ? homeScore : awayScore;
    const opp = isHome ? awayScore : homeScore;
    const margin = own + Number(line) - opp;
    if (Math.abs(margin) < 1e-9) return 'push';
    return margin > 0 ? 'win' : 'loss';
  }

  if (m.startsWith('total')) {
    const total = homeScore + awayScore;
    const diff = total - Number(line);
    if (Math.abs(diff) < 1e-9) return 'push';
    if (side === 'Over') return diff > 0 ? 'win' : 'loss';
    if (side === 'Under') return diff < 0 ? 'win' : 'loss';
    return null;
  }

  return null;
}

// Units P/L for a graded result at the price actually taken.
function unitsPL(result, betAmerican, stakeUnits) {
  const s = stakeUnits == null ? 1 : stakeUnits;
  if (result === 'push' || result === 'void') return 0;
  if (result === 'loss') return -1 * s;
  if (result === 'win') {
    const dec = americanToDecimal(betAmerican);
    return (dec - 1) * s; // profit only
  }
  return 0;
}

module.exports = {
  impliedProb,
  americanToDecimal,
  deVig2Way,
  evFromFair,
  halfKelly,
  unitsFromHalfKelly,
  computeCLV,
  gradeAgainstScore,
  unitsPL
};
