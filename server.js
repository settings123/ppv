const express  = require('express');
const path     = require('path');
const https    = require('https');
const http     = require('http');

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
          args: [
            ...chromium.args,
            '--autoplay-policy=no-user-gesture-required',
            '--disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies',
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--allow-running-insecure-content',
            '--disable-web-security',
            '--no-sandbox',
          ],
          executablePath: await chromium.executablePath(),
          headless: chromium.headless,
        })
      : await puppeteer.launch({
          headless: 'new',
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--autoplay-policy=no-user-gesture-required',
            '--disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies',
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--enable-usermedia-screen-capturing',
            '--allow-running-insecure-content',
            '--disable-web-security',
          ],
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

  // Working endpoints return 200 with full stream list
  const candidates = [
    'https://api.ppv.to/api/streams?sport=nba',
    'https://api.ppv.to/api/streams?category=nba',
    'https://api.ppv.to/api/streams',
    'https://api.ppv.st/api/streams',
  ];

  for (const url of candidates) {
    try {
      const { status, body } = await fetchRaw(url);
      console.log(`API ${url} status=${status} len=${body.length} preview=${body.slice(0,300)}`);
      if (status === 200) {
        extractSlugsFromText(body, slugs);
        if (slugs.size) { console.log(`Got ${slugs.size} slugs from ${url}`); break; }
      }
    } catch(e) { console.log(`API ${url} error: ${e.message}`); }
  }

  // Always fallback to Puppeteer browser intercept — most reliable
  if (!slugs.size) {
    console.log('Falling back to Puppeteer intercept...');
    const p = await newPage();
    const found = new Set();
    p.on('response', async r => {
      const u = r.url();
      if (!u.includes('api.ppv.to') && !u.includes('api.ppv.st')) return;
      try {
        const text = await r.text();
        console.log(`Intercepted API: ${u} → ${text.slice(0,200)}`);
        extractSlugsFromText(text, found);
      } catch {}
    });
    try {
      await p.goto('https://ppv.to/live/nba', { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 5000));
      found.forEach(s => slugs.add(s));
      // Also scrape DOM links
      const links = await p.evaluate(() =>
        [...document.querySelectorAll('a[href]')].map(a => a.href).filter(h => h.includes('/live/nba/'))
      );
      console.log('DOM nba links:', links);
      links.forEach(u => extractSlugsFromText(u, slugs));
    } finally { await p.close().catch(() => {}); }
  }

  console.log(`Final slugs (${slugs.size}):`, [...slugs]);
  return [...slugs];
}

// ── Session store ─────────────────────────────────────────────────────────────
// key: slug  value: { m3u8Url, reqHeaders }
// We capture the exact request headers Chromium used for the m3u8 request via CDP,
// then replay them server-side. Since Render's outbound IP matches Puppeteer's IP,
// the token validates correctly.
const sessions = new Map();

async function openStream(slug) {
  const existing = sessions.get(slug);
  if (existing) sessions.delete(slug);

  const embedUrl = `https://pooembed.eu/embed/${slug}`;
  const p = await newPage();

  try {
    const client = await p.createCDPSession();
    await client.send('Network.enable');
    await client.send('Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: false, flatten: true
    }).catch(() => {});

    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        console.log(`[openStream] TIMEOUT for ${slug}`);
        resolve(null);
      }, 45000);

      // Method 1: catch m3u8 request directly (works if JWPlayer starts)
      client.on('Network.requestWillBeSent', ({ request }) => {
        const u = request.url;
        if (/\.m3u8/i.test(u) && !u.includes('pooembed')) {
          console.log(`[m3u8] ${u}`);
          clearTimeout(timer);
          resolve({ url: u, headers: request.headers });
        }
      });

      // Method 2: intercept /fetch response, extract URL using page's WASM context
      // After /fetch returns, the WASM decrypts it — we hook into that via page.evaluate
      client.on('Network.responseReceived', async ({ requestId, response }) => {
        if (!response.url.endsWith('/fetch')) return;
        console.log(`[/fetch] intercepted, waiting for WASM decrypt...`);
        // Give WASM time to decrypt, then query JWPlayer's config directly
        setTimeout(async () => {
          try {
            const url = await p.evaluate(() => {
              // Try to get URL from JWPlayer instance
              if (window.jwplayer) {
                try {
                  const p = window.jwplayer();
                  if (p && p.getPlaylist) {
                    const pl = p.getPlaylist();
                    if (pl && pl[0]) {
                      const f = pl[0].file || (pl[0].sources && pl[0].sources[0] && pl[0].sources[0].file);
                      if (f && f.includes('.m3u8')) return f;
                    }
                  }
                } catch {}
              }
              // Also scan all JS variables for modifiles URL
              const html = document.documentElement.innerHTML;
              const m = html.match(/https?:\/\/[a-z0-9.-]+\/secure\/[A-Za-z0-9]+\/\d+\/\d+\/[a-z]+\/[a-z0-9/.]+\.m3u8/i);
              return m ? m[0] : null;
            }).catch(() => null);
            if (url) {
              console.log(`[jwplayer extract] ${url}`);
              clearTimeout(timer);
              resolve({ url, headers: {} });
            }
          } catch(e) { console.log(`[jwplayer extract error] ${e.message}`); }
        }, 3000); // wait 3s for WASM to finish
      });

      p.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 25000 })
        .then(() => new Promise(r => setTimeout(r, 8000)))
        .then(() => p.evaluate(() => {
          for (const s of ['.jw-display-icon-container','.jw-icon-display','[aria-label="Play"]','video','#player']) {
            const el = document.querySelector(s); if (el) { el.click(); return s; }
          }
        }).catch(() => {}))
        .then(() => p.mouse.click(640, 360).catch(() => {}))
        .catch(e => console.error(`[goto error] ${e.message}`));
    });

    return result;
  } finally {
    await p.close().catch(() => {});
  }
}

