const express = require('express');
const fetch = require('node-fetch');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const app = express();

const PORT = process.env.PORT || 7000;
const HOST = process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${PORT}`;

const SUPPORTED_CATEGORIES = ['Basketball', 'Football', 'Ice Hockey', 'Motorsports', '24/7 Streams'];

const MANIFEST = {
  id: 'com.ppvto.stremio',
  version: '1.0.1',
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

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

// Install page
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>PPV.to Stremio Addon</title></head>
      <body style="font-family:sans-serif;text-align:center;padding:50px;background:#1a1a2e;color:white">
        <h1 style="color:#7b5ea7">PPV.to Stremio Addon</h1>
        <p>Live sports — Basketball, Football, Hockey & more</p>
        <br>
        <a href="stremio://${req.headers.host}/manifest.json">
          <button style="padding:15px 30px;font-size:18px;background:#7b5ea7;color:white;border:none;border-radius:8px;cursor:pointer">
            Install in Stremio
          </button>
        </a>
        <br><br>
        <p style="color:#888;font-size:13px">Or manually add this URL in Stremio:<br>
        <code style="color:#aaa">https://${req.headers.host}/manifest.json</code></p>
      </body>
    </html>
  `);
});

app.get('/manifest.json', (req, res) => {
  res.json(MANIFEST);
});

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

function flattenStreams(categories) {
  const all = [];
  const now = Math.floor(Date.now() / 1000);
  const eightHoursFromNow = now + (8 * 60 * 60);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayTimestamp = Math.floor(startOfToday.getTime() / 1000);

  for (const cat of categories) {
    if (!SUPPORTED_CATEGORIES.includes(cat.category)) continue;
    for (const stream of cat.streams || []) {
      if (stream.always_live) {
        all.push({ ...stream, category_name: cat.category });
        continue;
      }
      const isLive = stream.starts_at <= now && stream.ends_at >= now;
      const startsWithin8Hours = stream.starts_at <= eightHoursFromNow && stream.starts_at >= now;
      const startedToday = stream.starts_at >= todayTimestamp;
      if (isLive || startsWithin8Hours || startedToday) {
        all.push({ ...stream, category_name: cat.category });
      }
    }
  }
  return all;
}

function colorBackground(colors) {
  const c1 = (colors && colors[0]) ? colors[0] : '#1a1a2e';
  const c2 = (colors && colors[1]) ? colors[1] : '#16213e';
  return `${HOST}/bg?c1=${encodeURIComponent(c1)}&c2=${encodeURIComponent(c2)}`;
}

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
    posterShape: 'landscape',
    background: colorBackground(stream.colors),
    logo: stream.poster || '',
    description: `${stream.tag} — ${stream.category_name}`,
    genres: [stream.category_name],
    releaseInfo: (() => {
      if (isLive) return 'LIVE';
      if (!isUpcoming) return 'Ended';
      // Convert to EST (UTC-5) / EDT (UTC-4)
      const d = new Date(stream.starts_at * 1000);
      try {
        return d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true, month: 'short', day: 'numeric' });
      } catch(e) {
        // Fallback: manual EST offset (UTC-5)
        const est = new Date(d.getTime() - (5 * 60 * 60 * 1000));
        const h = est.getUTCHours();
        const m = est.getUTCMinutes().toString().padStart(2, '0');
        const ampm = h >= 12 ? 'PM' : 'AM';
        const h12 = h % 12 || 12;
        return `${est.getUTCMonth()+1}/${est.getUTCDate()} ${h12}:${m} ${ampm} ET`;
      }
    })()
  };
}

app.get('/catalog/tv/ppvto-live.json', async (req, res) => {
  try {
    const categories = await fetchStreams();
    const streams = flattenStreams(categories);
    const genre = req.query.genre;
    const filtered = genre ? streams.filter(s => s.category_name === genre) : streams;
    res.json({ metas: filtered.map(streamToMeta) });
  } catch (e) {
    console.error('Catalog error:', e);
    res.json({ metas: [] });
  }
});

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

// Gradient background endpoint
app.get('/bg', (req, res) => {
  const c1 = req.query.c1 || '#1a1a2e';
  const c2 = req.query.c2 || '#16213e';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
    <defs>
      <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:${c1};stop-opacity:1" />
        <stop offset="100%" style="stop-color:${c2};stop-opacity:1" />
      </linearGradient>
    </defs>
    <rect width="1920" height="1080" fill="url(#g)"/>
  </svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(svg);
});

// Sub-playlist proxy - fetches mono.ts.m3u8 and rewrites .jpg to .ts
app.get('/cached-sub/:url', async (req, res) => {
  const url = decodeURIComponent(req.params.url);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://pooembed.eu/',
        'Origin': 'https://pooembed.eu'
      }
    });
    let text = await r.text();
    text = text.replace(/\.jpg(\?)/g, '.ts$1');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(text);
  } catch(e) {
    res.status(500).send('Error');
  }
});

