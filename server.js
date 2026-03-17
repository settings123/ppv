'use strict';

const express = require('express');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const fs      = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT  = process.env.PORT || 3000;
const EMBED = 'https://pooembed.eu';
const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function rawFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const { method = 'GET', headers = {}, body = null, maxRedirects = 5 } = opts;
    const mod    = url.startsWith('https') ? https : http;
    const parsed = new URL(url);
    const req = mod.request({
      hostname: parsed.hostname,
      port:     parsed.port || (url.startsWith('https') ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers:  { 'User-Agent': UA, ...headers },
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        const next = res.headers.location.startsWith('http') ? res.headers.location
          : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
        res.resume();
        return rawFetch(next, { ...opts, maxRedirects: maxRedirects - 1 }).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buffer, text: () => buffer.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const NBA_TEAMS = {
  atl:  { name: 'Atlanta Hawks',          espn: 'atl' },
  bos:  { name: 'Boston Celtics',         espn: 'bos' },
  bkn:  { name: 'Brooklyn Nets',          espn: 'bkn' },
  cha:  { name: 'Charlotte Hornets',      espn: 'cha' },
  chi:  { name: 'Chicago Bulls',          espn: 'chi' },
  cle:  { name: 'Cleveland Cavaliers',    espn: 'cle' },
  dal:  { name: 'Dallas Mavericks',       espn: 'dal' },
  den:  { name: 'Denver Nuggets',         espn: 'den' },
  det:  { name: 'Detroit Pistons',        espn: 'det' },
  gs:   { name: 'Golden State Warriors',  espn: 'gsw' },
  hou:  { name: 'Houston Rockets',        espn: 'hou' },
  ind:  { name: 'Indiana Pacers',         espn: 'ind' },
  lac:  { name: 'LA Clippers',            espn: 'lac' },
  lal:  { name: 'Los Angeles Lakers',     espn: 'lal' },
  mem:  { name: 'Memphis Grizzlies',      espn: 'mem' },
  mia:  { name: 'Miami Heat',             espn: 'mia' },
  mil:  { name: 'Milwaukee Bucks',        espn: 'mil' },
  min:  { name: 'Minnesota Timberwolves', espn: 'min' },
  no:   { name: 'New Orleans Pelicans',   espn: 'nop' },
  ny:   { name: 'New York Knicks',        espn: 'nyk' },
  okc:  { name: 'Oklahoma City Thunder',  espn: 'okc' },
  orl:  { name: 'Orlando Magic',          espn: 'orl' },
  phi:  { name: 'Philadelphia 76ers',     espn: 'phi' },
  phx:  { name: 'Phoenix Suns',           espn: 'phx' },
  por:  { name: 'Portland Trail Blazers', espn: 'por' },
  sac:  { name: 'Sacramento Kings',       espn: 'sac' },
  sa:   { name: 'San Antonio Spurs',      espn: 'sas' },
  tor:  { name: 'Toronto Raptors',        espn: 'tor' },
  utah: { name: 'Utah Jazz',              espn: 'uta' },
  wsh:  { name: 'Washington Wizards',     espn: 'wsh' },
};

function teamLogoUrl(abbr) {
  const t = NBA_TEAMS[abbr?.toLowerCase()];
  return t ? `https://a.espncdn.com/combiner/i?img=/i/teamlogos/nba/500/${t.espn}.png&h=200&w=200` : null;
}
function teamName(abbr) {
  return NBA_TEAMS[abbr?.toLowerCase()]?.name || abbr?.toUpperCase() || '?';
}
function parseMatchup(slug) {
  const parts = (slug.split('/').pop() || '').split('-');
  for (let i = 1; i < parts.length; i++) {
    const away = parts.slice(0, i).join('-');
    const home = parts.slice(i).join('-');
    if (NBA_TEAMS[away] && NBA_TEAMS[home]) return { away, home };
  }
  const mid = Math.ceil(parts.length / 2);
  return { away: parts.slice(0, mid).join('-'), home: parts.slice(mid).join('-') };
}
function labelFromSlug(slug) {
  const { away, home } = parseMatchup(slug);
  return `${teamName(away)} vs ${teamName(home)}`;
}

async function getNBAGameSlugs() {
  const slugs = new Set();
  try {
    const r = await rawFetch('https://api.ppv.to/api/streams', {
      headers: { 'Referer': 'https://ppv.to/', 'Accept': 'application/json' }
    });
    const data = JSON.parse(r.text());
    for (const cat of (data.streams || [])) {
      if (!cat.category?.toLowerCase().includes('basketball')) continue;
      for (const s of (cat.streams || [])) {
        const uri = s.uri_name || s.slug || '';
        if (uri.startsWith('nba/')) slugs.add(uri);
        else if (s.iframe?.includes('/nba/')) {
          const m = s.iframe.match(/embed\/(nba\/[^"'\s]+)/);
          if (m) slugs.add(m[1]);
        }
      }
    }
  } catch(e) { console.error('[api]', e.message); }
  console.log('[slugs]', [...slugs]);
  return [...slugs];
}

// ── WASM decryption ───────────────────────────────────────────────────────────
let _wasmBuf = null;
const WASM_PATH = path.join(__dirname, 'gasm.wasm');

async function getWasm() {
  if (_wasmBuf) return _wasmBuf;
  if (fs.existsSync(WASM_PATH)) {
    _wasmBuf = fs.readFileSync(WASM_PATH);
    console.log('[wasm] loaded from disk', _wasmBuf.length);
    return _wasmBuf;
  }
  for (const p of ['/gasm.wasm', '/js/gasm.wasm', '/assets/gasm.wasm', '/static/gasm.wasm']) {
    const r = await rawFetch(EMBED + p, { headers: { 'Referer': EMBED + '/' } });
    console.log('[wasm] probe', p, r.status, r.buffer.length);
    if (r.status === 200 && r.buffer.length > 1000) {
      _wasmBuf = r.buffer;
      fs.writeFileSync(WASM_PATH, _wasmBuf);
      console.log('[wasm] cached', _wasmBuf.length);
      return _wasmBuf;
    }
  }
  return null;
}

async function extractStreamUrl(slug) {
  console.log('[extract] slug=' + slug);
  const r = await rawFetch(`${EMBED}/embed/${slug}`, {
    headers: { 'Referer': 'https://ppv.to/', 'Accept': 'text/html', 'Cache-Control': 'no-cache' }
  });
  const html = r.text();
  console.log('[extract] embed', r.status, html.length);

  // Check for unencrypted URL directly in page
  const direct = html.match(/https?:\/\/lb\d+\.modifiles\.fans\/secure\/[A-Za-z0-9]+\/\d+\/\d+\/[a-z]+\/[^\s"'<]+/);
  if (direct) { console.log('[extract] direct:', direct[0]); return direct[0]; }

  // Get encrypted blob
  const blobMatch = html.match(/window\['([A-Za-z0-9]{8,})'\]\s*=\s*'([A-Za-z0-9+/=]{50,})'/);
  if (!blobMatch) {
    console.log('[extract] html:', html.slice(0, 300));
    throw new Error('No stream blob in embed page');
  }
  const encBlob = blobMatch[2];
  console.log('[extract] blob key=' + blobMatch[1] + ' len=' + encBlob.length);

  const wasmBuf = await getWasm();
  if (!wasmBuf) throw new Error('gasm.wasm not available');

  const wasmAB = wasmBuf.buffer.slice(wasmBuf.byteOffset, wasmBuf.byteOffset + wasmBuf.byteLength);
  let instance;
  try {
    ({ instance } = await WebAssembly.instantiate(wasmAB, {
      env: { memory: new WebAssembly.Memory({ initial: 256 }) },
      wasi_snapshot_preview1: { fd_write:()=>0, fd_close:()=>0, fd_seek:()=>0, proc_exit:()=>{}, environ_get:()=>0, environ_sizes_get:()=>0 },
    }));
  } catch {
    ({ instance } = await WebAssembly.instantiate(wasmAB, {}));
  }
  console.log('[wasm] exports:', Object.keys(instance.exports).join(', '));

  const mem = instance.exports.memory || new WebAssembly.Memory({ initial: 256 });
  const blobBytes = Buffer.from(encBlob, 'base64');
  new Uint8Array(mem.buffer).set(blobBytes, 0);

  for (const [name, fn] of Object.entries(instance.exports)) {
    if (typeof fn !== 'function') continue;
    try {
      const result = fn(0, blobBytes.length);
      if (typeof result === 'number' && result > 0 && result < mem.buffer.byteLength) {
        const out = Buffer.from(mem.buffer, result).toString('utf8').split('\0')[0];
        console.log('[wasm] fn=' + name + ' out=' + out.slice(0,100));
        if (out.includes('modifiles') || out.includes('.m3u8')) return out.trim();
      }
    } catch {}
  }

  throw new Error('WASM could not decrypt. exports=' + Object.keys(instance.exports).join(','));
}

// ── Sessions & relay ──────────────────────────────────────────────────────────
const sessions = new Map();

function rewriteM3U8(text, baseUrl, slug) {
  const base = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
  const s    = encodeURIComponent(slug);
  return text.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const abs = t.startsWith('http') ? t : base + t;
    return `/relay/seg?slug=${s}&cdn=${encodeURIComponent(abs)}`;
  }).join('\n');
}

app.get('/relay/m3u8', async (req, res) => {
  const slug = decodeURIComponent(req.query.slug || '');
  if (!slug) return res.status(400).send('missing slug');
  let url = sessions.get(slug);
  if (!url) {
    try { url = await extractStreamUrl(slug); sessions.set(slug, url); }
    catch(e) { return res.status(504).send(e.message); }
  }
  try {
    const r = await rawFetch(url, { headers: { Referer: EMBED + '/' } });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.end(rewriteM3U8(r.text(), url, slug));
  } catch(e) { res.status(500).send(e.message); }
});

app.get('/relay/seg', async (req, res) => {
  const slug = decodeURIComponent(req.query.slug || '');
  const cdn  = decodeURIComponent(req.query.cdn  || '');
  if (!cdn) return res.status(400).send('missing cdn');
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const r = await rawFetch(cdn, { headers: { Referer: EMBED + '/' } });
    if (/\.m3u8/i.test(cdn)) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.end(rewriteM3U8(r.text(), cdn, slug));
    }
    res.setHeader('Content-Type', 'video/mp2t');
    res.end(r.buffer);
  } catch(e) { res.status(500).send(e.message); }
});

// ── Poster ────────────────────────────────────────────────────────────────────
app.get('/poster/:slug(*)', (req, res) => {
  const { away, home } = parseMatchup(req.params.slug);
  const al = teamLogoUrl(away) || '', hl = teamLogoUrl(home) || '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="400" height="600" viewBox="0 0 400 600">
<rect width="400" height="600" fill="#0a0a1a"/>
<rect x="155" y="24" width="90" height="26" rx="13" fill="#e63946"/>
<text x="200" y="42" font-family="Arial" font-size="12" font-weight="700" fill="white" text-anchor="middle">LIVE</text>
${al ? `<image href="${al}" x="20" y="90" width="160" height="160" preserveAspectRatio="xMidYMid meet"/>` : `<text x="100" y="185" font-family="Arial" font-size="48" fill="#fff" text-anchor="middle">${away.toUpperCase()}</text>`}
${hl ? `<image href="${hl}" x="220" y="90" width="160" height="160" preserveAspectRatio="xMidYMid meet"/>` : `<text x="300" y="185" font-family="Arial" font-size="48" fill="#fff" text-anchor="middle">${home.toUpperCase()}</text>`}
<text x="200" y="285" font-family="Arial" font-size="20" font-weight="900" fill="#c8a84b" text-anchor="middle">VS</text>
<text x="100" y="275" font-family="Arial" font-size="10" fill="#fff" text-anchor="middle" opacity="0.8">${teamName(away)}</text>
<text x="300" y="275" font-family="Arial" font-size="10" fill="#fff" text-anchor="middle" opacity="0.8">${teamName(home)}</text>
<rect x="0" y="520" width="400" height="80" fill="#000" opacity="0.5"/>
<text x="200" y="560" font-family="Arial" font-size="13" font-weight="700" fill="#c8a84b" text-anchor="middle">NBA LIVE</text>
</svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.end(svg);
});

// ── Stremio ───────────────────────────────────────────────────────────────────
app.get('/s', (req, res) => res.redirect('/manifest.json'));

app.get('/manifest.json', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({
    id: 'com.streamtv.nba', version: '4.0.0',
    name: 'StreamTV NBA', description: 'Live NBA streams',
    types: ['channel'],
    catalogs: [{ type: 'channel', id: 'nba_live', name: 'NBA Live' }],
    resources: ['catalog', { name: 'meta', types: ['channel'], idPrefixes: ['nba_'] }, { name: 'stream', types: ['channel'], idPrefixes: ['nba_'] }],
    idPrefixes: ['nba_'],
  });
});

function slugFromId(id) {
  return Buffer.from(id.replace(/^nba_/, ''), 'base64url').toString('utf8');
}

app.get('/catalog/channel/nba_live.json', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const base = req.protocol + '://' + req.get('host');
  try {
    const metas = (await getNBAGameSlugs()).map(slug => {
      const { away, home } = parseMatchup(slug);
      return {
        id: 'nba_' + Buffer.from(slug).toString('base64url'),
        type: 'channel', name: labelFromSlug(slug),
        description: `${teamName(away)} @ ${teamName(home)}`,
        poster: `${base}/poster/${encodeURIComponent(slug)}`,
        posterShape: 'poster',
        background: teamLogoUrl(home) || '',
        logo: teamLogoUrl(away) || '',
      };
    });
    res.json({ metas });
  } catch(e) { res.json({ metas: [] }); }
});

app.get('/meta/channel/:id.json', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const base = req.protocol + '://' + req.get('host');
  let slug;
  try { slug = slugFromId(req.params.id); } catch { return res.json({ meta: {} }); }
  const { away, home } = parseMatchup(slug);
  res.json({ meta: {
    id: req.params.id, type: 'channel', name: labelFromSlug(slug),
    description: `${teamName(away)} @ ${teamName(home)}`,
    poster: `${base}/poster/${encodeURIComponent(slug)}`,
    posterShape: 'poster',
    background: teamLogoUrl(home) || '',
    logo: teamLogoUrl(away) || '',
  }});
});

app.get('/stream/channel/:id.json', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  let slug;
  try { slug = slugFromId(req.params.id); } catch { return res.json({ streams: [] }); }
  console.log('[stream] slug:', slug);
  try {
    const m3u8 = await extractStreamUrl(slug);
    sessions.set(slug, m3u8);
    const base = req.protocol + '://' + req.get('host');
    res.json({ streams: [{ name: 'StreamTV', title: labelFromSlug(slug), url: `${base}/relay/m3u8?slug=${encodeURIComponent(slug)}` }] });
  } catch(e) {
    console.error('[stream] error:', e.message);
    res.json({ streams: [] });
  }
});

