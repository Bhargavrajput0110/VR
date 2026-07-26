# Explorer 2 Handoff Report: Test Framework & `npm test` Setup

## 1. Observation

### File & Setup Inspection Results
1. **`d:\Luceandombra\package.json`**:
   - Lines 5–8:
     ```json
     "scripts": {
       "start": "npx serve . -l 3000",
       "dev": "npx serve . -l 3000"
     }
     ```
   - Observed that there is NO `"test"` script specified in `scripts`. Executing `npm test` directly in the current state produces `npm ERR! Missing script: "test"`.
   - Dependencies line 9-11: `"three": "^0.160.0"`. `devDependencies` block is absent.

2. **`d:\Luceandombra\node_modules`**:
   - Directories present: `@puppeteer`, `@puppeteer/browsers`, `puppeteer`, `puppeteer-core`, `three`, `ws`, `yargs`, `chromium-bidi`, `devtools-protocol`.
   - Verified absence of standard test frameworks: `jest`, `mocha`, `vitest`, `ava`, `jasmine`, or `playwright` are NOT installed in `node_modules`.
   - `puppeteer` is fully installed and available in `node_modules/puppeteer`.

3. **`d:\Luceandombra\test.js`**:
   - Verbatim content (29 lines):
     ```javascript
     const puppeteer = require('puppeteer');

     (async () => {
       console.log('Launching browser...');
       const browser = await puppeteer.launch({
         headless: true,
         args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
       });
       const page = await browser.newPage();

       page.on('console', msg => console.log('PAGE LOG:', msg.text()));
       page.on('pageerror', err => console.log('PAGE ERROR:', err.toString()));

       console.log('Navigating to http://localhost:58088...');
       await page.goto('http://localhost:58088');

       console.log('Waiting for load...');
       await new Promise(r => setTimeout(r, 2000));

       console.log('Clicking Start Try-On...');
       await page.evaluate(() => document.getElementById('startBtn').click());

       console.log('Waiting for AI load...');
       await new Promise(r => setTimeout(r, 5000));

       await browser.close();
       console.log('Done.');
     })();
     ```
   - Key issues identified in `test.js`:
     - Line 15 targets `http://localhost:58088`, whereas `package.json` `start`/`dev` scripts host on port `3000` (`serve . -l 3000`).
     - Line 15 throws `net::ERR_CONNECTION_REFUSED` if no HTTP server is already running out-of-band on port 58088 before `test.js` is executed.
     - Lacks assertion checks (e.g. using `assert`) to validate DOM changes or expected state after clicking `#startBtn`.
     - Lacks test framework wrapper or TAP output for clean pass/fail reporting.

---

## 2. Logic Chain

1. **Absence of `"test"` script in `package.json`**:
   - `npm test` requires a `"test"` key inside `"scripts"` in `package.json`. Without it, `npm test` fails immediately with `Missing script: "test"`.

2. **Test Framework Selection**:
   - Third-party test runners (`jest`, `vitest`, `mocha`) are not present in `node_modules`.
   - Node.js (v18+) includes a native, zero-dependency test runner (`node --test`) and assertion library (`node:assert`).
   - Using Node's native test runner (`node --test`) requires zero additional package installations, matches the project's lightweight design, and natively outputs formatted test results with appropriate exit codes (0 for pass, 1 for fail).

3. **Web Server Lifecycle Management**:
   - `test.js` uses `puppeteer` to test an HTML web application (`index.html`, `app.js`).
   - Puppeteer requires an active HTTP server serving project root files (`index.html`, `app.js`, `style.css`, `models/`).
   - Hardcoding port `58088` without starting a server causes test failure.
   - Therefore, the test script must either:
     a. Programmatically launch a lightweight Node `http` static file server on port 3000 during the `before` hook and close it in the `after` hook, OR
     b. Run against port 3000 with server startup handled by a test runner script (`start-server-and-test` or inline node server).
   - Programmatically starting a lightweight Node `http` server directly inside `test.js` before launching Puppeteer is self-contained and requires zero extra dependencies.

