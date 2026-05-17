// ============================================================================
// lib/books.js — book classification + Odds API normalization
// ============================================================================
// Single source of truth for which books are "sharp" vs "public". These must
// match the client (SHP / PUB in index.html) or the server-computed fair
// probs will silently disagree with what the UI shows.
// ============================================================================

const SHARP_BOOKS = ['pinnacle', 'circa', 'bookmaker'];
const PUBLIC_BOOKS = [
  'draftkings', 'fanduel', 'betmgm', 'bovada',
  'williamhill_us', 'bet365'
];

function isSharp(bookKey) {
  return SHARP_BOOKS.includes(bookKey);
}

// Flatten one Odds API game object into snapshot rows:
//   { book_key, is_sharp, market, side, american_odds, point }
// Markets kept: h2h, spreads, totals. Alts arrive via a different endpoint
// and are flattened by the same shape so the snapshot table is uniform.
function flattenGameToRows(game) {
  const rows = [];
  for (const bk of (game.bookmakers || [])) {
    const sharp = isSharp(bk.key);
    for (const m of (bk.markets || [])) {
      const market = m.key;
      if (market !== 'h2h' && market !== 'spreads' && market !== 'totals' &&
          market !== 'alternate_spreads' && market !== 'alternate_totals') {
        continue;
      }
      // normalize alt market keys onto their base market name so
      // attribution can treat "the spread market" as one thing
      const baseMarket =
        market === 'alternate_spreads' ? 'spreads'
        : market === 'alternate_totals' ? 'totals'
        : market;
      for (const o of (m.outcomes || [])) {
        if (o.price == null) continue;
        rows.push({
          book_key: bk.key,
          is_sharp: sharp,
          market: baseMarket,
          side: o.name,
          american_odds: Math.round(o.price),
          point: o.point == null ? null : Number(o.point)
        });
      }
    }
  }
  return rows;
}

module.exports = {
  SHARP_BOOKS,
  PUBLIC_BOOKS,
  isSharp,
  flattenGameToRows
};
