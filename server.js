const express = require('express');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const { PassThrough } = require('stream');

const IS_CLOUD = !!(process.env.RENDER || process.env.KOYEB || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME);
let puppeteer, chromium;
if (IS_CLOUD) {
  puppeteer = require('puppeteer-core');
  chromium  = require('@sparticuz/chromium');
} else {
  puppeteer = require('puppeteer');
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT   = process.env.PORT || 3000;
const ORIGIN = 'https://ppv.to';
const UA     = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Browser ───────────────────────────────────────────────────────────────────
let browser = null;
async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = IS_CLOUD
      ? await puppeteer.launch({
          args: [...chromium.args, '--autoplay-policy=no-user-gesture-required'],
          executablePath: await chromium.executablePath(),
          headless: chromium.headless,
        })
      : await puppeteer.launch({
          headless: 'new',
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required'],
        });
    console.log(`Browser [${IS_CLOUD ? 'cloud' : 'local'}]`);
  }
  return browser;
}

async function newPage() {
  const p = await (await getBrowser()).newPage();
  await p.setUserAgent(UA);
  await p.setViewport({ width: 1280, height: 720 });
  return p;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function labelFromSlug(slug) {
  const matchup = slug.split('/').pop() || slug;
  return matchup.split('-').map(p => p.toUpperCase()).join(' vs ').replace(' VS ', ' vs ');
}

function fetchRaw(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA, 'Origin': ORIGIN, 'Referer': ORIGIN+'/', 'Accept': 'application/json' } }, r => {
      let body = '';
      r.on('data', d => body += d);
      r.on('end', () => resolve({ status: r.statusCode, body }));
    }).on('error', reject);
  });
}

function extractSlugsFromText(text, slugs) {
  for (const m of text.matchAll(/nba\/\d{4}-\d{2}-\d{2}\/[a-z0-9-]+/gi)) slugs.add(m[0]);
}

async function getNBAGameSlugs() {
  const slugs = new Set();

  // Strategy 1: direct API
  for (const url of ['https://api.ppv.to/api/streams/nba','https://api.ppv.st/api/streams/nba']) {
    try {
      const { status, body } = await fetchRaw(url);
      console.log(`API ${url} → status=${status} len=${body.length} preview=${body.slice(0,120)}`);
      extractSlugsFromText(body, slugs);
      if (slugs.size) { console.log(`Got ${slugs.size} slugs from API`); break; }
    } catch(e) { console.log(`API ${url} error: ${e.message}`); }
  }

  // Strategy 2: Puppeteer browser intercept
  if (!slugs.size) {
    console.log('Falling back to Puppeteer intercept...');
    const p = await newPage();
    p.on('response', async r => {
      const u = r.url();
      if (!u.includes('api.ppv.to') && !u.includes('api.ppv.st')) return;
      try {
        const text = await r.text();
        console.log(`Intercepted ${u} → ${text.slice(0,120)}`);
        extractSlugsFromText(text, slugs);
      } catch {}
    });
    try {
      await p.goto(ORIGIN, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 4000));
      const links = await p.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => a.href));
      console.log(`DOM links: ${links.filter(l=>l.includes('ppv.to/live')).join(', ')}`);
      links.forEach(u => extractSlugsFromText(u, slugs));
    } finally { await p.close().catch(() => {}); }
  }

  console.log(`Final slugs (${slugs.size}):`, [...slugs]);
  return [...slugs];
}

// ── Session store ─────────────────────────────────────────────────────────────
// key: slug  value: { page, m3u8Url, segmentCache: Map<url, Buffer>, segmentQueue: PassThrough }
const sessions = new Map();

