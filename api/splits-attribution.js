// POST /api/splits-attribution
// Body: { entries: [...trackerLog], minN?: number }
// Returns empirical splits scenario analysis + glossary (no Odds API credits).

const { analyzeSplitsAttribution, GLOSSARY, DEFAULT_MIN_N } = require('../lib/splits-attribution');

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    return res.status(200).json({
      endpoint: '/api/splits-attribution',
      method: 'POST',
      body: { entries: 'tracker log array', minN: `optional, default ${DEFAULT_MIN_N}` },
      glossary: GLOSSARY
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'GET for docs, POST for analysis' });
  }

  try {
    const body = await readBody(req);
    const entries = body.entries || [];
    const minN = body.minN;
    const report = analyzeSplitsAttribution(entries, { minN });
    return res.status(200).json(report);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
};
