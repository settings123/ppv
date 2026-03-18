const express = require('express');
const fetch = require('node-fetch');
const puppeteer = require('puppeteer');
const app = express();

const PORT = process.env.PORT || 7000;
const HOST = process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${PORT}`;

// Categories we support
const SUPPORTED_CATEGORIES = ['Basketball', 'Football', 'Ice Hockey', 'Motorsports', 'Wrestling', '24/7 Streams'];

// Stremio manifest
const MANIFEST = {
  id: 'com.ppvto.stremio',
  version: '1.0.0',
  name: 'PPV.to',
  description: 'Live sports streams from ppv.to — Basketball, Football, Hockey & more',
  types: ['tv'],
  catalogs: [
    {
      type: 'tv',
      id: 'ppvto-live',
      name: 'PPV.to Live',
      extra: [{ name: 'genre', isRequired: false }],
      genres: SUPPORTED_CATEGORIES
    }
  ],
  resources: ['catalog', 'meta', 'stream'],
  idPrefixes: ['ppvto:']
};

// Add CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

// Manifest endpoint
app.get('/manifest.json', (req, res) => {
  res.json(MANIFEST);
});

// Fetch all streams from ppv.to API
async function fetchStreams() {
  const res = await fetch('https://api.ppv.to/api/streams', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://ppv.to/'
    }
  });
  const data = await res.json();
  return data.streams || [];
}

// Flatten all streams into a single list
function flattenStreams(categories) {
  const all = [];
  for (const cat of categories) {
    for (const stream of cat.streams || []) {
      all.push({ ...stream, category_name: cat.category });
    }
  }
  return all;
}

// Format a stream as a Stremio meta object
function streamToMeta(stream) {
  const now = Math.floor(Date.now() / 1000);
  const isLive = stream.always_live || (stream.starts_at <= now && stream.ends_at >= now);
  const isUpcoming = stream.starts_at > now;

  let name = stream.name;
  if (isLive) name = '🔴 ' + name;
  else if (isUpcoming) name = '🕐 ' + name;

  return {
    id: 'ppvto:' + stream.id,
    type: 'tv',
    name,
    poster: stream.poster || '',
    background: stream.poster || '',
    description: `${stream.tag} — ${stream.category_name}`,
    genres: [stream.category_name],
    releaseInfo: isLive ? 'LIVE' : isUpcoming ? new Date(stream.starts_at * 1000).toLocaleString() : 'Ended'
  };
}

// Catalog endpoint
app.get('/catalog/tv/ppvto-live.json', async (req, res) => {
  try {
    const categories = await fetchStreams();
    const streams = flattenStreams(categories);
    const genre = req.query.genre;

    const filtered = genre
      ? streams.filter(s => s.category_name === genre)
      : streams;

    const metas = filtered.map(streamToMeta);
    res.json({ metas });
  } catch (e) {
    console.error('Catalog error:', e);
    res.json({ metas: [] });
  }
});

// Meta endpoint
app.get('/meta/tv/:id.json', async (req, res) => {
  try {
    const streamId = req.params.id.replace('ppvto:', '');
    const categories = await fetchStreams();
    const streams = flattenStreams(categories);
    const stream = streams.find(s => String(s.id) === streamId);

    if (!stream) return res.json({ meta: {} });

    res.json({ meta: streamToMeta(stream) });
  } catch (e) {
    console.error('Meta error:', e);
    res.json({ meta: {} });
  }
});

// Extract m3u8 URL from pooembed page using Puppeteer
async function extractM3u8FromEmbed(iframeUrl) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();

    // Intercept network requests to catch the m3u8 URL
    let m3u8Url = null;

    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = request.url();
      // Capture index.m3u8 from modifiles CDN
      if (url.includes('modifiles') && url.includes('index.m3u8')) {
        m3u8Url = url;
      }
      // Block ads and unnecessary resources to speed things up
      const resourceType = request.resourceType();
      if (['image', 'font', 'stylesheet'].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    await page.setExtraHTTPHeaders({
      'Referer': 'https://ppv.to/'
    });

    await page.goto(iframeUrl, { waitUntil: 'networkidle2', timeout: 20000 });

    // Wait up to 10 more seconds for the m3u8 to appear
    if (!m3u8Url) {
      await new Promise(resolve => {
        const interval = setInterval(() => {
          if (m3u8Url) { clearInterval(interval); resolve(); }
        }, 500);
        setTimeout(() => { clearInterval(interval); resolve(); }, 10000);
      });
    }

    return m3u8Url;
  } catch (e) {
    console.error('Puppeteer extraction error:', e.message);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

// Proxy m3u8 endpoint — rewrites .jpg segments to .ts
app.get('/proxy/m3u8', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('Missing url');

  try {
    const m3u8Res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://pooembed.eu/',
        'Origin': 'https://pooembed.eu'
      }
    });

    let content = await m3u8Res.text();

    // Rewrite .jpg? to .ts? so players accept the segments
    content = content.replace(/\.jpg\?/g, '.ts?');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(content);
  } catch (e) {
    console.error('Proxy error:', e);
    res.status(500).send('Proxy error');
  }
});

// Stream endpoint
app.get('/stream/tv/:id.json', async (req, res) => {
  try {
    const streamId = req.params.id.replace('ppvto:', '');
    const categories = await fetchStreams();
    const streams = flattenStreams(categories);
    const stream = streams.find(s => String(s.id) === streamId);

    if (!stream) return res.json({ streams: [] });

    // Build list of sources to try (main + substreams)
    const sources = [stream, ...(stream.substreams || [])];
    const results = [];

    for (const source of sources) {
      const iframeUrl = source.iframe;
      if (!iframeUrl) continue;

      console.log(`Extracting m3u8 for: ${iframeUrl}`);
      const m3u8Url = await extractM3u8FromEmbed(iframeUrl);
      if (!m3u8Url) {
        console.log(`No m3u8 found for: ${iframeUrl}`);
        continue;
      }

      console.log(`Found m3u8: ${m3u8Url}`);

      // Point to our proxy which rewrites .jpg to .ts
      const proxyUrl = `${HOST}/proxy/m3u8?url=${encodeURIComponent(m3u8Url)}`;

      results.push({
        name: source.tag || source.name || 'Stream',
        title: source.name || stream.name,
        url: proxyUrl
      });
    }

    res.json({ streams: results });
  } catch (e) {
    console.error('Stream error:', e);
    res.json({ streams: [] });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ PPV.to Stremio Addon running!`);
  console.log(`\n👉 Add this URL to Stremio:`);
  console.log(`   ${HOST}/manifest.json\n`);
});