4. **Assertion & Exit Code Requirements**:
   - `node:assert` should be used to verify:
     1. Page title matches `Luceandombra — Virtual Try-On`.
     2. `#startScreen` element initially has class `active`.
     3. `#startBtn` click triggers transition, adding class `hidden` to `#startScreen`.
     4. No uncaught JavaScript page errors were thrown during page execution.
   - When assertions succeed, `node --test` exits with code `0` and prints `✔ test name`.
   - When any assertion fails or uncaught error occurs, `node --test` exits with code `1` and prints `✖ test name` with stack trace.

---

## 3. Caveats

- **Network Restrictions / Offline Execution**: In CODE_ONLY environment mode or offline mode, installing new npm packages (like `jest` or `mocha`) via `npm install` may be restricted or fail. Node's built-in `node:test` runner completely avoids network dependency.
- **MediaPipe CDN Load**: `index.html` line 24 loads `@mediapipe/tasks-vision` from `https://cdn.jsdelivr.net/npm/...`. In headless Puppeteer without internet access, MediaPipe CDN script fetch will fail, which is captured by the `pageerror` listener. Test assertions should account for DOM interaction even if external CDN calls timeout.

---

## 4. Conclusion

To achieve a clean, robust `npm test` setup:
1. Update `package.json` to include `"test": "node --test"`.
2. Refactor `test.js` to leverage Node's built-in `node:test` and `node:assert/strict` modules.
3. Integrate an automatic static `http` server in `test.js` (`before`/`after` hooks) on port 3000 to ensure `npm test` is fully self-contained and runnable out-of-the-box.
4. Include explicit assertion checks for UI components (`#startScreen`, `#startBtn`, title) and page error tracking.

---

## 5. Verification Method

### Recommended Implementation Snippets

#### A. Proposed `package.json` Patch
```json
{
  "name": "luceandombra-virtual-tryon",
  "version": "12.0.0",
  "description": "Luceandombra — Lenskart-level Virtual Try-On with real 3D GLB frames",
  "scripts": {
    "start": "npx serve . -l 3000",
    "dev": "npx serve . -l 3000",
    "test": "node --test"
  },
  "dependencies": {
    "three": "^0.160.0"
  }
}
```

#### B. Proposed Refactored `test.js`
```javascript
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

let server;
let browser;
const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;

function startStaticServer(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let reqUrl = req.url.split('?')[0];
      let filePath = path.join(__dirname, reqUrl === '/' ? 'index.html' : reqUrl);
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpeg': 'image/jpeg',
        '.glb': 'model/gltf-binary',
        '.gltf': 'model/gltf+json'
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      fs.readFile(filePath, (err, content) => {
        if (err) {
          res.writeHead(404);
          res.end('404 Not Found');
        } else {
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(content, 'utf-8');
        }
      });
    });
    server.listen(port, () => resolve(server));
  });
}

before(async () => {
  server = await startStaticServer(PORT);
  browser = await puppeteer.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox']
  });
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
});

test('Luceandombra Virtual Try-On - E2E UI Test', async () => {
  const page = await browser.newPage();
  
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

  // Assert page title
  const title = await page.title();
  assert.match(title, /Luceandombra/i, 'Page title must contain Luceandombra');

  // Assert start screen active initially
  const isStartActive = await page.evaluate(() => {
    const el = document.getElementById('startScreen');
    return el && el.classList.contains('active');
  });
  assert.strictEqual(isStartActive, true, 'startScreen must have active class on load');

  // Click start button
  await page.evaluate(() => document.getElementById('startBtn').click());

  // Assert start screen gets hidden
  await page.waitForFunction(() => {
    const el = document.getElementById('startScreen');
    return el && el.classList.contains('hidden');
  }, { timeout: 5000 });

  const isStartHidden = await page.evaluate(() => {
    return document.getElementById('startScreen').classList.contains('hidden');
  });
  assert.strictEqual(isStartHidden, true, 'startScreen must have hidden class after clicking startBtn');
});
```

### Verification Command & Invalidation Conditions
- **Command**: `npm test`
- **Expected Output**:
  ```text
  ▶ Luceandombra Virtual Try-On - E2E UI Test
  ✔ Luceandombra Virtual Try-On - E2E UI Test (...)
  ℹ tests 1
  ℹ pass 1
  ℹ fail 0
  ```
- **Exit Code**: `0` on success, `1` on assertion failure or script crash.
- **Invalidation Condition**: If `npm test` exits with `Missing script: "test"` or uncaught connection error on port 58088.