// Fetch a CDN URL server-side using the captured Chromium request headers
function cdnGet(url, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    // Use the exact headers Chromium sent, override UA just in case
    const reqHeaders = { ...headers, 'User-Agent': UA };
    mod.get(url, { headers: reqHeaders }, r => {
      // Follow redirects
      if ([301,302,307,308].includes(r.statusCode) && r.headers.location) {
        const next = r.headers.location.startsWith('http') ? r.headers.location : new URL(r.headers.location, url).href;
        r.resume();
        return cdnGet(next, headers).then(resolve).catch(reject);
      }
      const chunks = [];
      r.on('data', d => chunks.push(d));
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
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

// ── Play ──────────────────────────────────────────────────────────────────────
app.post('/api/play', async (req, res) => {
  const { slug } = req.body;
  if (!slug) return res.status(400).json({ error: 'slug required' });
  try {
    console.log(`[play] ${slug}`);
    const result = await openStream(slug);
    if (!result) return res.status(504).json({ error: 'Stream not found — try again' });
    sessions.set(slug, { m3u8Url: result.url, reqHeaders: result.headers });
    const safeSlug = encodeURIComponent(slug);
    const relayUrl = `/relay/m3u8?slug=${safeSlug}`;
    res.json({ ok: true, proxyUrl: relayUrl, rawUrl: result.url });
  } catch (err) {
    console.error('[play] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Relay ─────────────────────────────────────────────────────────────────────
// Fetches m3u8 and segments server-side using Chromium's captured request headers.
// Render server IP == Puppeteer IP == valid token IP. No page kept open.

app.get('/relay/m3u8', async (req, res) => {
  const slug = decodeURIComponent(req.query.slug || '');
  if (!slug) return res.status(400).send('missing slug');
  const session = sessions.get(slug);
  if (!session) return res.status(404).send('No session — click a game first');

  try {
    const { status, body } = await cdnGet(session.m3u8Url, session.reqHeaders);
    const text = body.toString('utf8');
    console.log(`[relay m3u8] status=${status} len=${text.length} preview=${text.slice(0,100).replace(/\n/g,' ')}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');

    if (status !== 200) return res.status(status).send(text);

    const base = session.m3u8Url.substring(0, session.m3u8Url.lastIndexOf('/') + 1);
    const safeSlug = encodeURIComponent(slug);
    const out = text.split('\n').map(line => {
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
  const slug   = decodeURIComponent(req.query.slug || '');
  const cdnUrl = decodeURIComponent(req.query.cdn  || '');
  if (!slug || !cdnUrl) return res.status(400).send('missing params');

  const session = sessions.get(slug);
  if (!session) return res.status(404).send('No session');

  res.setHeader('Access-Control-Allow-Origin', '*');

  const isM3U8 = /\.m3u8/i.test(cdnUrl);

  try {
    const { status, body } = await cdnGet(cdnUrl, session.reqHeaders);
    const text = body.toString('utf8');

    if (isM3U8) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      const base = cdnUrl.substring(0, cdnUrl.lastIndexOf('/') + 1);
      const safeSlug = encodeURIComponent(slug);
      const out = text.split('\n').map(line => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return line;
        if (t.startsWith('/relay')) return line;
        const abs = t.startsWith('http') ? t : base + t;
        return `/relay/seg?slug=${safeSlug}&cdn=${encodeURIComponent(abs)}`;
      }).join('\n');
      return res.end(out);
    }

    console.log(`[relay seg] status=${status} len=${body.length}`);
    res.setHeader('Content-Type', 'video/mp2t');
    res.end(body);
  } catch (err) {
    console.error('[relay seg] error:', err.message);
    res.status(500).send(err.message);
  }
});

// ── Stremio addon ─────────────────────────────────────────────────────────────
// Short install URL — paste yourapp.onrender.com/s into Stremio
app.get('/s', (req, res) => {
  res.redirect('/manifest.json');
});

app.get('/manifest.json', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({
    id:          'com.streamtv.nba',
    version:     '1.0.0',
    name:        'StreamTV NBA',
    description: 'Live NBA streams from ppv.to',
    types:       ['channel'],
    catalogs:    [{ type: 'channel', id: 'nba_live', name: 'NBA Live' }],
    resources:   [
      'catalog',
      { name: 'meta',   types: ['channel'], idPrefixes: ['nba_'] },
      { name: 'stream', types: ['channel'], idPrefixes: ['nba_'] },
    ],
    idPrefixes:  ['nba_'],
  });
});

// Helper to decode slug from Stremio ID
function slugFromId(id) {
  return Buffer.from(id.replace(/^nba_/, ''), 'base64url').toString('utf8');
}

app.get('/catalog/channel/nba_live.json', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const slugs = await getNBAGameSlugs();
    const metas = slugs.map(slug => ({
      id:          'nba_' + Buffer.from(slug).toString('base64url'),
      type:        'channel',
      name:        labelFromSlug(slug),
      description: 'Live NBA: ' + labelFromSlug(slug),
      logo:        'https://upload.wikimedia.org/wikipedia/en/thumb/0/03/National_Basketball_Association_logo.svg/200px-National_Basketball_Association_logo.svg.png',
    }));
    console.log('[catalog] returning', metas.length, 'games');
    res.json({ metas });
  } catch(e) {
    console.error('[catalog] error:', e.message);
    res.json({ metas: [] });
  }
});

app.get('/meta/channel/:id.json', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const id = req.params.id;
  let slug;
  try { slug = slugFromId(id); } catch { return res.json({ meta: {} }); }
  res.json({
    meta: {
      id,
      type:        'channel',
      name:        labelFromSlug(slug),
      description: 'Live NBA stream',
      logo:        'https://upload.wikimedia.org/wikipedia/en/thumb/0/03/National_Basketball_Association_logo.svg/200px-National_Basketball_Association_logo.svg.png',
    }
  });
});

app.get('/stream/channel/:id.json', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const id = req.params.id;
  console.log('[stremio stream] id:', id);

  let slug;
  try { slug = slugFromId(id); } catch(e) {
    console.error('[stremio] bad id:', id);
    return res.json({ streams: [] });
  }
  console.log('[stremio stream] slug:', slug);

  try {
    const result = await openStream(slug);
    if (!result) { console.log('[stremio] no stream for', slug); return res.json({ streams: [] }); }
    sessions.set(slug, { m3u8Url: result.url, reqHeaders: result.headers });
    const base = req.protocol + '://' + req.get('host');
    const streamUrl = base + '/relay/m3u8?slug=' + encodeURIComponent(slug);
    console.log('[stremio] stream url:', streamUrl);
    res.json({ streams: [{ name: 'StreamTV NBA', title: labelFromSlug(slug), url: streamUrl }] });
  } catch(e) {
    console.error('[stremio stream] error:', e.message);
    res.json({ streams: [] });
  }
});

// ── Debug ─────────────────────────────────────────────────────────────────────
app.get('/debug', async (req, res) => {
  const out = { sessions: [...sessions.keys()], time: new Date().toISOString() };
  try {
    const { body } = await fetchRaw('https://api.ppv.to/api/streams/nba');
    const slugs = new Set();
    extractSlugsFromText(body, slugs);
    out.api = { slugs: [...slugs], preview: body.slice(0, 200) };
  } catch(e) { out.apiError = e.message; }
  res.json(out);
});

// ── Playlist / open-vlc ───────────────────────────────────────────────────────
app.get('/open-vlc', (req, res) => {
  const url   = decodeURIComponent(req.query.url   || '');
  const title = decodeURIComponent(req.query.title || 'Stream');
  if (!url) return res.status(400).send('missing url');
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Content-Disposition', 'inline; filename="stream.m3u8"');
  res.end(`#EXTM3U\n#EXTINF:-1,${title}\n${url}\n`);
});

app.listen(PORT, () => console.log(`StreamTV on port ${PORT}`));
