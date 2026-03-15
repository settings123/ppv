const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const ORIGIN = 'https://ppv.to';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Debug helper ──
function logDebug(...args) { console.log('[DEBUG]', ...args); }

// ── Helper Functions ──
function labelFromSlug(slug) {
  const matchup = slug.split('/').pop() || slug;
  return matchup.split('-').map(p => p.toUpperCase()).join(' vs ').replace(' VS ', ' vs ');
}
function slugFromId(id) {
  return Buffer.from(id.replace(/^nba_/, ''), 'base64url').toString('utf8');
}

// ── Cache ──
const streamCache = new Map(); // slug => { m3u8Url, fetchedAt }

// ── Fetch NBA slugs ──
async function fetchRaw(url) {
  logDebug('Fetching URL:', url);
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Origin': ORIGIN, 'Referer': ORIGIN+'/', 'Accept': 'application/json' } });
  const text = await res.text();
  logDebug(`Fetched ${url} status=${res.status} length=${text.length}`);
  return { status: res.status, body: text };
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
  } catch(e) { logDebug('API error:', e.stack); }
  logDebug('Final slugs:', [...slugs]);
  return [...slugs];
}

// ── WASM Loader ──
let wasmInstance, wasmMemory;

async function loadGASM() {
  if (wasmInstance) return { instance: wasmInstance, memory: wasmMemory };
  const wasmBuffer = fs.readFileSync(path.join(__dirname, 'gasm.wasm'));
  const memory = new WebAssembly.Memory({ initial: 256, maximum: 512 });
  wasmMemory = memory;
  const { instance } = await WebAssembly.instantiate(wasmBuffer, { env: { memory, abort: () => { throw new Error('WASM abort'); } } });
  wasmInstance = instance;
  logDebug('Loaded gasm.wasm');
  return { instance, memory };
}

async function openStreamWASM(slug) {
  logDebug('Opening stream for slug:', slug);
  const embedUrl = `https://pooembed.eu/fetch/${slug}`;
  const { instance, memory } = await loadGASM();

  try {
    const res = await fetch(embedUrl, { headers: { 'User-Agent': UA, 'Origin': ORIGIN, 'Referer': ORIGIN+'/' } });
    if (!res.ok) throw new Error(`Failed fetch /fetch: ${res.status}`);
    const encrypted = Buffer.from(await res.arrayBuffer());
    logDebug(`Encrypted bytes length: ${encrypted.length}`);

    const ptr = instance.exports.malloc(encrypted.length);
    const memBytes = new Uint8Array(memory.buffer, ptr, encrypted.length);
    memBytes.set(encrypted);

    const resultPtr = instance.exports.decrypt(ptr, encrypted.length);

    let offset = resultPtr;
    const out = [];
    const mem = new Uint8Array(memory.buffer);
    while (mem[offset] !== 0) out.push(mem[offset++]);
    const m3u8Url = Buffer.from(out).toString('utf8');
    logDebug('Decrypted m3u8Url:', m3u8Url.slice(0,50)+'...');

    instance.exports.free(ptr);
    instance.exports.free(resultPtr);

    return m3u8Url;
  } catch(err) {
    logDebug('openStreamWASM error:', err.stack);
    throw err;
  }
}

// ── Preload cache on startup ──
async function preloadStreams() {
  const slugs = await getNBAGameSlugs();
  for (const slug of slugs) {
    try {
      const m3u8Url = await openStreamWASM(slug);
      streamCache.set(slug, { m3u8Url, fetchedAt: Date.now() });
      logDebug('Cached stream:', slug);
    } catch(err) { logDebug('Failed to cache slug:', slug, err.stack); }
  }
  logDebug('Preload complete');
}
preloadStreams();

// ── Stremio Endpoints ──
app.get('/manifest.json', (req,res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.json({ id:'com.streamtv.nba', version:'1.0.0', name:'StreamTV NBA', types:['channel'], catalogs:[{type:'channel',id:'nba_live',name:'NBA Live'}], resources:['catalog',{name:'meta',types:['channel'],idPrefixes:['nba_']},{name:'stream',types:['channel'],idPrefixes:['nba_']}], idPrefixes:['nba_'] });
});

