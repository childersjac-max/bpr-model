# J LAB v4.0 — Phase 1: Data Foundation

This is the foundation everything else in the rebuild depends on: a
server-side database, continuous market capture independent of the browser,
true closing-line CLV, and an honest signal-attribution engine.

**Nothing here breaks the existing v3.5 app.** The entire data layer is
dormant until you set `POSTGRES_URL`. With no database configured, every new
endpoint is a clean no-op and the current J LAB keeps working exactly as
before.

---

## What got built in Phase 1

| File | Purpose |
| --- | --- |
| `db/schema.sql` | 8 append-only tables + indexes. Games, the odds-snapshot firehose, game events, signal events, lock picks (with immutable evidence dossier), placed bets, notes, schema versioning. |
| `lib/db.js` | Shared Postgres access layer. Singleton pool, transactions, graceful disable when no DB configured. |
| `lib/odds-math.js` | Canonical betting math (de-vig, EV, half-Kelly, true CLV, score grading, units P/L) lifted server-side so crons and analytics compute identically. Unit-tested. |
| `lib/books.js` | Single source of truth for sharp/public book classification + Odds API flattening. |
| `api/db-setup.js` | Idempotent schema init + health check (token-protected). |
| `api/cron/snapshot.js` | **The core job.** Hourly: pulls the board for active sports, writes one append-only row per (game,book,market,side), upserts games, flags closing-window polls, records hour-over-hour multi-book moves. See the cadence caveat below — hourly polling is a deliberate research-mode trade-off, not a limitation. |
| `api/cron/closing.js` | Every 5 min: promotes the last pre-kickoff snapshot to the canonical closing line, backfills **true CLV** on every pick and placed bet. |
| `api/cron/grade.js` | Every 15 min: fetches final scores, auto-grades ML/spread/total picks & bets, records realized units P/L at the price actually taken. |
| `api/attribution.js` | The analytical payoff: signal-by-signal and signal-combination ROI **with 95% confidence intervals** and explicit insufficient-sample flagging. |

---

## One-time setup

1. **Add a Postgres database.** In Vercel: Storage → Create → Postgres
   (or attach Neon / Supabase / Railway). It will populate `POSTGRES_URL`
   automatically. Any standard Postgres connection string in `POSTGRES_URL`,
   `DATABASE_URL`, or `POSTGRES_PRISMA_URL` works.

2. **Set two secrets** in Vercel → Settings → Environment Variables:
   - `SETUP_TOKEN` — any long random string (protects schema init)
   - `CRON_TOKEN` — any long random string (lets you trigger crons manually
     for testing; Vercel Cron itself is authenticated automatically)

3. **Deploy**, then initialize the schema (idempotent — safe to repeat):
   ```
   curl -X POST "https://<your-app>.vercel.app/api/db-setup?token=<SETUP_TOKEN>"
   ```

4. **Verify health:**
   ```
   curl "https://<your-app>.vercel.app/api/db-setup"
   ```
   You should see `initialized: true`, `schema_version: 1`.

5. **Crons start automatically** on the next deploy (defined in
   `vercel.json`). To smoke-test immediately without waiting:
   ```
   curl "https://<your-app>.vercel.app/api/cron/snapshot?token=<CRON_TOKEN>"
   ```

> The crons run **hourly**, staggered within the hour (snapshot at :00,
> closing at :20, grade at :40). Hourly cadence runs fine on Vercel's Hobby
> plan — no Pro plan required.

---

## Cadence trade-off (read this)

Hourly polling is a deliberate choice for deliberate, next-day research. It
is honest to be explicit about what it costs versus minute-level polling:

- **Steam is not detectable.** Genuine steam is a 3+ sharp-book move inside
  a ~5-minute window. At hourly snapshots you only see the net hourly
  change, which blends steam with slow drift. The detector still fires and
  still records `signal_type='steam'`, but at this cadence treat it as
  "multiple books moved the same way over the last hour" — a weaker, slower
  sharp-alignment signal. Weight it accordingly in attribution.
- **CLV is a coarser proxy.** The closing window was widened from 12 to 75
  minutes so that at hourly cadence most games still get a near-close poll.
  This is the last poll within ~1h15m of kickoff, not the textbook
  12-minutes-out closing line. CLV from it is good for *relative* comparison
  across your own picks; it is a weaker *absolute* edge claim than true
  closing-line CLV. The numbers are directionally meaningful, not
  publication-grade.
- **RLM and line-history still work**, just at hourly resolution — fine for
  research-mode use, blind to intraday moves that reverse within the hour.

If you later want genuine steam and true closing-line CLV, the only change
needed is the snapshot schedule in `vercel.json` (e.g. `*/2 * * * *`) and
narrowing `CLOSING_WINDOW_MIN` back toward 12 in `api/cron/snapshot.js`.
Nothing else in the schema or pipeline changes.

---

## Quota note

The snapshot cron polls only sports with a game inside an 18-hour lookahead
window, so off-season / overnight cost is ~zero. During an active slate it
costs the same per poll as the existing `/api/odds` (3 credits/region). At
**hourly** polling this is dramatically less quota than minute-level capture
— typically a few dozen credits per active sport per day — while still
giving you a continuous market record you cannot reconstruct any other way.

---

## What you can do once it has run for a while

After the crons have collected graded picks across some slates:

```
curl "https://<your-app>.vercel.app/api/attribution?minN=200"
curl "https://<your-app>.vercel.app/api/attribution?sport=basketball_nba&market=Spread"
```

This answers your original question with **your own data, not estimates**:
which signals (steam, RLM, cross-market agreement, alt-line edges) and which
*combinations* actually produced positive ROI and CLV — each with a 95%
confidence interval, with anything under the sample threshold explicitly
flagged unreliable. `avg_clv_pct` is the leading indicator; it stabilizes
long before ROI does.

---

## What is intentionally NOT in Phase 1

Per the build plan, Phase 1 is the foundation only. Still to come:

- **Phase 2:** direct Pinnacle/Circa freshness scrape; injury/lineup/weather
  ingestion into `game_events`; persisted splits history.
- **Phase 3:** the per-game research dossier UI (new primary surface,
  movement charts with sharp/public separation, persistent notes).
- **Phase 4:** the configurable transparent-weight pick generator that writes
  the immutable `dossier` consumed by `/api/attribution`; calibration plots.

Phase 4 closes the loop: the pick generator must stamp each pick's
`dossier.signals` object (`steam`/`rlm`/`xmarket`/`alt`/`stale` booleans) so
attribution can slice by them. The schema and attribution endpoint already
expect that shape, so Phase 4 plugs in without further migration.
