# bpr-model v3.5 (J LAB)

Sports betting tool focused on **one goal: identifying +EV bets that will make you money.** Compares public-book pricing to a properly de-vigged sharp consensus (Pinnacle preferred), surfaces edges across moneyline, spread, total, and their alt ladders, sizes them with real half-Kelly, tracks your CLV against the closing line, and **automatically tracks the model's real W/L performance** so you can see whether it's actually working.

---

## What's new in  v3.5

### Tracker tab — auto-logged W/L performance of every Lock
A new bottom-nav tab that **automatically logs every pick that appears in the Locks tab** and grades it against final scores via a new `/api/scores` endpoint. This is the honest answer to "is this model working?" — independent of which bets you actually placed.

**Five views:**
1. **Overview** — recent picks list with manual W/L/Push override buttons for any pick the auto-grader can't resolve (e.g. player props).
2. **By Unit Size** — does Premium (4u+) actually beat Playable (1u)? If not, the Kelly tiers carry no signal and you should size flat. Includes an automatic insight banner that flags the relationship.
3. **By Sport / League** — pinpoints where the model genuinely works (consistent positive ROI over 50+ picks) and where to deprioritize.
4. **By Bet Type** — moneyline vs spread vs total vs ALT-rung performance. If alt picks aren't out-performing main lines, your alt-prefetch quota is being wasted on noise.
5. **Over Time** — daily / weekly / monthly P/L with a cumulative-units SVG chart. Watch your equity curve in real time.

**Auto-grading:** when the Tracker tab is opened or after each bulk odds refresh, ungraded picks whose games have started are batched by sport and graded via The Odds API's `/scores` endpoint (1-2 credits per sport, called at most every 5 minutes). Moneyline, spread, and total picks grade automatically; player props remain pending until you manually mark them.

**P/L math:** wins pay at the actual price you got. A 1u win at +150 returns 1.5u profit; a 1u win at -150 returns 0.667u. Losses are always -1u × your stake. Pushes are 0. ROI is computed as units P/L divided by units staked.

**Storage:** localStorage `jlab_tracker_log`, deduplicated by `game_id|market|side|line`. Re-running `computeLocks()` won't create duplicates — the first snapshot is kept. CSV export available.

### New endpoint
- `GET /api/scores?sport=X&daysFrom=3` — returns completed games with final scores. 1-2 Odds API credits per call.

---

## What was added/changed in v3.4 (from v3.3)

### Sizing math fixed
v3.3's `unitsFromEdge` used `(edge / pubProb) * 0.5`, labeled as "half-Kelly." That formula is actually ~ EV%/2 and only matches half-Kelly near even money. On plus-money dogs it **roughly doubles** the correct stake; on heavy chalk it under-sizes. v3.4 replaces it with **real Kelly**: `f* = (b·p − q) / b`, where `b` = decimal odds − 1, then halves. New tiers: 5u ≥ 5%, 4u ≥ 3.5%, 3u ≥ 2.5%, 2u ≥ 1.75%, 1u ≥ 1%. Sub-1u = no bet.

### Lock threshold raised
v3.3 made any pick a "Lock" at units ≥ 0.5. v3.4 floors at units ≥ 1. Expect 60–80% fewer Locks — but each one is a real bet.

### Locks now use the alt ladder
`computeLocks` runs both main-line and alt-aware analyzers per market and keeps the better-EV result. Auto-prefetches alt ladders for any game with a ≥1u main-line edge (capped at 8 games/refresh).

### Splits sizing boost removed
v3.3 multiplied the de-vigged fair probability by 1.10–1.20 on splits "agreement." Removed in v3.4. Splits still display as a badge — informational only.

### Same-book de-vig required
`_sharpH2HPair` now requires both sides from a single sharp book. Cross-book de-vig is mathematically invalid.

### CLV Tracker (Tab 2)
Replaces v3.3's expert-picks "Outside" tab. Auto-logs every betslip add with bet-time price + sharp fair prob. Captures closing fair prob within 30 min of game start. Average CLV over a meaningful sample is independent confirmation that the model's edges are real.

