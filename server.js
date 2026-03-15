// ── Imports ───────────────────────────────────────────────────────────────────
const express = require('express');
const path = require('path');
const fs = require('fs');
const fetch = (...args) => import('node-fetch').then(mod => mod.default(...args));
const { Buffer } = require('buffer');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const ORIGIN = 'https://ppv.to';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Helper Functions ──────────────────────────────────────────────────────────
function labelFromSlug(slug) {
  const matchup = slug.split('/').pop() || slug;
  return matchup.split('-').map(p => p.toUpperCase()).join(' vs ').replace(' VS ', ' vs ');
}

function slugFromId(id) {
  return Buffer.from(id.replace(/^nba_/, ''), 'base64url').toString('utf8');
}

// ── Session & Cache ───────────────────────────────────────────────────────────
const sessions = new Map();   // for relay headers
const streamCache = new Map(); // for preloaded streams { slug => { m3u8Url, fetchedAt } }

// ── Fetch NBA Slugs ──────────────────────────────────────────────────────────
async function fetchRaw(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Origin': ORIGIN, 'Referer': ORIGIN+'/', 'Accept': 'application/json' }
  });
  return { status: res.status, body: await res.text() };
}

function extractSlugsFromApi(data, slugs) {
  if (!data || !Array.isArray(data.streams)) return;
  for (const cat of data.streams) {
    if (!cat.category || !cat.category.toLowerCase().includes('basketball')) continue;
    if (!Array.isArray(cat.streams)) continue;
    for (const s of cat.streams) if (s.slug) slugs.add(s.slug);
  }
}

async function getNBAGameSlugs() {
  const slugs = new Set();
  try {
    const { status, body } = await fetchRaw('https://api.ppv.to/api/streams');
    if (status === 200) {
      const data = JSON.parse(body);
      extractSlugsFromApi(data, slugs);
    }
  } catch (e) { console.log(`API error: ${e.message}`); }
  return [...slugs];
}

// ── Server-side WASM Setup ───────────────────────────────────────────────────
let gasmWasm, gasmMemory;

async function loadGASM() {
  if (gasmWasm) return { instance: gasmWasm, memory: gasmMemory };

  const wasmPath = path.join(__dirname, 'gasm.wasm');
  const wasmBuffer = fs.readFileSync(wasmPath);

  const memory = new WebAssembly.Memory({ initial: 256, maximum: 512 });
  gasmMemory = memory;

  const importObj = {
    env: {
      memory,
      abort: () => { throw new Error('WASM abort'); }
    }
  };

  const { instance } = await WebAssembly.instantiate(wasmBuffer, importObj);
  gasmWasm = instance;
  return { instance, memory };
}

async function openStreamWASM(slug) {
  const embedUrl = `https://pooembed.eu/fetch/${slug}`;
  const { instance, memory } = await loadGASM();

  const res = await fetch(embedUrl, { headers: { 'User-Agent': UA, 'Origin': ORIGIN, 'Referer': ORIGIN+'/' } });
  if (!res.ok) throw new Error('Failed to fetch encrypted stream');
  const encrypted = Buffer.from(await res.arrayBuffer());

  // Allocate memory in WASM
  const ptr = instance.exports.malloc(encrypted.length);
  const memBytes = new Uint8Array(memory.buffer, ptr, encrypted.length);
  memBytes.set(encrypted);

  // Call WASM decrypt function
  const resultPtr = instance.exports.decrypt(ptr, encrypted.length);

  // Read result
  let offset = resultPtr;
  const out = [];
  const mem = new Uint8Array(memory.buffer);
  while (mem[offset] !== 0) out.push(mem[offset++]);
  const m3u8Url = Buffer.from(out).toString('utf8');

  instance.exports.free(ptr);
  instance.exports.free(resultPtr);

  return m3u8Url;
}

// ── Preload Streams ───────────────────────────────────────────────────────────
async function preloadStreams() {
  try {
    console.log('[preloadStreams] fetching NBA slugs…');
    const slugs = await getNBAGameSlugs();
    console.log(`[preloadStreams] found ${slugs.length} slugs`);

    for (const slug of slugs) {
      try {
        const m3u8Url = await openStreamWASM(slug);
        streamCache.set(slug, { m3u8Url, fetchedAt: Date.now() });
        console.log(`[preloadStreams] cached: ${slug}`);
      } catch (err) {
        console.log(`[preloadStreams] failed: ${slug} -> ${err.message}`);
      }
    }
    console.log('[preloadStreams] done');
  } catch (err) {
    console.error('[preloadStreams] error:', err.message);
  }
}

// Call preload at server start
preloadStreams();

