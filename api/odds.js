export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const KEY = '056939ecab105dc266b1ef43eb8b3eba';
  const { sport } = req.query;
  if (!sport) return res.status(400).json({ error: 'sport required' });
  const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${KEY}&regions=us,eu&markets=h2h,spreads,totals&bookmakers=pinnacle,draftkings,fanduel,betmgm,fanatics&oddsFormat=american`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await r.json();
    res.status(200).json(data);
  } catch(e) {
    res.status(200).json([]);
  }
}