async function openStream(slug) {
  const existing = sessions.get(slug);
  if (existing) { await existing.page.close().catch(() => {}); sessions.delete(slug); }

  const embedUrl = `https://pooembed.eu/embed/${slug}`;
  const p = await newPage();

  // Segment cache — intercept responses from the player at CDP level
  // so we can serve them to VLC without re-fetching
  const segmentCache = new Map();
  const pendingSegments = new Map(); // url -> [resolve callbacks]

  const client = await p.createCDPSession();
  await client.send('Network.enable');
  await client.send('Target.setAutoAttach', {
    autoAttach: true, waitForDebuggerOnStart: false, flatten: true
  }).catch(() => {});

  // Intercept response bodies for .ts segments
  client.on('Network.responseReceived', async ({ requestId, response }) => {
    const u = response.url;
    if (/\.(ts|m4s|aac)(\?|$)/i.test(u)) {
      try {
        const { body, base64Encoded } = await client.send('Network.getResponseBody', { requestId });
        const buf = base64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body);
        segmentCache.set(u, buf);
        console.log(`[seg cached] ${u.slice(-40)} ${buf.length}b`);
        // Resolve any pending requests for this segment
        const cbs = pendingSegments.get(u);
        if (cbs) { cbs.forEach(cb => cb(buf)); pendingSegments.delete(u); }
      } catch {}
    }
  });

  // Wait for m3u8 URL
  const m3u8Url = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 30000);
    client.on('Network.requestWillBeSent', ({ request }) => {
      const u = request.url;
      if (/\.m3u8/i.test(u) && !u.includes('pooembed')) {
        clearTimeout(timer);
        console.log(`[m3u8] ${u}`);
        resolve(u);
      }
    });
  });

  if (!m3u8Url) { await p.close().catch(() => {}); return null; }

  // Trigger playback if not already started
  await p.evaluate(() => {
    for (const s of ['.jw-display-icon-container','.jw-icon-display','[aria-label="Play"]','video','#player']) {
      const el = document.querySelector(s); if (el) { el.click(); return; }
    }
  }).catch(() => {});

  sessions.set(slug, { page: p, m3u8Url, segmentCache, pendingSegments, client });
  return m3u8Url;
}

// Fetch a URL through the embed page — for m3u8 playlists (text)
async function fetchTextThroughPage(slug, url) {
  const s = sessions.get(slug);
  if (!s || s.page.isClosed()) throw new Error('No session');
  return s.page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'include' });
    return { status: r.status, text: await r.text() };
  }, url);
}

// Get a segment — either from cache (already fetched by the player) or fetch fresh
async function getSegment(slug, url, timeoutMs = 15000) {
  const s = sessions.get(slug);
  if (!s || s.page.isClosed()) throw new Error('No session');

  // Check cache first
  if (s.segmentCache.has(url)) {
    const buf = s.segmentCache.get(url);
    s.segmentCache.delete(url); // free memory after use
    return buf;
  }

  // Wait for the player to fetch it, or fetch ourselves via page
  return new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      // Timeout — fetch it ourselves through the page
      try {
        const result = await s.page.evaluate(async (u) => {
          const r = await fetch(u, { credentials: 'include' });
          if (!r.ok) return null;
          const ab = await r.arrayBuffer();
          const bytes = new Uint8Array(ab);
          let bin = '';
          for (let i = 0; i < bytes.length; i += 8192)
            bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
          return btoa(bin);
        }, url);
        if (result) resolve(Buffer.from(result, 'base64'));
        else reject(new Error('segment fetch failed'));
      } catch(e) { reject(e); }
    }, timeoutMs);

    // Register as pending
    if (!s.pendingSegments.has(url)) s.pendingSegments.set(url, []);
    s.pendingSegments.get(url).push(buf => { clearTimeout(timer); resolve(buf); });
  });
}

// ── SSE ───────────────────────────────────────────────────────────────────────
let sseClients = [];
function sse(msg) {
  const d = `data: ${JSON.stringify(msg)}\n\n`;
  sseClients.forEach(r => { try { r.write(d); } catch {} });
}
app.get('/api/crawl-progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.push(res);
  req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
});

// ── Crawl ─────────────────────────────────────────────────────────────────────
let crawlRunning = false;
app.post('/api/crawl', async (req, res) => {
  if (crawlRunning) return res.json({ error: 'Crawl already running' });
  crawlRunning = true;
  res.json({ ok: true });
  try {
    sse({ type: 'start' });
    sse({ type: 'status', msg: 'Loading NBA schedule…' });
    const slugs = await getNBAGameSlugs();
    if (!slugs.length) { sse({ type: 'status', msg: 'No games found today' }); sse({ type: 'done', total: 0 }); return; }
    for (const slug of slugs) {
      sse({ type: 'stream', stream: { slug, label: labelFromSlug(slug), type: 'HLS' } });
    }
    sse({ type: 'done', total: slugs.length });
  } catch (err) {
    sse({ type: 'status', msg: 'Error: ' + err.message });
    sse({ type: 'done', total: 0 });
  } finally { crawlRunning = false; }
});

