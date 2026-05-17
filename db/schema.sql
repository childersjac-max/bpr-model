-- ============================================================================
-- J LAB v4.0 — Research Workstation Schema
-- ============================================================================
-- Postgres-compatible (Vercel Postgres / Neon / Supabase / plain Postgres).
--
-- Design philosophy:
--   * Everything that is ever observed is stored, append-only, with a
--     timestamp. We never overwrite history; we add rows.
--   * Snapshots are the atomic unit. One row per (game, book, market, side,
--     poll). This is verbose on disk but it is the ONLY shape that lets us
--     reconstruct "what did the market look like at time T" and run honest
--     signal-attribution backtests later.
--   * Derived metrics (EV, de-vig fair prob, CLV) are computed and stored,
--     not recomputed on every read, so historical analysis is cheap.
--
-- All timestamps are stored as TIMESTAMPTZ in UTC.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- games — one row per event, ever seen. Updated in place for mutable meta
-- (commence_time can shift, final scores get filled in) but the row identity
-- is stable on the Odds API event id.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS games (
  id                TEXT PRIMARY KEY,              -- Odds API event id
  sport_key         TEXT NOT NULL,                 -- e.g. basketball_nba
  sport_title       TEXT,
  home_team         TEXT NOT NULL,
  away_team         TEXT NOT NULL,
  commence_time     TIMESTAMPTZ NOT NULL,
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Filled in by the scores cron once the game completes.
  completed         BOOLEAN NOT NULL DEFAULT FALSE,
  home_score        NUMERIC,
  away_score        NUMERIC,
  scored_at         TIMESTAMPTZ,
  -- Set TRUE once we have captured a genuine closing-line snapshot
  -- (last poll within the final pre-kickoff window).
  closing_captured  BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_games_sport_commence
  ON games (sport_key, commence_time);
CREATE INDEX IF NOT EXISTS idx_games_open_uncompleted
  ON games (commence_time) WHERE completed = FALSE;

-- ----------------------------------------------------------------------------
-- odds_snapshots — the append-only firehose. One row per
-- (game, book, market, side) per poll. A single /api/odds poll for an
-- 8-game NBA slate across 9 books and 3 markets writes ~ 8*9*3*2 ≈ 432 rows.
-- That is fine; Postgres eats this for breakfast and it is the price of
-- being able to do real history.
--
-- snapshot_batch ties together every row written by one cron tick so we can
-- ask "give me the market exactly as it was at batch X".
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS odds_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  snapshot_batch  BIGINT NOT NULL,                 -- epoch ms of the poll tick
  captured_at     TIMESTAMPTZ NOT NULL,
  game_id         TEXT NOT NULL REFERENCES games(id),
  sport_key       TEXT NOT NULL,
  book_key        TEXT NOT NULL,                   -- pinnacle, draftkings, ...
  is_sharp        BOOLEAN NOT NULL,
  market          TEXT NOT NULL,                   -- h2h | spreads | totals
  side            TEXT NOT NULL,                   -- team name | Over | Under
  american_odds   INTEGER NOT NULL,
  point           NUMERIC,                         -- NULL for h2h
  -- "secs old" relative to upstream last_update if available, else NULL.
  upstream_age_s  INTEGER,
  -- TRUE if this poll happened inside the closing-capture window.
  is_closing      BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_snap_game_batch
  ON odds_snapshots (game_id, snapshot_batch);
CREATE INDEX IF NOT EXISTS idx_snap_game_market_book
  ON odds_snapshots (game_id, market, book_key, captured_at);
CREATE INDEX IF NOT EXISTS idx_snap_batch
  ON odds_snapshots (snapshot_batch);
CREATE INDEX IF NOT EXISTS idx_snap_closing
  ON odds_snapshots (game_id, market) WHERE is_closing = TRUE;

-- ----------------------------------------------------------------------------
-- game_events — non-price information that the line "knows": injuries,
-- confirmed lineups, scratched starters, weather, news. Timestamped so we
-- can correlate a line move at time T with an event at time T-Δ and detect
-- "uninformed" moves (line moved but no public event yet → possible sharp
-- information).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS game_events (
  id            BIGSERIAL PRIMARY KEY,
  game_id       TEXT NOT NULL REFERENCES games(id),
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type    TEXT NOT NULL,    -- injury | lineup | scratch | weather | news
  severity      TEXT,             -- info | minor | major | game-changing
  payload       JSONB NOT NULL,   -- raw structured detail
  source        TEXT              -- rotowire | espn | noaa | manual | ...
);

CREATE INDEX IF NOT EXISTS idx_gevents_game_time
  ON game_events (game_id, observed_at);

-- ----------------------------------------------------------------------------
-- signal_events — derived market-structure signals: steam moves, reverse
-- line movement, sharp-vs-public divergence crossings. Computed by the
-- snapshot cron after each tick and persisted so backtests run over the
-- exact signals that fired in real time (no hindsight recomputation).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signal_events (
  id            BIGSERIAL PRIMARY KEY,
  game_id       TEXT NOT NULL REFERENCES games(id),
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  signal_type   TEXT NOT NULL,    -- steam | rlm | sharp_divergence | key_number
  market        TEXT NOT NULL,
  side          TEXT NOT NULL,
  strength      NUMERIC,          -- normalized 0..1 signal strength
  detail        JSONB NOT NULL    -- books moved, magnitude, window, etc.
);

CREATE INDEX IF NOT EXISTS idx_sigevents_game
  ON signal_events (game_id, signal_type, detected_at);

-- ----------------------------------------------------------------------------
-- lock_picks — every pick the model has EVER surfaced, with its full
-- evidence dossier captured AT THE MOMENT it was first generated. This is
-- the spine of honest signal attribution: we never edit the dossier, we
-- grade the outcome later, and we can ask "of all picks where signal X
-- fired, what was the realized ROI".
--
-- Dedup key: game_id|market|side|line (first snapshot wins, like v3.5).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lock_picks (
  id                BIGSERIAL PRIMARY KEY,
  dedup_key         TEXT NOT NULL UNIQUE,
  game_id           TEXT NOT NULL REFERENCES games(id),
  sport_key         TEXT NOT NULL,
  generated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  market            TEXT NOT NULL,            -- Moneyline | Spread | Total
  side              TEXT NOT NULL,
  line              NUMERIC,
  is_alt            BOOLEAN NOT NULL DEFAULT FALSE,
  -- pricing at generation time
  bet_american      INTEGER NOT NULL,         -- best public price we surfaced
  bet_book          TEXT,
  sharp_american    INTEGER,                  -- sharp side price used
  sharp_book        TEXT,
  fair_prob         NUMERIC,                  -- de-vigged sharp fair prob
  ev_pct            NUMERIC,
  -- transparent score decomposition (the v4 generator output)
  score_total       NUMERIC,
  score_price       NUMERIC,
  score_steam       NUMERIC,
  score_rlm         NUMERIC,
  score_xmarket     NUMERIC,
  score_alt         NUMERIC,
  penalty_stale     NUMERIC,
  penalty_news      NUMERIC,
  -- full evidence dossier at generation time (immutable)
  dossier           JSONB NOT NULL,
  -- grading (filled in later by scores cron / manual)
  graded            BOOLEAN NOT NULL DEFAULT FALSE,
  result            TEXT,                     -- win | loss | push | void
  graded_at         TIMESTAMPTZ,
  graded_by         TEXT,                     -- auto | manual
  units_pl          NUMERIC,                  -- realized P/L in units at bet_american
  -- true CLV, filled when closing line is captured
  closing_fair_prob NUMERIC,
  clv_prob_pts      NUMERIC,                  -- fair_prob improvement vs close
  clv_pct           NUMERIC
);

CREATE INDEX IF NOT EXISTS idx_locks_game
  ON lock_picks (game_id);
CREATE INDEX IF NOT EXISTS idx_locks_ungraded
  ON lock_picks (sport_key) WHERE graded = FALSE;
CREATE INDEX IF NOT EXISTS idx_locks_sport_market
  ON lock_picks (sport_key, market, generated_at);

-- ----------------------------------------------------------------------------
-- placed_bets — bets YOU actually made (logged from the betslip). Separate
-- from lock_picks because "did the model work" and "did MY bets work" are
-- different questions, exactly as the v3.5 README argued.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS placed_bets (
  id                BIGSERIAL PRIMARY KEY,
  game_id           TEXT NOT NULL REFERENCES games(id),
  placed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  market            TEXT NOT NULL,
  side              TEXT NOT NULL,
  line              NUMERIC,
  stake_units       NUMERIC NOT NULL DEFAULT 1,
  bet_american      INTEGER NOT NULL,
  bet_book          TEXT,
  bet_fair_prob     NUMERIC,                  -- sharp fair prob at bet time
  bet_ev_pct        NUMERIC,
  -- closing capture
  closing_fair_prob NUMERIC,
  clv_prob_pts      NUMERIC,
  clv_pct           NUMERIC,
  -- grading
  graded            BOOLEAN NOT NULL DEFAULT FALSE,
  result            TEXT,
  units_pl          NUMERIC,
  graded_at         TIMESTAMPTZ,
  notes             TEXT
);

CREATE INDEX IF NOT EXISTS idx_bets_game ON placed_bets (game_id);
CREATE INDEX IF NOT EXISTS idx_bets_ungraded
  ON placed_bets (game_id) WHERE graded = FALSE;

-- ----------------------------------------------------------------------------
-- game_notes — persistent free-text reasoning per game. Because J LAB is
-- "one of many tools", you need somewhere to capture the synthesis across
-- tools that survives device changes.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS game_notes (
  game_id     TEXT PRIMARY KEY REFERENCES games(id),
  body        TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- schema_meta — single-row table tracking applied migration version so the
-- setup endpoint is idempotent and we can evolve the schema safely.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_meta (
  id            INTEGER PRIMARY KEY DEFAULT 1,
  version       INTEGER NOT NULL,
  applied_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT one_row CHECK (id = 1)
);
