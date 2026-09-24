/**
 * Measure the actual shell, styles and bundled font without booting the unrelated sprite bake.
 * Header buttons must remain visible and usable when their row wraps above the canvas.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from 'playwright';
import { build } from 'vite';
import { createChecks, report, startServer } from './harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'reports/test-artifacts');
await build({
  root: ROOT,
  configFile: false,
  logLevel: 'warn',
  build: {
    outDir: OUT,
    emptyOutDir: false,
    minify: false,
    target: 'es2022',
    lib: {
      entry: path.join(ROOT, 'src/ui/shell.tsx'),
      formats: ['es'],
      fileName: () => 'responsive-shell.mjs',
    },
    rolldownOptions: { external: ['react', 'react/jsx-runtime'] },
  },
});
const { Shell } = await import(pathToFileURL(path.join(OUT, 'responsive-shell.mjs')).href);
const markup = renderToStaticMarkup(createElement(Shell, { licence: '', loadingHidden: true }));
const styles = await readFile(path.join(ROOT, 'src/styles.css'), 'utf8');
const checks = createChecks();
const server = await startServer();
let browser;
try {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  browser = await chromium.launch({
    ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1480, height: 1000 } });
  await page.route('**/responsive-shell', route =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/fonts/HarmonyOS_Sans_SC/result.css"><style>${styles}</style></head><body>${markup}</body></html>`,
    }),
  );
  await page.goto(`${server.base}responsive-shell`);
  await page.evaluate(() => document.fonts.ready);

  await checks.checkAsync('the actual bundled font is loaded for the toolbar labels', async () => {
    const loaded = await page.evaluate(async () => {
      const text = document.querySelector('header').textContent;
      const faces = await document.fonts.load('13px "HarmonyOS Sans SC"', text);
      return faces.length > 0 && faces.every(face => face.status === 'loaded');
    });
    assert.ok(loaded, 'font loading must succeed before layout measurements');
  });

  for (const width of [390, 480, 600, 860, 1000, 1150, 1480]) {
    await checks.checkAsync(`toolbar, canvas and inspector fit a ${width}px viewport`, async () => {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => document.body.classList.remove('inspect-open'));
      const layout = await page.evaluate(() => {
        const rect = element => {
          const { top, right, bottom, left, height } = element.getBoundingClientRect();
          return { top, right, bottom, left, height };
        };
        const buttons = [...document.querySelectorAll('header button')]
          .filter(button => getComputedStyle(button).display !== 'none')
          .map(button => {
            const text = document.createRange();
            text.selectNodeContents(button);
            return Object.assign(rect(button), { id: button.id, textLines: text.getClientRects().length });
          });
        return {
          header: rect(document.querySelector('header')),
          main: rect(document.querySelector('main')),
          canvas: rect(document.getElementById('cv')),
          footer: rect(document.querySelector('footer')),
          buttons,
        };
      });
      for (const button of layout.buttons) {
        assert.ok(button.top >= 0 && button.bottom <= layout.header.bottom, `${button.id} is clipped vertically`);
        assert.ok(button.left >= 0 && button.right <= width, `${button.id} is clipped horizontally`);
        assert.equal(button.textLines, 1, `${button.id} label must stay on one line`);
      }
      assert.equal(layout.main.top, layout.header.bottom, 'canvas area must begin below the whole toolbar');
      assert.equal(layout.canvas.top, layout.main.top);
      assert.equal(layout.canvas.bottom, layout.main.bottom);
      assert.equal(layout.main.bottom, layout.footer.top);
      assert.equal(layout.footer.bottom, 1000, 'footer must remain inside the viewport');
      assert.ok(layout.canvas.height > 0);
      if (width === 1480) {
        assert.equal(layout.header.height, 58, 'desktop toolbar height remains unchanged');
        assert.equal(layout.main.height, 912, 'desktop canvas area height remains unchanged');
      }
      if (width <= 860) {
        await page.evaluate(() => document.body.classList.add('inspect-open'));
        const inspector = await page.locator('#properties').boundingBox();
        assert.equal(inspector.y, layout.main.top, 'inspector must follow the wrapped toolbar');
        assert.equal(inspector.y + inspector.height, layout.main.bottom);
      }
      // Real pointer clicks also catch overlapping canvas/inspector layers that geometry alone misses.
      for (const id of ['btnImport', 'btnMerge', 'btnJson', 'btnGamePreview', 'btnPng']) {
        await page.evaluate(buttonId => {
          document.body.dataset.clicked = '';
          document.getElementById(buttonId).addEventListener(
            'click',
            () => {
              document.body.dataset.clicked = buttonId;
            },
            { once: true },
          );
        }, id);
        await page.locator(`#${id}`).click({ timeout: 2000 });
        assert.equal(await page.getAttribute('body', 'data-clicked'), id);
      }
    });
  }
} catch (error) {
  checks.failed.push(`suite crashed: ${error.message}`);
} finally {
  if (browser) await browser.close();
  await server.close();
}
report('responsive', checks);
