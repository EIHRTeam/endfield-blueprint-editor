/**
 * Shared harness for browser tests.
 *
 * Baking the sprite set through Pyodide takes well over a minute, so every browser test shares one
 * server preload and one warm browser context. The context is reused across tests, which also means
 * the persistent bake cache is exercised exactly once.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.whl': 'application/octet-stream',
  '.zip': 'application/zip',
  '.py': 'text/x-python; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Serves `dist/` over loopback, which is mandatory: the app is a multi-chunk ES module app that
 * fetches its data, and browsers refuse those over `file://`.
 */
export async function startServer() {
  const requests = new Map();
  const server = createServer(async (request, response) => {
    try {
      const relative = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\/+/, '') || 'index.html';
      requests.set(relative, (requests.get(relative) ?? 0) + 1);
      const file = path.join(DIST, relative);
      if (!file.startsWith(DIST)) {
        response.writeHead(403).end();
        return;
      }
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) {
        response.writeHead(404).end(`not found: ${relative}`);
        return;
      }
      const body = await readFile(file);
      response.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        'Content-Length': body.length,
      });
      response.end(body);
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  return {
    base,
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

/** Boots one warmed browser context that every test in a suite can reuse. */
export async function startBrowser(base) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({
    viewport: { width: 1480, height: 1000 },
    deviceScaleFactor: 1,
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const errors = [];
  // Resource 404s are reported by the browser as console errors without a URL, which makes them
  // useless as assertions; failed requests are tracked separately below.
  const failedRequests = [];
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    const text = message.text();
    if (message.type() === 'error' && !text.includes('Failed to load resource')) {
      errors.push(`console: ${text}`);
    }
  });
  page.on('requestfailed', request => failedRequests.push(request.url()));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#bpName', { timeout: 600_000 });
  return {
    browser,
    context,
    page,
    errors,
    failedRequests,
    close: async () => {
      await browser.close();
    },
  };
}

/** A tiny assertion helper so the suites can report structured results. */
export function createChecks() {
  const passed = [];
  const failed = [];
  return {
    passed,
    failed,
    check(name, run) {
      try {
        run();
        passed.push(name);
      } catch (error) {
        failed.push(`${name}: ${error.message}`);
      }
    },
    async checkAsync(name, run) {
      try {
        await run();
        passed.push(name);
      } catch (error) {
        failed.push(`${name}: ${error.message}`);
      }
    },
  };
}

/** Prints the standard suite report and sets the exit code. */
export function report(suite, checks) {
  const payload = { suite, passed: checks.passed.length, failed: checks.failed.length, failures: checks.failed };
  console.log(JSON.stringify(payload));
  if (checks.failed.length) {
    for (const failure of checks.failed) console.error(failure);
    process.exitCode = 1;
  }
}