// ── Debug ─────────────────────────────────────────────────────────────────────
app.get('/debug', async (req, res) => {
  try {
    const r    = await rawFetch('https://api.ppv.to/api/streams', { headers: { Referer: 'https://ppv.to/' } });
    const data = JSON.parse(r.text());
    const slugs = new Set();
    for (const cat of (data.streams || [])) {
      if (!cat.category?.toLowerCase().includes('basketball')) continue;
      for (const s of (cat.streams || [])) { if ((s.uri_name||'').startsWith('nba/')) slugs.add(s.uri_name); }
    }
    res.json({ time: new Date().toISOString(), sessions: [...sessions.keys()], nba_slugs: [...slugs], categories: data.streams?.map(c => c.category) });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/debug/extract/:slug(*)', async (req, res) => {
  try { res.json({ ok: true, url: await extractStreamUrl(req.params.slug) }); }
  catch(e) { res.json({ ok: false, error: e.message }); }
});

app.get('/debug/embed/:slug(*)', async (req, res) => {
  const r = await rawFetch(`${EMBED}/embed/${req.params.slug}`, { headers: { Referer: 'https://ppv.to/' } });
  res.json({ status: r.status, body: r.text() });
});

app.get('/debug/probe', async (req, res) => {
  const slug  = req.query.slug || 'nba/2026-03-17/lal-hou';
  const embed = await rawFetch(`${EMBED}/embed/${slug}`, { headers: { Referer: 'https://ppv.to/' } });
  const html  = embed.text();
  const probes = {};
  for (const p of ['/gasm.wasm','/js/gasm.wasm','/assets/gasm.wasm','/gasm.js','/js/gasm.js','/player.js','/embed.js']) {
    const r = await rawFetch(EMBED + p, { headers: { Referer: EMBED + '/' } });
    probes[p] = { status: r.status, len: r.buffer.length, preview: r.buffer.slice(0,20).toString('hex') };
  }
  const blobs = {};
  for (const m of html.matchAll(/window\['([A-Za-z0-9]{8,})'\]\s*=\s*'([A-Za-z0-9+/=]{50,})'/g))
    blobs[m[1]] = { len: m[2].length, val: m[2] };
  res.json({ embedStatus: embed.status, htmlLen: html.length, blobs, probes });
});


app.get('/debug/fetch/:slug(*)', async (req, res) => {
  const slug = req.params.slug;
  const results = {};
  // POST with slug= body
  try {
    const r = await rawFetch(`${EMBED}/fetch`, {
      method: 'POST',
      headers: { 'Referer': `${EMBED}/embed/${slug}`, 'Origin': EMBED, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `slug=${encodeURIComponent(slug)}`,
    });
    results.post = { status: r.status, len: r.buffer.length, hex: r.buffer.slice(0,64).toString('hex'), utf8: r.buffer.slice(0,300).toString('utf8'), b64: r.buffer.toString('base64') };
  } catch(e) { results.post = { error: e.message }; }
  // GET /fetch/slug
  try {
    const r = await rawFetch(`${EMBED}/fetch/${encodeURIComponent(slug)}`, {
      headers: { 'Referer': `${EMBED}/embed/${slug}`, 'Origin': EMBED }
    });
    results.get = { status: r.status, len: r.buffer.length, hex: r.buffer.slice(0,64).toString('hex'), utf8: r.buffer.slice(0,300).toString('utf8') };
  } catch(e) { results.get = { error: e.message }; }
  res.json(results);
});

app.listen(PORT, () => console.log(`StreamTV v4 on port ${PORT}`));
