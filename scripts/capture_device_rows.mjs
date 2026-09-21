#!/usr/bin/env node
/**
 * Captures the device rows the running app renders into `#buildingList`.
 *
 * The baseline generator needs them, and they cannot be re-derived outside the app: the payload's device
 * list is assembled by the Python baking layer from recipes, logistics tables, i18n resolution and a sort,
 * so re-implementing that in JavaScript would produce a second answer to the same question rather than a
 * check on it.
 *
 * Capturing them from the app is safe because the parity test re-captures them on every run and compares:
 * the fixture pins the expected values, the test detects any drift. Re-run this only when the baked device
 * set legitimately changes.
 *
 * Requires a previous `pnpm build`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startBrowser, startServer } from '../tests/harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'tests/fixtures/device-rows.json');
const TAGS_OUT = path.join(ROOT, 'tests/fixtures/presentation-tags.json');

const server = await startServer();
let session;
try {
  session = await startBrowser(server.base);
  const tags = await session.page.evaluate(() =>
    [...document.querySelectorAll('#tagSuggestions button')].map(button => button.textContent ?? ''),
  );

  const rows = await session.page.evaluate(() =>
    [...document.querySelectorAll('#buildingList .building')].map(button => {
      const name = button.querySelector('b')?.textContent ?? '';
      const size = button.querySelector('small')?.textContent ?? '';
      const [dimensions, id] = size.split(' · ');
      const [w, d] = (dimensions ?? '').split('×').map(Number);
      return { id: id ?? button.dataset.id ?? '', name, w: w ?? 0, d: d ?? 0 };
    }),
  );

  if (!rows.length) throw Error('#buildingList is empty; did the bake finish?');
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(rows, null, 2)}\n`);
  await writeFile(TAGS_OUT, `${JSON.stringify(tags, null, 2)}\n`);
  console.log(`[capture] ${rows.length} device rows -> ${path.relative(ROOT, OUT)}`);
  console.log(`[capture] ${tags.length} tag suggestions -> ${path.relative(ROOT, TAGS_OUT)}`);
} finally {
  if (session) await session.close();
  await server.close();
}
