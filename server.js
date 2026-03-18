const express = require('express');
const fetch = require('node-fetch');
const puppeteer = require('puppeteer');
const app = express();

const PORT = process.env.PORT || 7000;
const HOST = process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${PORT}`;

const SUPPORTED_CATEGORIES = ['Basketball', 'Football', 'Ice Hockey', 'Motorsports', 'Wrestling', '24/7 Streams'];

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
  for (const cat of categories) {
    for (const stream of cat.streams || []) {
      all.push({ ...stream, category_name: cat.category });
    }
  }
  return all;
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
    background: stream.poster || '',
    description: `${stream.tag} — ${stream.category_name}`,
    genres: [stream.category_name],
    releaseInfo: isLive ? 'LIVE' : isUpcoming ? new Date(stream.starts_at * 1000).toLocaleString() : 'Ended'
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

async function extractM3u8FromEmbed(iframeUrl) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    let m3u8Url = null;

    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = request.url();
      if (url.includes('modifiles') || url.includes('m3u8') || url.includes('fetch')) {
        console.log('REQUEST:', url);
      }
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
      if (url.includes('modifiles') || url.includes('m3u8')) {
        console.log('RESPONSE:', response.status(), url);
      }
      if (url.includes('pooembed.eu/fetch')) {
        console.log('FETCH RESPONSE status:', response.status());
        try {
          const buf = await response.buffer();
          console.log('FETCH RESPONSE bytes:', buf.length, 'hex:', buf.slice(0,20).toString('hex'));
        } catch(e) {
          console.log('FETCH RESPONSE read error:', e.message);
        }
      }
    });

    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

    await page.setExtraHTTPHeaders({ 'Referer': 'https://ppv.to/' });
    await page.goto(iframeUrl, { waitUntil: 'networkidle2', timeout: 20000 });

    if (!m3u8Url) {
      await new Promise(resolve => {
        const interval = setInterval(() => {
          if (m3u8Url) { clearInterval(interval); resolve(); }
        }, 500);
        setTimeout(() => { clearInterval(interval); resolve(); }, 20000);
      });
    }

    return m3u8Url;
  } catch (e) {
    console.error('Puppeteer error:', e.message);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

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
    content = content.replace(/\.jpg\?/g, '.ts?');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(content);
  } catch (e) {
    console.error('Proxy error:', e);
    res.status(500).send('Proxy error');
  }
});

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
      const m3u8Url = await extractM3u8FromEmbed(iframeUrl);
      if (!m3u8Url) { console.log('No m3u8 found'); continue; }
      console.log(`Found: ${m3u8Url}`);
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
  console.log(`   ${HOST}/manifest.json\n`);
});
