const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const http = require('http');
const https = require('https');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const STREAM_PATTERNS = [
  /\.m3u8(\?|$)/i,
  /\.mpd(\?|$)/i,
  /\.mp4(\?|$)/i,
  /\.webm(\?|$)/i,
  /\.ts(\?|$)/i,
  /\/manifest(\?|$)/i,
  /\/playlist(\?|$)/i,
  /\/chunklist/i,
  /\/master\.m3u8/i,
];

const SKIP_PATTERNS = [
  /google|facebook|twitter|analytics|doubleclick|googlesyndication/i,
  /\.(jpg|jpeg|png|gif|webp|svg|ico|css|woff|woff2|ttf)(\?|$)/i,
];

// ── Browser session ───────────────────────────────────────────────────────────

let browser = null;
let page = null;
let capturedStreams = [];

async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
  }
  return browser;
}

async function getPage() {
  const b = await getBrowser();
  if (!page || page.isClosed()) {
    page = await b.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 720 });

    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = req.url();
      if (!SKIP_PATTERNS.some(p => p.test(url)) && STREAM_PATTERNS.some(p => p.test(url))) {
        if (!capturedStreams.find(s => s.url === url)) {
          capturedStreams.push({ url, label: deriveLabel(url), type: deriveType(url), source: 'network' });
        }
      }
      req.continue();
    });
  }
  return page;
}

function deriveLabel(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1] || '';
    return last.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ') || u.hostname;
  } catch { return url.slice(0, 60); }
}

function deriveType(url) {
  if (/\.m3u8/i.test(url)) return 'HLS';
  if (/\.mpd/i.test(url))  return 'DASH';
  if (/\.mp4/i.test(url))  return 'MP4';
  if (/\.webm/i.test(url)) return 'WebM';
  return 'Stream';
}

// ── Proxy route ───────────────────────────────────────────────────────────────
// Fetches any stream URL server-side and pipes it back, adding CORS headers.
// Also rewrites m3u8 segment URLs so subsequent requests also go through proxy.
app.get('/proxy', async (req, res) => {
  const streamUrl = req.query.url;
  if (!streamUrl) return res.status(400).send('no url');

  // Unwrap double-proxied URLs
  const finalUrl = streamUrl.startsWith('http://localhost') || streamUrl.startsWith('https://localhost')
    ? decodeURIComponent(new URL(streamUrl).searchParams.get('url') || streamUrl)
    : streamUrl;

  console.log('PROXY:', finalUrl);

  const isSegment = /\.(ts|jpg|jpeg|png|aac|mp4|m4s)(\?|$)/i.test(finalUrl);
  const isM3U8 = /\.m3u8(\?|$)/i.test(finalUrl) || finalUrl.includes('playlist') || finalUrl.includes('manifest');

  if (isSegment) {
    // Pipe directly — CDN doesn't care about Referer
    const client = finalUrl.startsWith('https') ? https : http;
    client.get(finalUrl, { headers: { 'User-Agent': UA } }, (upstream) => {
      console.log('SEGMENT STATUS:', upstream.statusCode, finalUrl);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', upstream.headers['content-type'] || 'video/mp2t');
      res.writeHead(upstream.statusCode);
      upstream.pipe(res);
    }).on('error', e => res.status(500).send(e.message));
    return;
  }

  // For m3u8 — use Puppeteer to get it with auth cookies
  try {
    const p = await getPage();
    const result = await p.evaluate(async (url) => {
      const r = await fetch(url);
      const text = await r.text();
      return { status: r.status, contentType: r.headers.get('content-type') || '', text };
    }, finalUrl);

    console.log('STATUS:', result.status, finalUrl);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', result.contentType || 'application/vnd.apple.mpegurl');
    res.writeHead(result.status);

    if (isM3U8) {
      const base = finalUrl.substring(0, finalUrl.lastIndexOf('/') + 1);
      const rewritten = result.text.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        if (trimmed.includes('localhost') || trimmed.startsWith('/proxy')) return line;
        if (trimmed.startsWith('http')) {
          return '/proxy?url=' + encodeURIComponent(trimmed);
        }
        return '/proxy?url=' + encodeURIComponent(base + trimmed);
      }).join('\n');
      res.end(rewritten);
    } else {
      res.end(result.text);
    }
  } catch (err) {
    console.error('PROXY ERROR:', err.message);
    res.status(500).send('Proxy error: ' + err.message);
  }
});
// ── Browser API routes ────────────────────────────────────────────────────────

app.post('/api/navigate', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    const p = await getPage();
    capturedStreams = [];
    const fullUrl = url.startsWith('http') ? url : `https://${url}`;
    await p.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    const screenshot = await p.screenshot({ type: 'jpeg', quality: 70, encoding: 'base64' });
    res.json({ screenshot, currentUrl: p.url() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/click', async (req, res) => {
  try {
    const { x, y } = req.body;
    const p = await getPage();
    const vp = p.viewport();
    await p.mouse.click(Math.round((x / 100) * vp.width), Math.round((y / 100) * vp.height));
    await new Promise(r => setTimeout(r, 2000));
    const screenshot = await p.screenshot({ type: 'jpeg', quality: 70, encoding: 'base64' });
    res.json({ screenshot, currentUrl: p.url() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scroll', async (req, res) => {
  try {
    const { direction } = req.body;
    const p = await getPage();
    await p.evaluate(dir => window.scrollBy(0, dir === 'down' ? 400 : -400), direction);
    await new Promise(r => setTimeout(r, 500));
    const screenshot = await p.screenshot({ type: 'jpeg', quality: 70, encoding: 'base64' });
    res.json({ screenshot, currentUrl: p.url() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/back', async (req, res) => {
  try {
    const p = await getPage();
    await p.goBack({ waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 1500));
    const screenshot = await p.screenshot({ type: 'jpeg', quality: 70, encoding: 'base64' });
    res.json({ screenshot, currentUrl: p.url() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scan', async (req, res) => {
  try {
    const p = await getPage();
    const domLinks = await p.evaluate(() => {
      const results = [];
      const exts = ['.m3u8', '.mpd', '.mp4', '.webm', '.ts'];
      document.querySelectorAll('video[src], source[src]').forEach(el => {
        const src = el.src || el.getAttribute('src');
        if (src && src.startsWith('http')) results.push(src);
      });
      document.querySelectorAll('a[href]').forEach(el => {
        if (el.href && exts.some(e => el.href.includes(e))) results.push(el.href);
      });
      document.querySelectorAll('[data-src],[data-url],[data-hls],[data-stream],[data-file]').forEach(el => {
        ['data-src','data-url','data-hls','data-stream','data-file'].forEach(attr => {
          const val = el.getAttribute(attr);
          if (val && val.startsWith('http') && exts.some(e => val.includes(e))) results.push(val);
        });
      });
      document.querySelectorAll('script').forEach(s => {
        const matches = s.textContent.match(/["'`](https?:\/\/[^"'`\s]{8,})["'`]/g) || [];
        matches.forEach(m => {
          const url = m.slice(1, -1);
          if (exts.some(e => url.includes(e))) results.push(url);
        });
      });
      return [...new Set(results)];
    });

    domLinks.forEach(url => {
      if (!capturedStreams.find(s => s.url === url)) {
        capturedStreams.push({ url, label: deriveLabel(url), type: deriveType(url), source: 'dom' });
      }
    });

    res.json({ streams: capturedStreams });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`StreamTV running on port ${PORT}`));
