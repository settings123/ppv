// server.js (ES module)
import express from 'express';
import path from 'path';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Detect cloud environment
const IS_CLOUD = !!(
  process.env.RENDER ||
  process.env.KOYEB ||
  process.env.RAILWAY_ENVIRONMENT ||
  process.env.FLY_APP_NAME
);

// Puppeteer setup
let puppeteer, chromium;
if (IS_CLOUD) {
  puppeteer = await import('puppeteer-core').then(m => m.default);
  chromium  = await import('@sparticuz/chromium').then(m => m.default);
} else {
  puppeteer = await import('puppeteer').then(m => m.default);
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
          args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
          executablePath: await chromium.executablePath(),
          headless: chromium.headless,
        })
      : await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
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

// ── Slug extraction ───────────────────────────────────────────────────────────
function extractSlugsFromApi(data, slugs) {
  if (!data || !Array.isArray(data.streams)) return;

  console.log('[DEBUG] Parsing API categories:', data.streams.map(c => c.category));

  for (const cat of data.streams) {
    if (!cat.category) continue;

    const catName = cat.category.toLowerCase().trim();
    if (!catName.includes('basketball')) continue;

    if (!Array.isArray(cat.streams)) continue;

    for (const s of cat.streams) {
      if (s.slug) slugs.add(s.slug);
      else if (s.name) slugs.add(s.name);
    }
  }

  console.log('[DEBUG] NBA slugs found so far:', [...slugs]);
}

async function getNBAGameSlugs() {
  const slugs = new Set();

  try {
    console.log('[DEBUG] Fetching URL: https://api.ppv.to/api/streams');
    const { status, body } = await fetchRaw('https://api.ppv.to/api/streams');
    console.log(`[DEBUG] Fetched https://api.ppv.to/api/streams status=${status} length=${body.length}`);

    if (status === 200) {
      const data = JSON.parse(body);
      extractSlugsFromApi(data, slugs);
    }
  } catch(e) { console.log(`[DEBUG] API error: ${e.message}`); }

  console.log('[DEBUG] Final slugs:', [...slugs]);
  return [...slugs];
}

// ── Session store ─────────────────────────────────────────────────────────────
const sessions = new Map();

// ── Stream opening ───────────────────────────────────────────────────────────
async function openStream(slug) {
  console.log(`[DEBUG] openStream called for slug=${slug}`);
  return null; // Placeholder: plug WASM/Puppeteer decryption here
}

// ── Stremio addon endpoints ──────────────────────────────────────────────────
function slugFromId(id) {
  return Buffer.from(id.replace(/^nba_/, ''), 'base64url').toString('utf8');
}

app.get('/catalog/channel/nba_live.json', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const slugs = await getNBAGameSlugs();
    const metas = slugs.map(slug => ({
      id: 'nba_' + Buffer.from(slug).toString('base64url'),
      type: 'channel',
      name: labelFromSlug(slug),
      description: 'Live NBA: ' + labelFromSlug(slug),
      logo: 'https://upload.wikimedia.org/wikipedia/en/thumb/0/03/National_Basketball_Association_logo.svg/200px-National_Basketball_Association_logo.svg.png',
    }));
    console.log('[DEBUG] catalog returning', metas.length, 'games');
    res.json({ metas });
  } catch(e) { console.error('[DEBUG] catalog error:', e.message); res.json({ metas: [] }); }
});

app.get('/stream/channel/:id.json', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const id = req.params.id;
  console.log('[DEBUG] stremio stream id:', id);

  let slug;
  try { slug = slugFromId(id); } catch(e) { console.error('[DEBUG] bad id:', id); return res.json({ streams: [] }); }

  try {
    const result = await openStream(slug);
    if (!result) { console.log('[DEBUG] no stream for', slug); return res.json({ streams: [] }); }

    sessions.set(slug, { m3u8Url: result.url, reqHeaders: result.headers });
    const base = req.protocol + '://' + req.get('host');
    const streamUrl = base + '/relay/m3u8?slug=' + encodeURIComponent(slug);

    res.json({
      streams: [{
        name: 'StreamTV NBA',
        title: labelFromSlug(slug),
        url: streamUrl,
        behaviorHints: { notWebReady: true }
      }]
    });
  } catch(e) { console.error('[DEBUG] stremio stream error:', e.message); res.json({ streams: [] }); }
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`StreamTV running on port ${PORT}`);
});
