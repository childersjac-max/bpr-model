export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=1800'); // cache 30 mins

  const sources = [
    {
      name: 'Docs Sports',
      url: 'https://www.docsports.com/free-picks.html',
      selector: 'free picks'
    },
    {
      name: 'Covers',
      url: 'https://www.covers.com/picks/expert',
      selector: 'expert picks'
    }
  ];

  try {
    const picks = [];

    // Fetch Covers expert picks
    const coversResp = await fetch('https://www.covers.com/picks/expert', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });
    const coversHtml = await coversResp.text();

    // Extract pick data using regex patterns
    const pickPattern = /data-pick="([^"]+)"[^>]*data-sport="([^"]+)"[^>]*data-expert="([^"]+)"[^>]*data-confidence="([^"]+)"/g;
    let match;
    while ((match = pickPattern.exec(coversHtml)) !== null) {
      picks.push({
        pick: match[1],
        sport: match[2],
        expert: match[3],
        confidence: parseInt(match[4]),
        source: 'Covers'
      });
    }

    // Also try Docs Sports free picks RSS
    const docsResp = await fetch('https://www.docsports.com/free-sports-picks-rss.xml', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      }
    });
    const docsXml = await docsResp.text();

    // Parse RSS items
    const itemPattern = /<item>([\s\S]*?)<\/item>/g;
    const titlePattern = /<title><!\[CDATA\[(.*?)\]\]><\/title>/;
    const descPattern = /<description><!\[CDATA\[(.*?)\]\]><\/description>/;
    let itemMatch;
    while ((itemMatch = itemPattern.exec(docsXml)) !== null) {
      const item = itemMatch[1];
      const titleMatch = titlePattern.exec(item);
      const descMatch = descPattern.exec(item);
      if (titleMatch && descMatch) {
        const title = titleMatch[1].trim();
        const desc = descMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 200);
        // Only include if it looks like a 5-star or high confidence pick
        if (title.toLowerCase().includes('5 star') ||
            title.toLowerCase().includes('5-star') ||
            title.toLowerCase().includes('best bet') ||
            title.toLowerCase().includes('lock') ||
            title.toLowerCase().includes('top pick')) {
          picks.push({
            pick: title,
            detail: desc,
            confidence: 5,
            source: "Doc's Sports",
            sport: title.match(/\b(MLB|NBA|NFL|NHL|UFC|MMA|NCAAB|NCAAF)\b/i)?.[1]?.toUpperCase() || 'Sports'
          });
        }
      }
    }

    res.status(200).json({ picks, updated: new Date().toISOString() });
  } catch(e) {
    res.status(200).json({ picks: [], error: e.message });
  }
}
