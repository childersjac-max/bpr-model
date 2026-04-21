export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { sport } = req.query;
  const sportMap = {
    baseball_mlb: '3',
    basketball_nba: '4',
    americanfootball_nfl: '2',
    icehockey_nhl: '6',
    mma_mixed_martial_arts: '7'
  };
  const id = sportMap[sport];
  if (!id) return res.status(200).json({ events: [] });
  const KEY = 'ed0122b0ba463eecf5465b9f935a582a8b0d9c1d7a1fd21302750c8be24d80b9';
  try {
    const today = new Date().toISOString().split('T')[0];
    const r = await fetch(
      `https://therundown.io/api/v2/sports/${id}/events/${today}?include=betting_splits`,
      { headers: { 'Authorization': `Bearer ${KEY}` } }
    );
    const data = await r.json();
    res.status(200).json(data);
  } catch(e) {
    res.status(200).json({ error: e.message });
  }
}
