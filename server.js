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
  version: '1.0.4',
  name: 'PPV.to',
  description: 'Live sports streams from ppv.to',
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
        <p style="color:#888;font-size:13px">Or manually add:<br>
        <code style="color:#aaa">https://${req.headers.host}/manifest.json</code></p>
      </body>
    </html>
  `);
});

app.get('/manifest.json', (req, res) => res.json(MANIFEST));

async function fetchStreams() {
  const res = await fetch('https://api.ppv.to/api/streams', {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://ppv.to/' }
  });
  const data = await res.json();
  return data.streams || [];
}

function toEST(timestamp) {
  const estMs = timestamp * 1000 - (5 * 60 * 60 * 1000);
  const est = new Date(estMs);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let h = est.getUTCHours();
  const m = est.getUTCMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${months[est.getUTCMonth()]} ${est.getUTCDate()}, ${h}:${m} ${ampm} ET`;
}

function flattenStreams(categories) {
  const all = [];
  const now = Math.floor(Date.now() / 1000);
  const eightHoursFromNow = now + (8 * 60 * 60);

  for (const cat of categories) {
    if (!SUPPORTED_CATEGORIES.includes(cat.category)) continue;
    for (const stream of cat.streams || []) {
      if (stream.always_live) { all.push({ ...stream, category_name: cat.category }); continue; }
      const isLive = stream.starts_at <= now && stream.ends_at >= now;
      const startsWithin8Hours = stream.starts_at > now && stream.starts_at <= eightHoursFromNow;
      if (isLive || startsWithin8Hours) {
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
    releaseInfo: isLive ? 'LIVE' : isUpcoming ? toEST(stream.starts_at) : 'Ended'
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

// Cache: streamId -> playlist content
const m3u8Cache = {};

app.get('/stream-playlist/:key', (req, res) => {
  const cached = m3u8Cache[req.params.key];
  if (!cached) return res.status(404).send('Expired');
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.send(cached);
});

app.get('/debug-cache', (req, res) => {
  const keys = Object.keys(m3u8Cache);
  if (!keys.length) return res.send('Cache empty');
  res.setHeader('Content-Type', 'text/plain');
  res.send(m3u8Cache[keys[keys.length - 1]]);
});

// Puppeteer queue for initial extractions
let puppeteerQueue = Promise.resolve();

async function extractM3u8FromEmbed(iframeUrl) {
  return puppeteerQueue = puppeteerQueue.then(() => _extractM3u8(iframeUrl));
}


async function _extractM3u8(iframeUrl) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
             '--autoplay-policy=no-user-gesture-required']
    });
    const page = await browser.newPage();
    let monoTsUrl = null;
    let m3u8Content = null;

    await page.setRequestInterception(true);
    page.on('request', req => {
      const rt = req.resourceType();
      if (['image', 'font', 'stylesheet'].includes(rt)) req.abort();
      else req.continue();
    });
    page.on('response', async response => {
      const url = response.url();
      if (url.includes('modifiles') && url.includes('mono.ts.m3u8')) {
        monoTsUrl = url;
        try { m3u8Content = await response.text(); } catch(e) {}
      }
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Referer': 'https://ppv.to/' });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    });
    await page.goto(iframeUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    if (!m3u8Content) {
      await new Promise(resolve => {
        const iv = setInterval(() => { if (m3u8Content) { clearInterval(iv); resolve(); } }, 500);
        setTimeout(() => { clearInterval(iv); resolve(); }, 15000);
      });
    }

    // Return both content and URL so refresh can poll directly
    return { content: m3u8Content, monoTsUrl };
  } catch (e) {
    console.error('Puppeteer error:', e.message);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

// Background refresh — directly polls mono.ts.m3u8 URL using the token
// The token from modifiles is valid for the duration of the stream
async function startRefreshing(cacheKey, iframeUrl) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
             '--autoplay-policy=no-user-gesture-required']
    });
    const page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on('request', req => {
      const rt = req.resourceType();
      if (['image', 'font', 'stylesheet'].includes(rt)) req.abort();
      else req.continue();
    });

    page.on('response', async response => {
      const url = response.url();
      if (url.includes('modifiles') && url.includes('mono.ts.m3u8')) {
        try {
          const text = await response.text();
          if (text && text.includes('#EXTM3U') && m3u8Cache[cacheKey] !== undefined) {
            m3u8Cache[cacheKey] = text;
            const seq = text.match(/SEQUENCE:(\d+)/)?.[1];
            console.log(`Refreshed: ${cacheKey} seq:${seq}`);
          }
        } catch(e) {}
      }
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Referer': 'https://ppv.to/' });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    });

    await page.goto(iframeUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Force video to play so JWPlayer keeps fetching segments
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) { v.muted = true; v.play(); }
    });

    // Keep alive and re-trigger play every 10s
    while (m3u8Cache[cacheKey] !== undefined) {
      await new Promise(r => setTimeout(r, 10000));
      try {
        await page.evaluate(() => {
          const v = document.querySelector('video');
          if (v && v.paused) { v.muted = true; v.play(); }
        });
      } catch(e) {}
    }
  } catch(e) {
    console.error('Refresh browser error:', e.message);
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
      if (!result || !result.content) { console.log('No content'); continue; }

      const cacheKey = `${streamId}_${source.id || 0}`;
      m3u8Cache[cacheKey] = result.content;
      m3u8Cache[cacheKey + '_iframe'] = iframeUrl;

      setTimeout(() => { delete m3u8Cache[cacheKey]; delete m3u8Cache[cacheKey + '_iframe']; }, 4 * 60 * 60 * 1000);

      // Start direct polling refresh using the monoTsUrl
      setImmediate(() => startRefreshing(cacheKey, iframeUrl));

      console.log(`Found stream for ${cacheKey}`);
      results.push({
        name: source.tag || source.name || 'Stream',
        title: source.name || stream.name,
        url: `${HOST}/stream-playlist/${cacheKey}`
      });
    }

    res.json({ streams: results });
  } catch (e) {
    console.error('Stream error:', e);
    res.json({ streams: [] });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ PPV.to Addon: ${HOST}/manifest.json\n`);
});
