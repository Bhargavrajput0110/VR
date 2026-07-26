import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const PORT = 3000;
let server;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.gltf': 'model/gltf+json',
  '.bin':  'application/octet-stream',
  '.glb':  'model/gltf-binary',
  '.ico':  'image/x-icon',
};

before(async () => {
  server = http.createServer((req, res) => {
    let reqUrl = req.url.split('?')[0];
    if (reqUrl === '/') reqUrl = '/index.html';
    const filePath = path.join(process.cwd(), reqUrl);

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
    });
  });

  await new Promise((resolve, reject) => {
    server.listen(PORT, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  console.log(`Static server running on http://localhost:${PORT}`);
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    console.log('Static server closed.');
  }
});

test('E2E UI Test - Luceandombra Virtual Try-On', async () => {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream'
    ]
  });

  try {
    const page = await browser.newPage();

    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => console.log('PAGE ERROR:', err.toString()));

    console.log(`Navigating to http://localhost:${PORT}...`);
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'domcontentloaded' });

    // 1. Verify title
    const title = await page.title();
    assert.ok(title.includes('Luceandombra'), `Page title must contain 'Luceandombra', got: ${title}`);

    // 2. Verify #startScreen
    const startScreen = await page.$('#startScreen');
    assert.ok(startScreen !== null, '#startScreen element must exist in DOM');

    const startScreenClasses = await page.$eval('#startScreen', el => el.className);
    assert.ok(startScreenClasses.includes('active'), '#startScreen must have "active" class initially');

    // 3. Verify #startBtn click transition
    const startBtn = await page.$('#startBtn');
    assert.ok(startBtn !== null, '#startBtn element must exist');

    console.log('Clicking #startBtn...');
    await page.click('#startBtn');

    // Allow time for transition / click handler
    await new Promise(r => setTimeout(r, 1000));

    const isStillActive = await page.$eval('#startScreen', el => el.classList.contains('active'));
    assert.strictEqual(isStillActive, false, '#startScreen must lose "active" class after clicking startBtn');
    console.log('UI transition verified successfully.');
  } finally {
    await browser.close();
    console.log('Browser closed.');
  }
});