// ── Stremio Addon Endpoints ──────────────────────────────────────────────────
app.get('/manifest.json', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({
    id: 'com.streamtv.nba',
    version: '1.0.0',
    name: 'StreamTV NBA',
    description: 'Live NBA streams from ppv.to',
    types: ['channel'],
    catalogs: [{ type: 'channel', id: 'nba_live', name: 'NBA Live' }],
    resources: [
      'catalog',
      { name: 'meta', types: ['channel'], idPrefixes: ['nba_'] },
      { name: 'stream', types: ['channel'], idPrefixes: ['nba_'] }
    ],
    idPrefixes: ['nba_']
  });
});

app.get('/catalog/channel/nba_live.json', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const slugs = await getNBAGameSlugs();
    const metas = slugs.map(slug => ({
      id: 'nba_' + Buffer.from(slug).toString('base64url'),
      type: 'channel',
      name: labelFromSlug(slug),
      description: 'Live NBA: ' + labelFromSlug(slug),
      logo: 'https://upload.wikimedia.org/wikipedia/en/thumb/0/03/National_Basketball_Association_logo.svg/200px-National_Basketball_Association_logo.svg.png'
    }));
    res.json({ metas });
  } catch (e) { res.json({ metas: [] }); }
});

app.get('/meta/channel/:id.json', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const id = req.params.id;
  let slug;
  try { slug = slugFromId(id); } catch { return res.json({ meta: {} }); }
  res.json({
    meta: {
      id,
      type: 'channel',
      name: labelFromSlug(slug),
      description: 'Live NBA stream',
      logo: 'https://upload.wikimedia.org/wikipedia/en/thumb/0/03/National_Basketball_Association_logo.svg/200px-National_Basketball_Association_logo.svg.png'
    }
  });
});

app.get('/stream/channel/:id.json', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const id = req.params.id;
  let slug;
  try { slug = slugFromId(id); } catch { return res.json({ streams: [] }); }

  try {
    let session = streamCache.get(slug);
    if (!session) {
      const m3u8Url = await openStreamWASM(slug);
      session = { m3u8Url, fetchedAt: Date.now() };
      streamCache.set(slug, session);
    }

    const streamUrl = req.protocol + '://' + req.get('host') + '/relay/m3u8?slug=' + encodeURIComponent(slug);
    sessions.set(slug, { m3u8Url: session.m3u8Url, reqHeaders: {} });

    res.json({
      streams: [{
        name: 'StreamTV NBA',
        title: labelFromSlug(slug),
        url: streamUrl,
        behaviorHints: { notWebReady: true }
      }]
    });
  } catch (err) {
    console.error('[stremio stream WASM] error:', err.message);
    res.json({ streams: [] });
  }
});

// ── Relay Endpoints ──────────────────────────────────────────────────────────
app.get('/relay/m3u8', async (req, res) => {
  const slug = decodeURIComponent(req.query.slug || '');
  if (!slug) return res.status(400).send('missing slug');
  const session = sessions.get(slug);
  if (!session) return res.status(404).send('No session — click a game first');

  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const r = await fetch(session.m3u8Url);
    const text = await r.text();
    const base = session.m3u8Url.substring(0, session.m3u8Url.lastIndexOf('/') + 1);
    const safeSlug = encodeURIComponent(slug);

    const out = text.split('\n').map(line => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      if (t.startsWith('http')) return `/relay/seg?slug=${safeSlug}&cdn=${encodeURIComponent(t)}`;
      return `/relay/seg?slug=${safeSlug}&cdn=${encodeURIComponent(base + t)}`;
    }).join('\n');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.end(out);
  } catch (err) { res.status(500).send(err.message); }
});

app.get('/relay/seg', async (req, res) => {
  const slug = decodeURIComponent(req.query.slug || '');
  const cdnUrl = decodeURIComponent(req.query.cdn || '');
  if (!slug || !cdnUrl) return res.status(400).send('missing params');

  const session = sessions.get(slug);
  if (!session) return res.status(404).send('No session');

  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const r = await fetch(cdnUrl);
    const body = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', /\.m3u8/i.test(cdnUrl) ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
    res.end(body);
  } catch (err) { res.status(500).send(err.message); }
});

// ── Playlist / open-vlc ───────────────────────────────────────────────────────
app.get('/open-vlc', (req, res) => {
  const url = decodeURIComponent(req.query.url || '');
  const title = decodeURIComponent(req.query.title || 'Stream');
  if (!url) return res.status(400).send('missing url');

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Content-Disposition', 'inline; filename="stream.m3u8"');
  res.end(`#EXTM3U\n#EXTINF:-1,${title}\n${url}\n`);
});

// ── Start Server ──────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`StreamTV running on port ${PORT}`);
});