// ── Play — open embed, return stream URLs ─────────────────────────────────────
app.post('/api/play', async (req, res) => {
  const { slug } = req.body;
  if (!slug) return res.status(400).json({ error: 'slug required' });
  try {
    console.log(`[play] ${slug}`);
    const m3u8Url = await openStream(slug);
    if (!m3u8Url) return res.status(504).json({ error: 'Stream not found — try again' });
    const safeSlug = encodeURIComponent(slug);
    // m3u8 served through our relay, segments too
    const relayUrl = `/relay/m3u8?slug=${safeSlug}`;
    res.json({ ok: true, proxyUrl: relayUrl, rawUrl: m3u8Url });
  } catch (err) {
    console.error('[play] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Relay — serves m3u8 and segments through the live Puppeteer page ──────────
app.get('/relay/m3u8', async (req, res) => {
  const slug = req.query.slug;
  if (!slug) return res.status(400).send('missing slug');

  const session = sessions.get(slug);
  if (!session) return res.status(404).send('No session — call /api/play first');

  try {
    const result = await fetchTextThroughPage(slug, session.m3u8Url);
    console.log(`[relay m3u8] status=${result.status} len=${result.text.length} preview=${result.text.slice(0,80).replace(/\n/g,' ')}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');

    const base = session.m3u8Url.substring(0, session.m3u8Url.lastIndexOf('/') + 1);
    const safeSlug = encodeURIComponent(slug);
    const out = result.text.split('\n').map(line => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      if (t.startsWith('/relay')) return line;
      const abs = t.startsWith('http') ? t : base + t;
      return `/relay/seg?slug=${safeSlug}&cdn=${encodeURIComponent(abs)}`;
    }).join('\n');
    res.end(out);
  } catch (err) {
    console.error('[relay m3u8] error:', err.message);
    res.status(500).send(err.message);
  }
});

app.get('/relay/seg', async (req, res) => {
  const slug   = req.query.slug;
  const cdnUrl = req.query.cdn;
  if (!slug || !cdnUrl) return res.status(400).send('missing params');

  res.setHeader('Access-Control-Allow-Origin', '*');

  const isM3U8 = /\.m3u8/i.test(cdnUrl) || /playlist|manifest/i.test(cdnUrl);

  if (isM3U8) {
    // Sub-playlist (e.g. tracks-v1a1/mono.ts.m3u8)
    try {
      const result = await fetchTextThroughPage(slug, cdnUrl);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      const base = cdnUrl.substring(0, cdnUrl.lastIndexOf('/') + 1);
      const safeSlug = encodeURIComponent(slug);
      const out = result.text.split('\n').map(line => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return line;
        if (t.startsWith('/relay')) return line;
        const abs = t.startsWith('http') ? t : base + t;
        return `/relay/seg?slug=${safeSlug}&cdn=${encodeURIComponent(abs)}`;
      }).join('\n');
      res.end(out);
    } catch(err) { res.status(500).send(err.message); }
    return;
  }

  // Binary segment
  try {
    const buf = await getSegment(slug, cdnUrl);
    console.log(`[relay seg] ${cdnUrl.slice(-40)} ${buf.length}b`);
    res.setHeader('Content-Type', 'video/mp2t');
    res.end(buf);
  } catch (err) {
    console.error('[relay seg] error:', err.message);
    res.status(500).send(err.message);
  }
});


// ── Debug — hit from any browser to diagnose without the TV ──────────────────
app.get('/debug', async (req, res) => {
  const out = { time: new Date().toISOString(), tests: {} };

  // Test 1: direct API call
  for (const url of ['https://api.ppv.to/api/streams/nba','https://api.ppv.st/api/streams/nba']) {
    try {
      const data = await fetchJson(url);
      const text = JSON.stringify(data||'');
      const slugs = new Set();
      extractSlugsFromText(text, slugs);
      out.tests[url] = { ok: !!data, slugCount: slugs.size, slugs: [...slugs], preview: text.slice(0,200) };
      if (slugs.size) break;
    } catch(e) { out.tests[url] = { error: e.message }; }
  }

  // Test 2: active sessions
  out.activeSessions = [...sessions.keys()];

  res.json(out);
});


// ── M3U playlist endpoint — Android opens .m3u files with VLC automatically ──
app.get('/playlist.m3u', (req, res) => {
  const url   = req.query.url;
  const title = req.query.title || 'Stream';
  if (!url) return res.status(400).send('missing url');
  res.setHeader('Content-Type', 'audio/x-mpegurl');
  res.setHeader('Content-Disposition', `attachment; filename="${title.replace(/[^a-z0-9]/gi,'_')}.m3u"`);
  res.end(`#EXTM3U\n#EXTINF:-1,${title}\n${url}\n`);
});

app.listen(PORT, () => console.log(`StreamTV on port ${PORT}`));
