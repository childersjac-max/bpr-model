// ============================================================================
// /api/db-setup — idempotent schema initialization & health check
// ============================================================================
// GET  /api/db-setup            -> health: is the DB reachable, what version
// POST /api/db-setup?token=...   -> apply schema.sql (CREATE TABLE IF NOT
//                                   EXISTS, safe to run repeatedly)
//
// Protected by SETUP_TOKEN env var so a random visitor can't hammer it.
// If the DB layer is disabled (no POSTGRES_URL) this reports cleanly instead
// of 500-ing, so the rest of the app is unaffected.
// ============================================================================

const fs = require('fs');
const path = require('path');
const db = require('../lib/db');

const SCHEMA_VERSION = 1;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (!db.isEnabled()) {
    return res.status(200).json({
      enabled: false,
      note: 'No POSTGRES_URL / DATABASE_URL configured. The v4 data layer ' +
            'is dormant and the existing app is unaffected. Set the env var ' +
            'and POST here to initialize.'
    });
  }

  // --- health check ---
  if (req.method === 'GET') {
    try {
      const r = await db.query(
        `SELECT version, applied_at FROM schema_meta WHERE id = 1`
      );
      const games = await db.query(`SELECT count(*)::int n FROM games`);
      const snaps = await db.query(
        `SELECT count(*)::int n FROM odds_snapshots`
      );
      return res.status(200).json({
        enabled: true,
        initialized: r.rows.length > 0,
        schema_version: r.rows[0]?.version ?? null,
        applied_at: r.rows[0]?.applied_at ?? null,
        games: games.rows[0].n,
        odds_snapshots: snaps.rows[0].n
      });
    } catch (e) {
      // tables don't exist yet → not initialized
      if (/relation .* does not exist/i.test(e.message)) {
        return res.status(200).json({
          enabled: true, initialized: false,
          note: 'Schema not yet applied. POST to this endpoint with ?token.'
        });
      }
      return res.status(500).json({ enabled: true, error: e.message });
    }
  }

  if (req.method === 'POST') {
    const token = req.query.token;
    if (!process.env.SETUP_TOKEN || token !== process.env.SETUP_TOKEN) {
      return res.status(403).json({ error: 'invalid or missing setup token' });
    }
    try {
      const sql = fs.readFileSync(
        path.join(process.cwd(), 'db', 'schema.sql'), 'utf8'
      );
      await db.query(sql);
      await db.query(
        `INSERT INTO schema_meta (id, version, applied_at)
           VALUES (1, $1, now())
         ON CONFLICT (id) DO UPDATE SET
           version = EXCLUDED.version, applied_at = now()`,
        [SCHEMA_VERSION]
      );
      return res.status(200).json({
        ok: true, schema_version: SCHEMA_VERSION,
        note: 'Schema applied. Safe to call again anytime.'
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'GET or POST only' });
};