app.get('/catalog/channel/nba_live.json', async (req,res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  const slugs = await getNBAGameSlugs();
  const metas = slugs.map(slug=>({
    id:'nba_'+Buffer.from(slug).toString('base64url'),
    type:'channel',
    name:labelFromSlug(slug),
    description:'Live NBA: '+labelFromSlug(slug),
    logo:'https://upload.wikimedia.org/wikipedia/en/thumb/0/03/National_Basketball_Association_logo.svg/200px-National_Basketball_Association_logo.svg.png'
  }));
  logDebug('Catalog returned', metas.length, 'games');
  res.json({ metas });
});

app.get('/meta/channel/:id.json', (req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  let slug; try { slug=slugFromId(req.params.id); } catch { return res.json({meta:{}});}
  res.json({meta:{id:req.params.id,type:'channel',name:labelFromSlug(slug),description:'Live NBA stream',logo:'https://upload.wikimedia.org/wikipedia/en/thumb/0/03/National_Basketball_Association_logo.svg/200px-National_Basketball_Association_logo.svg.png'}});
});

app.get('/stream/channel/:id.json', async (req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  let slug; try { slug=slugFromId(req.params.id); } catch { return res.json({streams:[]});}
  logDebug('Request stream for slug:', slug);

  try {
    let cached = streamCache.get(slug);
    if(!cached){
      logDebug('Not cached, fetching WASM...');
      const m3u8Url = await openStreamWASM(slug);
      cached = { m3u8Url, fetchedAt: Date.now() };
      streamCache.set(slug, cached);
    } else {
      logDebug('Using cached stream');
    }

    const streamUrl = req.protocol+'://'+req.get('host')+'/relay/m3u8?slug='+encodeURIComponent(slug);
    res.json({ streams:[{ name:'StreamTV NBA', title:labelFromSlug(slug), url:streamUrl, behaviorHints:{notWebReady:true} }] });
  } catch(err) { logDebug('Error in /stream/channel/:id.json:', err.stack); res.json({streams:[]}); }
});

// ── Relay ──
app.get('/relay/m3u8', async (req,res)=>{
  const slug = decodeURIComponent(req.query.slug||'');
  if(!slug) return res.status(400).send('missing slug');
  const cached = streamCache.get(slug);
  if(!cached) return res.status(404).send('No session');
  try {
    const r = await fetch(cached.m3u8Url);
    const text = await r.text();
    logDebug('Relay m3u8 length:', text.length);
    const base = cached.m3u8Url.substring(0,cached.m3u8Url.lastIndexOf('/')+1);
    const out = text.split('\n').map(l=>{
      const t=l.trim(); if(!t||t.startsWith('#')) return l;
      return `/relay/seg?slug=${encodeURIComponent(slug)}&cdn=${encodeURIComponent(t.startsWith('http')? t : base+t)}`;
    }).join('\n');
    res.setHeader('Content-Type','application/vnd.apple.mpegurl');
    res.end(out);
  } catch(err){ logDebug('Error in /relay/m3u8:', err.stack); res.status(500).send(err.message); }
});

app.get('/relay/seg', async (req,res)=>{
  const slug = decodeURIComponent(req.query.slug||'');
  const cdnUrl = decodeURIComponent(req.query.cdn||'');
  if(!slug||!cdnUrl) return res.status(400).send('missing params');
  const cached = streamCache.get(slug);
  if(!cached) return res.status(404).send('No session');
  try {
    const r = await fetch(cdnUrl);
    const body = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', /\.m3u8/i.test(cdnUrl)?'application/vnd.apple.mpegurl':'video/mp2t');
    res.end(body);
  } catch(err){ logDebug('Error in /relay/seg:', err.stack); res.status(500).send(err.message); }
});

// ── Start Server ──
app.listen(PORT,'0.0.0.0',()=>console.log(`StreamTV running on port ${PORT}`));