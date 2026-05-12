# bpr-model (J LAB)

Sports betting model and odds dashboard. Compares public-book pricing to a de-vigged sharp consensus (Pinnacle / Circa) and surfaces positive-EV picks across **moneyline, spreads, alt spreads, totals, alt totals, player props, and alt player props** with half-Kelly unit sizing.

## Setup

### 1. Environment variables (required)

Set in Vercel → Project → Settings → Environment Variables:

| Variable | Required | Purpose |
| --- | --- | --- |
| `ODDS_API_KEY` | yes | Your key from <https://the-odds-api.com/>. Used by `/api/odds`, `/api/sports`, `/api/props`, `/api/stats`, `/api/alt-lines`. |
| `KV_REST_API_URL` | optional | Vercel KV (Upstash Redis) REST URL. Enables server-side line history. |
| `KV_REST_API_TOKEN` | optional | Vercel KV REST token. Auto-populated by the KV integration. |

> **Security note:** Earlier versions of this repo had the Odds API key hardcoded in source. If you forked from that version, **rotate your Odds API key immediately**.

### 2. Quota planning for alt markets

Alt markets are expensive. The Odds API charges `markets × regions` per per-event call. To keep your dashboard view cheap and only pay for alts when a user actually looks at a game:

| Endpoint | When called | Approx quota cost |
| --- | --- | --- |
| `GET /api/odds?sport=X` | On every page load (sport refresh) | 3 credits/region (h2h+spreads+totals) |
| `GET /api/alt-lines?eventId=X` | When user expands a game card | ~4 credits (spreads, alt_spreads, totals, alt_totals × 1 region) |
| `GET /api/props?sport=X&eventId=Y` | When user expands a card (supported sports) | ~(N_stats × 2) credits — main + `_alternate` per stat × 1 region |

Both per-event endpoints are server-cached for **60 seconds**, so repeated card expands by the same or different users in that window cost zero credits.

If you want even more aggressive savings, set `regions=us` only (skip EU) in `api/alt-lines.js` and `api/odds.js`. The defaults are `us,eu` for breadth.

### 3. Enable server-side line history (optional but recommended)

Without this, steam-move / RLM / CLV signals only work for users who've kept the app open long enough to accumulate browser snapshots.

1. Vercel → Storage → Create Database → KV. The integration auto-sets the env vars.
2. Add `@vercel/kv` is already listed as an optional dependency in `package.json`.
3. Optionally schedule a cron at `* * * * *` to POST to `/api/line-history?action=snapshot` (uses extra Odds API quota).

## How picks are generated

For each upcoming game, the analyzers run in two passes:

**Pass 1 (free, runs on every dashboard refresh):** main-line h2h/spreads/totals analysis using the bulk `/api/odds` data. Surfaces top "Locks" picks on the home tab.

**Pass 2 (per-event, runs on card expand):** the full **alt-spread, alt-total, and alt-prop ladders** load lazily via `/api/alt-lines` and `/api/props?eventId=...`. New analyzers (`analyzeSpreadWithAlts`, `analyzeTotalWithAlts`) scan every rung of the ladder and find the highest-EV combination across the entire surface.

Each analyzer computes:

1. **De-vigged fair probability** from both sides of the sharp market at a given point (Pinnacle preferred, falls back to median of sharp books).
2. **EV%** of the public price vs that fair probability.
3. **Half-Kelly unit sizing** mapped to a discrete tier (0.1u … 5u).
4. **Sharp signals**: sharp-price gap, steam moves, reverse line movement, CLV proxy.
5. **VSiN split agreement bonus**: multiplicative boost on edge (up to ×1.20) when handle % outpaces ticket % by 12+ points.
6. **Alt-ladder rung selection**: across all main and alternate spread/total points, picks the rung where (sharp de-vig vs public price) yields the highest EV%. Alts often surface bigger edges than main lines because public books mis-juice the ladder more.

A pick becomes a "Lock" when units ≥ 0.5 after sizing.

## Player props

The props panel inside each game card combines:

- **VSiN historical hit rates** for the main line (season record, ROI, hit %)
- **Live cross-book prices** for the main line via The Odds API
- **Full alt ladder** showing every alternate over/under rung with its own de-vigged EV computation. Rungs with positive EV are highlighted in green.

Supported sports for props: NBA, MLB, NFL.

## Recent changes

This release adds:

- **`/api/alt-lines`** — new per-event endpoint pulling spreads, alternate_spreads, totals, alternate_totals
- **Alt-prop markets in `/api/props`** — adds `_alternate` market keys for every supported stat
- **`analyzeSpreadWithAlts` / `analyzeTotalWithAlts`** — front-end analyzers that find the best-EV rung across the full ladder
- **Alt ladder UI** — collapsible table inside each game card showing every +EV rung with its public price, sharp fair probability, and EV%
- **Alt prop ladder UI** — inside each prop card, a mini table showing every +EV alternate over/under for that player
- **Lazy per-event fetching** — alts only load when a user expands a card, with 60-second server-side caching
- **Quota-aware design** — bulk listing view stays cheap; alts cost only when needed

Previous release improvements still present:

- Proper two-way de-vig replacing the broken `*1.02` inflator
- API key moved to env var (was hardcoded in source)
- Pinnacle-preferred median sharp price (was first-found)
- Multiplicative splits boost on edge (was additive on units)
- EV-only ranking with tightened labels
- Honest SU records in `/api/stats` (no more fake ATS/O-U using hardcoded league averages)
- Server-side line history for steam/RLM/CLV signals
- Line-age timestamp on every game card
- No fabricated confidence/EV on scraped expert picks

## Endpoints

| Method/Path | Cost | Purpose |
| --- | --- | --- |
| `GET /api/sports` | free | List of supported leagues |
| `GET /api/odds?sport=X` | 3 credits | Bulk h2h/spreads/totals for all events in a sport |
| `GET /api/alt-lines?sport=X&eventId=Y` | ~4 credits | Full spread+total ladder including alternates for one event (60s cache) |
| `GET /api/splits?sport=X` | free | VSiN betting-splits scrape |
| `GET /api/picks` | free | Aggregated expert picks (Doc's, SCP, PickDawgz, VSiN) |
| `GET /api/props?sport=X&eventId=Y` | varies | VSiN props + live cross-book odds + alt prop ladder |
| `GET /api/stats?sport=X` | 1 credit | Straight-up records + scoring averages |
| `POST /api/line-history?action=snapshot` | free | Store odds snapshot (KV-backed) |
| `GET /api/line-history?gameId=X` | free | Retrieve snapshots |
| `GET /api/line-history?action=movement&gameId=X` | free | Computed steam/RLM/CLV from server history |