// In-memory cache
const m3u8Cache = {};
const m3u8IframeMap = {};

// Serve cached m3u8
app.get('/cached-m3u8/:key', (req, res) => {
  const cached = m3u8Cache[req.params.key];
  if (!cached) return res.status(404).send('Expired or not found');
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.send(cached);
});

// Debug endpoint
app.get('/debug-cache', (req, res) => {
  const keys = Object.keys(m3u8Cache);
  if (keys.length === 0) return res.send('Cache empty');
  const latest = keys[keys.length - 1];
  res.setHeader('Content-Type', 'text/plain');
  res.send(m3u8Cache[latest]);
});

// Background refresh — launches fresh browser every 20 seconds, bypasses queue
async function startRefreshing(cacheKey, iframeUrl) {
  while (m3u8Cache[cacheKey] !== undefined) {
    await new Promise(r => setTimeout(r, 20000));
    if (m3u8Cache[cacheKey] === undefined) break;
    try {
      console.log(`Refreshing: ${cacheKey}`);
      const result = await _extractM3u8(iframeUrl);
      if (result && result.content) {
        m3u8Cache[cacheKey] = result.content.replace(/\.jpg(?=\?)/g, '.ts');
        console.log(`Refreshed: ${cacheKey}`);
      }
    } catch (e) {
      console.error('Refresh error:', e.message);
    }
  }
}

// Queue to prevent multiple Puppeteer instances running simultaneously
let puppeteerQueue = Promise.resolve();

async function extractM3u8FromEmbed(iframeUrl) {
  const result = await (puppeteerQueue = puppeteerQueue.then(() => _extractM3u8(iframeUrl)));
  return result;
}

async function _extractM3u8(iframeUrl) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    const page = await browser.newPage();
    let m3u8Content = null;
    let m3u8Url = null;

    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = request.url();
      if (url.includes('modifiles') && url.includes('index.m3u8')) {
        m3u8Url = url;
      }
      const resourceType = request.resourceType();
      if (['image', 'font', 'stylesheet'].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    page.on('response', async response => {
      const url = response.url();
      if (url.includes('modifiles') && url.includes('mono.ts.m3u8')) {
        try {
          const text = await response.text();
          m3u8Content = text;
          console.log('Captured mono.ts.m3u8 content, length:', text.length);
        } catch (e) {
          console.log('Could not read mono.ts.m3u8:', e.message);
        }
      }
    });

    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('requestfailed', request => {
      console.log('FAILED:', request.url(), request.failure().errorText);
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Referer': 'https://ppv.to/' });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    });

    await page.goto(iframeUrl, { waitUntil: 'networkidle2', timeout: 20000 });

    if (!m3u8Content) {
      await new Promise(resolve => {
        const interval = setInterval(() => {
          if (m3u8Content) { clearInterval(interval); resolve(); }
        }, 500);
        setTimeout(() => { clearInterval(interval); resolve(); }, 20000);
      });
    }

    return { url: m3u8Url, content: m3u8Content };
  } catch (e) {
    console.error('Puppeteer error:', e.message);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

app.get('/stream/tv/:id.json', async (req, res) => {
  try {
    const streamId = req.params.id.replace('ppvto:', '');
    const categories = await fetchStreams();
    const streams = flattenStreams(categories);
    const stream = streams.find(s => String(s.id) === streamId);
    if (!stream) return res.json({ streams: [] });

    const sources = [stream, ...(stream.substreams || [])];
    const results = [];

    for (const source of sources) {
      const iframeUrl = source.iframe;
      if (!iframeUrl) continue;
      console.log(`Extracting: ${iframeUrl}`);
      const result = await extractM3u8FromEmbed(iframeUrl);
      if (!result || !result.content) { console.log('No m3u8 content'); continue; }
      console.log(`Found: ${result.url}`);

      const cacheKey = `${streamId}_${source.id || 0}`;
      m3u8Cache[cacheKey] = result.content.replace(/\.jpg(?=\?)/g, '.ts');
      m3u8IframeMap[cacheKey] = iframeUrl;

      // Auto-expire after 4 hours
      setTimeout(() => {
        delete m3u8Cache[cacheKey];
        delete m3u8IframeMap[cacheKey];
      }, 4 * 60 * 60 * 1000);

      // Start background refresh
      startRefreshing(cacheKey, iframeUrl);

      const proxyUrl = `${HOST}/cached-m3u8/${cacheKey}`;
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
  console.log(`   ${HOST}/manifest.json\n`);
});
