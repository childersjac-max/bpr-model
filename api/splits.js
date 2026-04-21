export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { sport } = req.query;
  const sportMap = {
    baseball_mlb: 'mlb',
    basketball_nba: 'nba',
    americanfootball_nfl: 'nfl',
    icehockey_nhl: 'nhl',
    mma_mixed_martial_arts: 'mma'
  };
  const an = sportMap[sport];
  if (!an) return res.status(200).json([]);
  try {
    const today = new Date().toISOString().split('T')[0].replace(/-/g,'');
    const r = await fetch(
      `https://api.actionnetwork.com/web/v1/games?sport=${an}&date=${today}`,
      { headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'Referer': 'https://www.actionnetwork.com/',
        'Accept': 'application/json'
      }}
    );
    const text = await r.text();
    const data = JSON.parse(text);
    // Return full raw response so frontend can parse it
    res.status(200).json(data);
  } catch(e) {
    res.status(200).json({ error: e.message });
  }
}
