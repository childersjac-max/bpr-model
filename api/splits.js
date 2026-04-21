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
    const r = await fetch(
      `https://api.actionnetwork.com/web/v1/games?sport=${an}&date=upcoming`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.actionnetwork.com' } }
    );
    const data = await r.json();
    res.status(200).json(data.games || []);
  } catch(e) {
    res.status(200).json([]);
  }
}