### Removed
- `/api/stats` endpoint (useless SU records).
- `/api/picks` endpoint and scraper (no signal value).
- Dead `buildLockReasoning` function.
- "Lean" tier label.

### Other
- Sharp-vs-public "CLV" badge raised 3%→5%, relabeled as "point-in-time, not closing CLV."
- Stale-line gating: picks with > 5 min old data flagged as STALE.

---

## Setup

### 1. Environment variables (required)

Set in Vercel → Project → Settings → Environment Variables:

| Variable | Required | Purpose |
| --- | --- | --- |
| `ODDS_API_KEY` | yes | Your key from <https://the-odds-api.com/>. Used by `/api/odds`, `/api/sports`, `/api/props`, `/api/alt-lines`, `/api/scores`. |
| `KV_REST_API_URL` | optional | Vercel KV (Upstash Redis) REST URL. Enables server-side line history for steam/RLM detection. |
| `KV_REST_API_TOKEN` | optional | Vercel KV REST token. Auto-populated by the KV integration. |

> **Security note:** Earlier versions of this repo had the Odds API key hardcoded in source. If you forked from that version, **rotate your Odds API key immediately**.

### 2. Quota planning

| Endpoint | When called | Approx quota cost |
| --- | --- | --- |
| `GET /api/odds?sport=X` | On every page refresh | 3 credits/region |
| `GET /api/alt-lines?eventId=X` | Auto-prefetch for ≥1u edges + on card expand | ~4 credits, 60s cache |
| `GET /api/props?sport=X&eventId=Y` | On card expand (NBA/MLB/NFL only) | ~(N stats × 2) credits |
| `GET /api/scores?sport=X` | After each refresh if Tracker has ungraded picks (≥5 min between calls per sport) | 1-2 credits |

---

## How to use the tool

1. **Pin the Locks tab.** Focus on **Premium (4u+)** and **Solid (2u+)** plays.

2. **Watch for ALT badges.** A purple "ALT" tag means the edge is on an alternate spread or alt total rung — these are often the largest mispricings.

3. **Shop the price.** The "best public price" in the model is across 6 books. Always confirm the price you can get matches the price the model used.

4. **Add to betslip → auto-logs to CLV tracker.** Every add becomes a row in the CLV log with bet-time sharp fair prob. After 50+ bets, your average CLV is the answer to "are my placed bets actually +EV?"

5. **Check the Tracker tab regularly.** Even if you don't bet a pick, it's logged. After ~50 graded picks per slice (sport / unit tier / bet type), you'll start to see where the model genuinely works.

6. **The two tabs answer different questions:**
   - **CLV tab** = "Are MY bets beating the closing line?" (proof of your selections being +EV)
   - **Tracker tab** = "Is the MODEL itself working?" (proof of the underlying engine)

---

## Endpoints

| Method/Path | Cost | Purpose |
| --- | --- | --- |
| `GET /api/sports` | free | List of supported leagues |
| `GET /api/odds?sport=X` | 3 credits | Bulk h2h/spreads/totals for a sport |
| `GET /api/alt-lines?sport=X&eventId=Y` | ~4 credits | Full alt ladder for one event (60s cache) |
| `GET /api/splits?sport=X` | free | VSiN betting-splits scrape (informational only) |
| `GET /api/props?sport=X&eventId=Y` | varies | VSiN props + live cross-book odds + alt prop ladder |
| `GET /api/scores?sport=X&daysFrom=3` | 1-2 credits | Final scores for completed games (Tracker auto-grading) |
| `POST /api/line-history?action=snapshot` | free | Store odds snapshot (KV-backed) |
| `GET /api/line-history?gameId=X` | free | Retrieve snapshots |
| `GET /api/line-history?action=movement&gameId=X` | free | Computed steam/RLM from server history |

Removed in v3.4: `/api/stats`, `/api/picks`.

