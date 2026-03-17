'use strict';

const express = require('express');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const vm      = require('vm');
const fs      = require('fs');

const app  = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT   = process.env.PORT || 3000;
const ORIGIN = 'https://ppv.to';
const EMBED  = 'https://pooembed.eu';
const UA     = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Raw HTTP helper ────────────────────────────────────────────────────────────
function rawFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const { method = 'GET', headers = {}, body = null, maxRedirects = 5 } = opts;
    const mod    = url.startsWith('https') ? https : http;
    const parsed = new URL(url);
    const reqOpts = {
      hostname: parsed.hostname,
      port:     parsed.port || (url.startsWith('https') ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers:  { 'User-Agent': UA, ...headers },
    };
    const req = mod.request(reqOpts, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
        res.resume();
        return rawFetch(next, { ...opts, maxRedirects: maxRedirects - 1 }).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({
        status:  res.statusCode,
        headers: res.headers,
        buffer:  Buffer.concat(chunks),
        text:    () => Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : body);
    req.end();
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
// ── NBA team data ─────────────────────────────────────────────────────────────
// Maps ppv.to abbreviation → { full name, ESPN 3-letter code }
const NBA_TEAMS = {
  atl:  { name: 'Atlanta Hawks',           espn: 'atl' },
  bos:  { name: 'Boston Celtics',          espn: 'bos' },
  bkn:  { name: 'Brooklyn Nets',           espn: 'bkn' },
  cha:  { name: 'Charlotte Hornets',       espn: 'cha' },
  chi:  { name: 'Chicago Bulls',           espn: 'chi' },
  cle:  { name: 'Cleveland Cavaliers',     espn: 'cle' },
  dal:  { name: 'Dallas Mavericks',        espn: 'dal' },
  den:  { name: 'Denver Nuggets',          espn: 'den' },
  det:  { name: 'Detroit Pistons',         espn: 'det' },
  gs:   { name: 'Golden State Warriors',   espn: 'gsw' },
  hou:  { name: 'Houston Rockets',         espn: 'hou' },
  ind:  { name: 'Indiana Pacers',          espn: 'ind' },
  lac:  { name: 'LA Clippers',             espn: 'lac' },
  lal:  { name: 'Los Angeles Lakers',      espn: 'lal' },
  mem:  { name: 'Memphis Grizzlies',       espn: 'mem' },
  mia:  { name: 'Miami Heat',              espn: 'mia' },
  mil:  { name: 'Milwaukee Bucks',         espn: 'mil' },
  min:  { name: 'Minnesota Timberwolves',  espn: 'min' },
  no:   { name: 'New Orleans Pelicans',    espn: 'nop' },
  ny:   { name: 'New York Knicks',         espn: 'nyk' },
  okc:  { name: 'Oklahoma City Thunder',   espn: 'okc' },
  orl:  { name: 'Orlando Magic',           espn: 'orl' },
  phi:  { name: 'Philadelphia 76ers',      espn: 'phi' },
  phx:  { name: 'Phoenix Suns',            espn: 'phx' },
  por:  { name: 'Portland Trail Blazers',  espn: 'por' },
  sac:  { name: 'Sacramento Kings',        espn: 'sac' },
  sa:   { name: 'San Antonio Spurs',       espn: 'sas' },
  tor:  { name: 'Toronto Raptors',         espn: 'tor' },
  utah: { name: 'Utah Jazz',               espn: 'uta' },
  wsh:  { name: 'Washington Wizards',      espn: 'wsh' },
};

// ESPN logos work publicly with no auth/referer restrictions
function teamLogoUrl(abbr) {
  const team = NBA_TEAMS[abbr.toLowerCase()];
  if (!team) return null;
  return `https://a.espncdn.com/combiner/i?img=/i/teamlogos/nba/500/${team.espn}.png&h=200&w=200`;
}

function teamName(abbr) {
  return NBA_TEAMS[abbr.toLowerCase()]?.name || abbr.toUpperCase();
}

// Parse a slug like "nba/2026-03-15/dal-cle" into { away, home }
function parseMatchup(slug) {
  const part = slug.split('/').pop() || '';
  // Split on first '-' that separates two team abbreviations
  // Teams can be multi-char (utah, okc, etc.) so we try known teams
  const parts = part.split('-');
  // Try splitting at each position and see if both halves match known teams
  for (let i = 1; i < parts.length; i++) {
    const away = parts.slice(0, i).join('-');
    const home = parts.slice(i).join('-');
    if (NBA_TEAMS[away] && NBA_TEAMS[home]) return { away, home };
  }
  // Fallback: just split in half
  const mid  = Math.ceil(parts.length / 2);
  return { away: parts.slice(0, mid).join('-'), home: parts.slice(mid).join('-') };
}

function labelFromSlug(slug) {
  const { away, home } = parseMatchup(slug);
  return `${teamName(away)} vs ${teamName(home)}`;
}

// Poster: side-by-side team logos via a public image proxy
// We use a simple HTML-rendered image via unavatar or just return both logo URLs
// Stremio supports `poster` (portrait) and `background` fields on meta objects.
// Best approach: use the away team logo as poster, home as background.
// For a proper matchup card, we generate a URL to our own /poster endpoint.
function posterUrl(base, slug) {
  return `${base}/poster/${encodeURIComponent(slug)}`;
}

async function fetchRaw(url) {
  const r = await rawFetch(url, {
    headers: { 'Origin': ORIGIN, 'Referer': ORIGIN + '/', 'Accept': 'application/json' }
  });
  return { status: r.status, body: r.text() };
}

function extractSlugsFromApi(data, slugs) {
  if (!data || !Array.isArray(data.streams)) return;
  for (const cat of data.streams) {
    if (!cat.category) continue;
    const cname = cat.category.toLowerCase();
    if (!cname.includes('basketball') && !cname.includes('nba')) continue;
    if (!Array.isArray(cat.streams)) continue;
    for (const s of cat.streams) {
      if (s.slug) slugs.add(s.slug);
      else if (s.uri_name && /^nba\//.test(s.uri_name)) slugs.add(s.uri_name);
    }
  }
}

async function getNBAGameSlugs() {
  const slugs = new Set();
  try {
    const { status, body } = await fetchRaw('https://api.ppv.to/api/streams');
    console.log(`[api] status=${status}`);
    if (status === 200) {
      const data = JSON.parse(body);
      extractSlugsFromApi(data, slugs);
      // Also grab NBA by uri_name from ALL basketball streams
      const ball = data.streams?.find(c => c.category?.toLowerCase().includes('basketball'));
      if (ball?.streams) {
        for (const s of ball.streams) {
          if (s.uri_name?.startsWith('nba/')) slugs.add(s.uri_name);
          else if (s.iframe?.includes('/nba/')) {
            const m = s.iframe.match(/embed\/(nba\/[^"'\s]+)/);
            if (m) slugs.add(m[1]);
          }
        }
      }
    }
  } catch(e) { console.log(`[api] error: ${e.message}`); }
  console.log(`[slugs] found ${slugs.size}:`, [...slugs]);
  return [...slugs];
}

// ── Stream extraction ─────────────────────────────────────────────────────────

// Cache wasm binary
let _wasmBinary = null;
const WASM_CACHE_PATH = path.join(__dirname, 'gasm.wasm');

async function getWasmBinary() {
  if (_wasmBinary) return _wasmBinary;
  if (fs.existsSync(WASM_CACHE_PATH)) {
    _wasmBinary = fs.readFileSync(WASM_CACHE_PATH);
    console.log('[wasm] loaded from disk len=' + _wasmBinary.length);
    return _wasmBinary;
  }
  // Try common paths on pooembed.eu
  const paths = ['/gasm.wasm', '/js/gasm.wasm', '/assets/gasm.wasm',
                 '/static/gasm.wasm', '/wasm/gasm.wasm', '/dist/gasm.wasm'];
  for (const p of paths) {
    const r = await rawFetch(EMBED + p, {
      headers: { 'Referer': EMBED + '/', 'Accept': 'application/wasm,*/*' }
    });
    console.log('[wasm] try ' + p + ' -> ' + r.status + ' len=' + r.buffer.length);
    if (r.status === 200 && r.buffer.length > 100) {
      _wasmBinary = r.buffer;
      fs.writeFileSync(WASM_CACHE_PATH, _wasmBinary);
      console.log('[wasm] cached to disk');
      return _wasmBinary;
    }
  }
  throw new Error('gasm.wasm not found at any known path');
}

async function extractM3U8ViaWasm(slug) {
  console.log('[stream] extracting slug=' + slug);

  // Step 1: fetch embed page, grab encrypted blob
  const embedR = await rawFetch(`${EMBED}/embed/${slug}`, {
    headers: { 'Referer': 'https://ppv.to/', 'Accept': 'text/html',
               'Cache-Control': 'no-cache' }
  });
  const html = embedR.text();
  console.log('[stream] embed status=' + embedR.status + ' len=' + html.length);

  // Extract the encrypted blob: window['RANDOMKEY']='BASE64DATA'
  const blobMatch = html.match(/window\['[A-Za-z0-9]{8,}'\]\s*=\s*'([A-Za-z0-9+/=]{50,})'/);
  if (!blobMatch) {
    console.log('[stream] no blob found, html snippet:', html.slice(0,300));
    throw new Error('Encrypted blob not found in embed page');
  }
  const encBlob = blobMatch[1];
  console.log('[stream] blob len=' + encBlob.length);

  // Step 2: get wasm binary
  const wasmBin = await getWasmBinary();

  // Step 3: run wasm in Node to decrypt blob
  const wasmBuf = wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength);
  const { instance } = await WebAssembly.instantiate(wasmBuf, {
    env: {
      memory: new WebAssembly.Memory({ initial: 256 }),
      // stub any imports the wasm needs
    },
    // log any import namespaces
  });
  console.log('[wasm] exports:', Object.keys(instance.exports).join(', '));

  // Most likely the wasm exports a decrypt function
  // Try common export names
  const decrypt = instance.exports.decrypt
    || instance.exports.decryptStream
    || instance.exports.process
    || instance.exports.getUrl
    || instance.exports.main;

  if (decrypt) {
    // Write blob to wasm memory and call decrypt
    const mem = new Uint8Array(instance.exports.memory.buffer);
    const blobBytes = Buffer.from(encBlob, 'base64');
    mem.set(blobBytes, 0);
    const result = decrypt(0, blobBytes.length);
    const resultStr = Buffer.from(instance.exports.memory.buffer, result).toString('utf8').split('\0')[0];
    console.log('[wasm] decrypt result:', resultStr.slice(0,200));
    if (resultStr.includes('http')) return resultStr.trim();
  }

  throw new Error('WASM decryption failed — exports: ' + Object.keys(instance.exports).join(', '));
}

// ── Session store ─────────────────────────────────────────────────────────────
const sessions = new Map();

// ── CDN relay helper ──────────────────────────────────────────────────────────
function cdnGet(url) {
  return rawFetch(url, {
    headers: {
      'Referer':        EMBED + '/',
      'Origin':         EMBED,
      'Accept':         '*/*',
    }
  });
}

// ── Stremio addon ─────────────────────────────────────────────────────────────

// ── Matchup poster image ───────────────────────────────────────────────────────
// Returns an SVG with both team logos side by side — Stremio renders this as
// the card thumbnail. Size: 400×600 (portrait, Stremio poster ratio).
app.get('/poster/:slug(*)', async (req, res) => {
  const slug = req.params.slug;
  const { away, home } = parseMatchup(slug);
  const base = req.protocol + '://' + req.get('host');
  const awayLogo = teamLogoUrl(away) || '';
  const homeLogo = teamLogoUrl(home) || '';
  const awayName = teamName(away);
  const homeName = teamName(home);

  // Build SVG
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="400" height="600" viewBox="0 0 400 600">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0a0a1a"/>
      <stop offset="100%" stop-color="#1a1a3a"/>
    </linearGradient>
    <linearGradient id="divider" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="50%" stop-color="#c8a84b" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="8" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="shadow">
      <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="#000" flood-opacity="0.6"/>
    </filter>
  </defs>

  <!-- Background -->
  <rect width="400" height="600" fill="url(#bg)"/>

  <!-- Subtle court lines -->
  <ellipse cx="200" cy="310" rx="120" ry="120" fill="none" stroke="#ffffff" stroke-width="1" stroke-opacity="0.06"/>
  <line x1="200" y1="190" x2="200" y2="430" stroke="#ffffff" stroke-width="1" stroke-opacity="0.06"/>

  <!-- LIVE badge -->
  <rect x="155" y="32" width="90" height="28" rx="14" fill="#e63946" opacity="0.95"/>
  <text x="200" y="51" font-family="Arial,sans-serif" font-size="13" font-weight="700"
        fill="white" text-anchor="middle" letter-spacing="2">LIVE</text>

  <!-- Away team logo -->
  ${awayLogo ? `<image href="${awayLogo}" x="20" y="100" width="160" height="160"
        filter="url(#shadow)" preserveAspectRatio="xMidYMid meet" crossorigin="anonymous"/>` :
    `<text x="100" y="195" font-family="Arial" font-size="48" font-weight="900"
        fill="#ffffff" text-anchor="middle" filter="url(#shadow)">${away.toUpperCase()}</text>`}

  <!-- Home team logo -->
  ${homeLogo ? `<image href="${homeLogo}" x="220" y="100" width="160" height="160"
        filter="url(#shadow)" preserveAspectRatio="xMidYMid meet" crossorigin="anonymous"/>` :
    `<text x="300" y="195" font-family="Arial" font-size="48" font-weight="900"
        fill="#ffffff" text-anchor="middle" filter="url(#shadow)">${home.toUpperCase()}</text>`}

  <!-- VS divider -->
  <rect x="197" y="100" width="6" height="160" fill="url(#divider)" rx="3"/>
  <text x="200" y="300" font-family="Arial,sans-serif" font-size="22" font-weight="900"
        fill="#c8a84b" text-anchor="middle" filter="url(#glow)">VS</text>

  <!-- Team names -->
  <text x="100" y="295" font-family="Arial,sans-serif" font-size="11" font-weight="600"
        fill="#ffffff" text-anchor="middle" opacity="0.85">${awayName}</text>
  <text x="300" y="295" font-family="Arial,sans-serif" font-size="11" font-weight="600"
        fill="#ffffff" text-anchor="middle" opacity="0.85">${homeName}</text>

  <!-- Bottom label -->
  <rect x="0" y="520" width="400" height="80" fill="#000000" opacity="0.5"/>
  <text x="200" y="555" font-family="Arial,sans-serif" font-size="13" font-weight="700"
        fill="#c8a84b" text-anchor="middle" letter-spacing="1">NBA</text>
  <text x="200" y="578" font-family="Arial,sans-serif" font-size="11"
        fill="#ffffff" text-anchor="middle" opacity="0.7">Live Stream</text>
</svg>`;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.end(svg);
});

app.get('/s', (req, res) => res.redirect('/manifest.json'));

app.get('/manifest.json', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({
    id:          'com.streamtv.nba',
    version:     '2.2.0',
    name:        'StreamTV NBA',
    description: 'Live NBA streams via ppv.to (no browser required)',
    types:       ['channel'],
    catalogs:    [{ type: 'channel', id: 'nba_live', name: 'NBA Live' }],
    resources:   [
      'catalog',
      { name: 'meta',   types: ['channel'], idPrefixes: ['nba_'] },
      { name: 'stream', types: ['channel'], idPrefixes: ['nba_'] },
    ],
    idPrefixes: ['nba_'],
  });
});

function slugFromId(id) {
  return Buffer.from(id.replace(/^nba_/, ''), 'base64url').toString('utf8');
}

app.get('/catalog/channel/nba_live.json', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const slugs = await getNBAGameSlugs();
    const base  = req.protocol + '://' + req.get('host');
    const metas = slugs.map(slug => {
      const { away, home } = parseMatchup(slug);
      return {
        id:          'nba_' + Buffer.from(slug).toString('base64url'),
        type:        'channel',
        name:        labelFromSlug(slug),
        description: teamName(away) + ' @ ' + teamName(home),
        poster:      posterUrl(base, slug),
        posterShape: 'poster',
        background:  teamLogoUrl(home) || posterUrl(base, slug),
        logo:        teamLogoUrl(away) || `${base}/logo/nba`,
      };
    });
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
  const base2 = req.protocol + '://' + req.get('host');
  const { away: a2, home: h2 } = parseMatchup(slug);
  res.json({
    meta: {
      id, type: 'channel',
      name:        labelFromSlug(slug),
      description: teamName(a2) + ' @ ' + teamName(h2),
      poster:      posterUrl(base2, slug),
      posterShape: 'poster',
      background:  teamLogoUrl(h2) || posterUrl(base2, slug),
      logo:        teamLogoUrl(a2) || `${base2}/logo/nba`,
    }
  });
});

app.get('/stream/channel/:id.json', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const id = req.params.id;
  let slug;
  try { slug = slugFromId(id); } catch(e) { return res.json({ streams: [] }); }
  console.log('[stream] slug:', slug);

  try {
    const m3u8Url = await extractM3U8ViaWasm(slug);
    sessions.set(slug, m3u8Url);
    const base       = req.protocol + '://' + req.get('host');
    const streamUrl  = `${base}/relay/m3u8?slug=${encodeURIComponent(slug)}`;
    console.log('[stream] returning:', streamUrl);
    res.json({ streams: [{ name: 'StreamTV NBA', title: labelFromSlug(slug), url: streamUrl }] });
  } catch(e) {
    console.error('[stream] error:', e.message);
    res.json({ streams: [] });
  }
});

// ── Web UI play endpoint ──────────────────────────────────────────────────────
app.post('/api/play', async (req, res) => {
  const { slug } = req.body;
  if (!slug) return res.status(400).json({ error: 'slug required' });
  try {
    const m3u8Url = await extractM3U8ViaWasm(slug);
    sessions.set(slug, m3u8Url);
    const relayUrl = `/relay/m3u8?slug=${encodeURIComponent(slug)}`;
    res.json({ ok: true, proxyUrl: relayUrl, rawUrl: m3u8Url });
  } catch(e) {
    console.error('[play] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Web UI crawl ──────────────────────────────────────────────────────────────
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

app.post('/api/crawl', async (req, res) => {
  res.json({ ok: true });
  try {
    sse({ type: 'start' });
    sse({ type: 'status', msg: 'Loading NBA schedule…' });
    const slugs = await getNBAGameSlugs();
    if (!slugs.length) { sse({ type: 'status', msg: 'No NBA games found' }); sse({ type: 'done', total: 0 }); return; }
    for (const slug of slugs) {
      sse({ type: 'stream', stream: { slug, label: labelFromSlug(slug), type: 'HLS' } });
    }
    sse({ type: 'done', total: slugs.length });
  } catch(e) {
    sse({ type: 'status', msg: 'Error: ' + e.message });
    sse({ type: 'done', total: 0 });
  }
});

// ── Relay ─────────────────────────────────────────────────────────────────────
app.get('/relay/m3u8', async (req, res) => {
  const slug = decodeURIComponent(req.query.slug || '');
  if (!slug) return res.status(400).send('missing slug');

  let m3u8Url = sessions.get(slug);
  if (!m3u8Url) {
    // Re-extract on demand
    try { m3u8Url = await extractM3U8ViaWasm(slug); sessions.set(slug, m3u8Url); }
    catch(e) { return res.status(504).send('Stream not available: ' + e.message); }
  }

  try {
    const r = await cdnGet(m3u8Url);
    const text = r.text();
    console.log(`[relay m3u8] status=${r.status} len=${text.length}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    if (r.status !== 200) return res.status(r.status).send(text);

    const base     = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
    const safeSlug = encodeURIComponent(slug);
    const out = text.split('\n').map(line => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      if (t.startsWith('/relay')) return line;
      const abs = t.startsWith('http') ? t : base + t;
      return `/relay/seg?slug=${safeSlug}&cdn=${encodeURIComponent(abs)}`;
    }).join('\n');
    res.end(out);
  } catch(e) {
    console.error('[relay m3u8] error:', e.message);
    res.status(500).send(e.message);
  }
});

app.get('/relay/seg', async (req, res) => {
  const slug   = decodeURIComponent(req.query.slug || '');
  const cdnUrl = decodeURIComponent(req.query.cdn  || '');
  if (!slug || !cdnUrl) return res.status(400).send('missing params');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const isM3U8 = /\.m3u8/i.test(cdnUrl);
  try {
    const r    = await cdnGet(cdnUrl);
    const text = r.text();
    if (isM3U8) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      const base     = cdnUrl.substring(0, cdnUrl.lastIndexOf('/') + 1);
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
    console.log(`[relay seg] status=${r.status} len=${r.buffer.length}`);
    res.setHeader('Content-Type', 'video/mp2t');
    res.end(r.buffer);
  } catch(e) {
    console.error('[relay seg] error:', e.message);
    res.status(500).send(e.message);
  }
});

// ── Debug ─────────────────────────────────────────────────────────────────────
app.get('/debug', async (req, res) => {
  const out = {
    sessions:    [...sessions.keys()],
    time:        new Date().toISOString(),
      };
  try {
    const { status, body } = await fetchRaw('https://api.ppv.to/api/streams');
    const data = JSON.parse(body);
    const slugs = new Set();
    extractSlugsFromApi(data, slugs);
    out.api = {
      status,
      categories: data.streams?.map(c => ({ category: c.category, count: c.streams?.length })),
      nba_slugs: [...slugs],
    };
  } catch(e) { out.apiError = e.message; }
  res.json(out);
});



// ── Debug: probe pooembed.eu for wasm ────────────────────────────────────────
app.get('/debug/probe', async (req, res) => {
  const results = {};
  const slug = req.query.slug || 'nba/2026-03-17/dal-cle';

  // Fetch embed page and extract ALL URLs referenced
  const embedR = await rawFetch(`${EMBED}/embed/${slug}`, {
    headers: { 'Referer': 'https://ppv.to/', 'Accept': 'text/html' }
  });
  const html = embedR.text();
  results.embedStatus = embedR.status;
  results.htmlLen = html.length;

  // Extract ALL src= and href= URLs
  const srcs = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(m => m[1]);
  // Extract all strings that look like paths
  const paths = [...html.matchAll(/"(\/[a-z0-9/_.-]+\.[a-z0-9]+)"/g)].map(m => m[1]);
  // Extract cdnDomain and cdnPath from the window config
  const cdnDomain = (html.match(/"cdnDomain":"([^"]+)"/) || [])[1];
  const cdnPaths = [...html.matchAll(/"cdnPath":"([^"]+)"/g)].map(m => m[1]);

  results.srcs = srcs;
  results.embeddedPaths = paths.slice(0, 20);
  results.cdnDomain = cdnDomain;
  results.cdnPaths = cdnPaths;

  // Probe pooembed.eu directly for wasm files
  const probePaths = [
    '/gasm.wasm', '/js/gasm.wasm', '/assets/gasm.wasm',
    '/static/gasm.wasm', '/wasm/gasm.wasm', '/dist/gasm.wasm',
    '/gasm.js', '/js/gasm.js', '/assets/gasm.js',
    '/player.js', '/js/player.js', '/embed.js',
  ];
  results.probes = {};
  for (const p of probePaths) {
    const r = await rawFetch(EMBED + p, {
      headers: { 'Referer': EMBED + '/', 'Accept': '*/*' }
    });
    results.probes[p] = { status: r.status, len: r.buffer.length };
  }

  res.json(results);
});

// ── Debug: dump raw embed page blob ──────────────────────────────────────────
app.get('/debug/blob/:slug(*)', async (req, res) => {
  const slug = req.params.slug;
  try {
    const r = await rawFetch(`${EMBED}/embed/${slug}`, {
      headers: { 'Referer': 'https://ppv.to/', 'Accept': 'text/html' }
    });
    const html = r.text();
    // Extract ALL window[key]=value assignments
    const blobs = {};
    for (const m of html.matchAll(/window\['([^']+)'\]\s*=\s*'([^']{20,})'/g)) {
      blobs[m[1]] = { len: m[2].length, value: m[2].slice(0, 200) };
    }
    // Also try to find any base64-looking data
    const b64chunks = html.match(/[A-Za-z0-9+/]{100,}={0,2}/g) || [];
    res.json({
      status: r.status,
      htmlLen: html.length,
      blobs,
      b64chunks: b64chunks.slice(0,3).map(c => ({ len: c.length, preview: c.slice(0,100) })),
      htmlSnippet: html.slice(0, 1000),
    });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// ── Debug: test WASM extraction manually ──────────────────────────────────────
app.get('/debug/wasm/:slug(*)', async (req, res) => {
  const slug = req.params.slug;
  try {
    const m3u8Url = await extractM3U8ViaWasm(slug);
    res.json({ ok: true, m3u8Url });
  } catch(e) {
    res.json({ ok: false, error: e.message, stack: e.stack });
  }
});

// Show raw embed page HTML for debugging
app.get('/debug/embed/:slug(*)', async (req, res) => {
  const slug = req.params.slug;
  try {
    const r = await rawFetch(`${EMBED}/embed/${slug}`, {
      headers: { 'Referer': 'https://ppv.to/', 'Accept': 'text/html',
                 'Accept-Language': 'en-US,en;q=0.9' }
    });
    res.json({
      status: r.status,
      headers: r.headers,
      body: r.text(),
    });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// ── VLC redirect ──────────────────────────────────────────────────────────────
app.get('/open-vlc', (req, res) => {
  const url   = decodeURIComponent(req.query.url   || '');
  const title = decodeURIComponent(req.query.title || 'Stream');
  if (!url) return res.status(400).send('missing url');
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.end(`#EXTM3U\n#EXTINF:-1,${title}\n${url}\n`);
});

app.listen(PORT, () => console.log(`StreamTV v2 (no Puppeteer) on port ${PORT}`));