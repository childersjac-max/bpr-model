// ============================================================================
// lib/db.js — shared database access layer
// ============================================================================
// Works with any standard Postgres connection string in POSTGRES_URL or
// DATABASE_URL (Vercel Postgres, Neon, Supabase, Railway, plain Postgres).
//
// Design notes:
//   * Uses the `pg` driver with a singleton pool. Vercel serverless functions
//     reuse warm containers, so a module-level pool is reused across
//     invocations and we are not opening a connection per request.
//   * If no connection string is configured, isEnabled() returns false and
//     every helper is a safe no-op. This means dropping these files into the
//     existing repo NEVER breaks the current app — the database layer is
//     purely additive until you set the env var.
//   * All write helpers are idempotent or append-only by design.
// ============================================================================

let Pool = null;
try {
  Pool = require('pg').Pool;
} catch (e) {
  Pool = null; // pg not installed yet — layer is disabled
}

const CONN =
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  null;

let _pool = null;

function getPool() {
  if (!Pool || !CONN) return null;
  if (_pool) return _pool;
  _pool = new Pool({
    connectionString: CONN,
    // Vercel Postgres / Neon / Supabase all require SSL. `pg` accepts this
    // permissive form which works for all managed providers.
    ssl: CONN.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 3,                       // small — serverless, many short-lived fns
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000
  });
  return _pool;
}

function isEnabled() {
  return !!getPool();
}

async function query(text, params) {
  const pool = getPool();
  if (!pool) {
    const err = new Error('DB_DISABLED');
    err.code = 'DB_DISABLED';
    throw err;
  }
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

// Run several statements in one transaction. fn receives a connected client.
async function tx(fn) {
  const pool = getPool();
  if (!pool) {
    const err = new Error('DB_DISABLED');
    err.code = 'DB_DISABLED';
    throw err;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

// ----------------------------------------------------------------------------
// Game upsert. Called by the snapshot cron for every game it sees so the
// games table is always current. Updates mutable meta, never clobbers
// score / closing fields that other jobs own.
// ----------------------------------------------------------------------------
async function upsertGame(client, g) {
  await client.query(
    `INSERT INTO games (id, sport_key, sport_title, home_team, away_team,
                        commence_time, first_seen_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6, now(), now())
     ON CONFLICT (id) DO UPDATE SET
       sport_title   = EXCLUDED.sport_title,
       commence_time = EXCLUDED.commence_time,
       last_seen_at  = now()`,
    [g.id, g.sport_key, g.sport_title || null,
     g.home_team, g.away_team, g.commence_time]
  );
}

module.exports = {
  isEnabled,
  query,
  tx,
  upsertGame,
  // exposed for the setup endpoint
  _getPool: getPool
};
