const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ── Browser session ──────────────────────────────────────────────────────────
// One shared browser, one page — simple single-user setup

let browser = null;
let page = null;
let capturedStreams = [];

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

async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
      ],
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

    // Intercept all requests to sniff stream URLs
    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = req.url();
      if (!SKIP_PATTERNS.some(p => p.test(url)) && STREAM_PATTERNS.some(p => p.test(url))) {
        const existing = capturedStreams.find(s => s.url === url);
        if (!existing) {
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
  if (/\.mpd/i.test(url)) return 'DASH';
  if (/\.mp4/i.test(url)) return 'MP4';
  if (/\.webm/i.test(url)) return 'WebM';
  return 'Stream';
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Navigate to a URL
app.post('/api/navigate', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });

    const p = await getPage();
    capturedStreams = []; // reset on new navigation

    const fullUrl = url.startsWith('http') ? url : `https://${url}`;
    await p.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Give JS a moment to run
    await new Promise(r => setTimeout(r, 2000));

    const screenshot = await p.screenshot({ type: 'jpeg', quality: 70, encoding: 'base64' });
    const currentUrl = p.url();

    res.json({ screenshot, currentUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Click at x,y coordinates (as % of viewport)
app.post('/api/click', async (req, res) => {
  try {
    const { x, y } = req.body;
    const p = await getPage();
    const vp = p.viewport();

    const px = Math.round((x / 100) * vp.width);
    const py = Math.round((y / 100) * vp.height);

    await p.mouse.click(px, py);
    await new Promise(r => setTimeout(r, 2000));

    const screenshot = await p.screenshot({ type: 'jpeg', quality: 70, encoding: 'base64' });
    const currentUrl = p.url();

    res.json({ screenshot, currentUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scroll the page
app.post('/api/scroll', async (req, res) => {
  try {
    const { direction } = req.body; // 'up' or 'down'
    const p = await getPage();

    await p.evaluate((dir) => {
      window.scrollBy(0, dir === 'down' ? 400 : -400);
    }, direction);

    await new Promise(r => setTimeout(r, 500));
    const screenshot = await p.screenshot({ type: 'jpeg', quality: 70, encoding: 'base64' });

    res.json({ screenshot, currentUrl: p.url() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Go back
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

// Screenshot only (refresh view)
app.get('/api/screenshot', async (req, res) => {
  try {
    const p = await getPage();
    const screenshot = await p.screenshot({ type: 'jpeg', quality: 70, encoding: 'base64' });
    res.json({ screenshot, currentUrl: p.url() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scan current page for stream links
app.get('/api/scan', async (req, res) => {
  try {
    const p = await getPage();

    // Also do a DOM scan on top of network-captured streams
    const domLinks = await p.evaluate((patterns) => {
      const results = [];
      const streamExts = ['.m3u8', '.mpd', '.mp4', '.webm', '.ts'];

      // video/source elements
      document.querySelectorAll('video[src], source[src]').forEach(el => {
        const src = el.src || el.getAttribute('src');
        if (src && src.startsWith('http')) results.push(src);
      });

      // anchor tags
      document.querySelectorAll('a[href]').forEach(el => {
        const href = el.href;
        if (href && streamExts.some(e => href.includes(e))) results.push(href);
      });

      // data attributes
      document.querySelectorAll('[data-src],[data-url],[data-hls],[data-stream],[data-file]').forEach(el => {
        ['data-src','data-url','data-hls','data-stream','data-file'].forEach(attr => {
          const val = el.getAttribute(attr);
          if (val && val.startsWith('http') && streamExts.some(e => val.includes(e))) results.push(val);
        });
      });

      // inline scripts
      document.querySelectorAll('script').forEach(s => {
        const matches = s.textContent.match(/["'`](https?:\/\/[^"'`\s]{8,})["'`]/g) || [];
        matches.forEach(m => {
          const url = m.slice(1, -1);
          if (streamExts.some(e => url.includes(e))) results.push(url);
        });
      });

      return [...new Set(results)];
    }, STREAM_PATTERNS);

    // Merge DOM links with network-captured ones
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
