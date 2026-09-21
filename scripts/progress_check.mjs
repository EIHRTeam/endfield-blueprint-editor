import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const DIST = path.join(import.meta.dirname, '..', 'dist');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.whl': 'application/octet-stream',
  '.zip': 'application/zip',
  '.py': 'text/x-python',
  '.txt': 'text/plain',
  '.map': 'application/json',
};
const server = createServer(async (request, response) => {
  const relative = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = path.join(DIST, relative);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    response.writeHead(404).end('not found');
    return;
  }
  const body = await readFile(file);
  response.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'Content-Length': body.length,
  });
  response.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', error => console.log('[pageerror]', error.message));
page.on('console', m => {
  if (m.type() === 'error' && !m.text().includes('Failed to load resource')) console.log('[console]', m.text());
});

const started = Date.now();
await page.goto(base, { waitUntil: 'domcontentloaded' });

const states = [];
for (let i = 0; i < 900; i++) {
  const sample = await page.evaluate(() => {
    const loading = document.getElementById('loading');
    return {
      hasLoading: Boolean(loading),
      hidden: loading?.hidden ?? null,
      text: loading?.textContent ?? null,
      children: loading?.children.length ?? -1,
      nodeType: loading?.firstChild?.nodeType ?? null,
    };
  });
  if (i === 0) console.log('at t=0:', JSON.stringify(sample));
  if (sample.hasLoading && sample.text !== states.at(-1)?.text) {
    states.push({
      t: Math.round((Date.now() - started) / 1000),
      text: sample.text,
      children: sample.children,
      nodeType: sample.nodeType,
    });
  }
  if (sample.hasLoading && sample.hidden) {
    states.push({
      t: Math.round((Date.now() - started) / 1000),
      text: '(overlay hidden — editor ready)',
      children: sample.children,
      nodeType: sample.nodeType,
    });
    break;
  }
  await page.waitForTimeout(200);
}

console.log('\nelapsed:', Math.round((Date.now() - started) / 1000), 's');
console.log(`${states.length} observed overlay states:`);
for (const entry of states)
  console.log(`  ${String(entry.t).padStart(4)}s  children=${entry.children} node=${entry.nodeType}  ${entry.text}`);
await browser.close();
server.close();
