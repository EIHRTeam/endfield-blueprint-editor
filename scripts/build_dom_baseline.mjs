#!/usr/bin/env node
/**
 * Derives the DOM fidelity baseline from the original project's own templates.
 *
 * The point of this refactor is to migrate the original frontend to React *without* redesigning it, so
 * the original markup is the specification. This script turns that specification into a normalised
 * snapshot that `tests/dom-parity.test.mjs` can compare the built app against.
 *
 * The baseline is generated from `src/editor_shell.html` and `src/editor_presentation.html` in a
 * checkout of the original branch, applying only the substitutions the original build performed:
 *
 *   1. the `__FONT_CSS__` placeholder is dropped (the font is now a `<link>`; it produces no DOM),
 *   2. `__FONT_LICENSE__` becomes the escaped font licence text,
 *   3. the export button is split into `#btnGamePreview` + `#btnPng` (`build_editor.py:251`),
 *   4. the presentation dialog is injected before `<footer>` (`build_editor.py:252`).
 *
 * The script is committed so the baseline's provenance is reviewable and reproducible. Run it with
 * `node scripts/build_dom_baseline.mjs [template-dir]`.
 *
 * The extractor itself lives in `scripts/render_dom_snapshot.mjs` and is shared with the test, so both
 * sides of the comparison are normalised by exactly the same code.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { EXTRACT_IN_PAGE, normaliseSnapshot } from './render_dom_snapshot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'tests/fixtures/dom-baseline.json');

/** Text of the document the baseline describes. `#loading` is hidden once the app is ready. */
const READY_TEXT = '正在准备蓝图素材…';

/**
 * The payload's presentation tag list, captured from the app for the same reason as the device rows: it
 * is produced by the Python baking layer from the game's tag table, so re-deriving it here would be a
 * second implementation rather than a check.
 */
function presentationTags() {
  const tagsPath = path.join(ROOT, 'tests/fixtures/presentation-tags.json');
  if (!existsSync(tagsPath)) {
    console.error(`Missing tag snapshot: ${path.relative(ROOT, tagsPath)}`);
    console.error('Run the capture step first: pnpm build && node scripts/capture_device_rows.mjs');
    process.exitCode = 1;
    return null;
  }
  return JSON.parse(readFileSync(tagsPath, 'utf8'));
}

/**
 * Device rows for the fixture's `#buildingList`.
 *
 * These are captured from the running application rather than re-derived here. The payload's device list
 * is built by several hundred lines of Python (recipes, logistics nodes, i18n resolution, sorting), and
 * re-implementing that derivation in JavaScript would only create a second, subtly different answer to
 * the same question — which is precisely the kind of drift this baseline exists to detect.
 *
 * The rows are still fully verified: `tests/dom-parity.test.mjs` re-captures them from the app on every run
 * and fails if any device id, label or size differs from this fixture.
 */
function deviceRows() {
  const snapshotPath = path.join(ROOT, 'tests/fixtures/device-rows.json');
  if (!existsSync(snapshotPath)) {
    console.error(`Missing device-row snapshot: ${path.relative(ROOT, snapshotPath)}`);
    console.error('');
    console.error('Run the capture step first (it needs the built app):');
    console.error('  pnpm build && node scripts/capture_device_rows.mjs');
    process.exitCode = 1;
    return null;
  }
  return JSON.parse(readFileSync(snapshotPath, 'utf8'));
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');
}

/** Applies the original build's substitutions to the shell template. */
function buildOriginalDocument(shell, presentation, licence) {
  let html = shell;
  // The font is embedded as an @font-face rule; it produces no DOM nodes and is not part of the
  // baseline. Removing the placeholder keeps the style block well formed.
  html = html.replace('__FONT_CSS__\n', '');
  html = html.replace('__FONT_LICENSE__', escapeHtml(licence));
  html = html.replace(
    '<button id="btnPng">导出 PNG</button>',
    '<button id="btnGamePreview">蓝图预览</button><button id="btnPng">导出画布 PNG</button>',
  );
  html = html.replace('<footer>', `${presentation}\n<footer>`);
  // The injected dialog block carries its own `<style>`; a real parser hoists a body-level style into
  // the head. Move exactly that one — anchored on the dialog that follows it — so the baseline matches
  // what the browser actually renders without touching the head's own style block.
  const styleInBody = /<style>((?:(?!<\/style>)[\s\S])*?)<\/style>\n(?=<dialog id="presentationDialog")/;
  const match = styleInBody.exec(html);
  if (match) {
    html = html.replace(match[0], '');
    html = html.replace('</head>', `${match[0]}\n</head>`);
  } else {
    throw new Error('could not hoist the presentation dialog style block; the template layout changed');
  }
  return html;
}

/**
 * The settled-state fixture.
 *
 * The baseline has to describe the *settled* document, not the static template: the original's scripts
 * fill containers, set toggle labels and inject a button before paint. Every block below mirrors one
 * original source line, named in its comment, so the transform set stays reviewable and nothing here
 * introduces UI the original did not have.
 */
function settledStateScript(devices, tagNames) {
  return `
    // #presentationColors buttons — editor_presentation.js:295-298
    const colors = {blue:['蓝色','#64d0fe'],cyan:['青色','#4fecce'],yellow:['黄色','#fbfd20'],
      green:['绿色','#d0f170'],purple:['紫色','#d3bafe'],orange:['橙色','#fea760'],gray:['灰色','#d9d9d9']};
    for (const [id, [name, color]] of Object.entries(colors)) {
      const button = document.createElement('button');
      button.dataset.coverColor = id;
      button.title = name;
      button.setAttribute('aria-label', name);
      button.style.setProperty('--color', color);
      document.getElementById('presentationColors').append(button);
    }

    // #tagSuggestions buttons — editor_presentation.js:299-306
    for (const name of ${JSON.stringify(tagNames)}) {
      const button = document.createElement('button');
      button.textContent = name;
      document.getElementById('tagSuggestions').append(button);
    }

    // #btnPresentationDetails prepended into #summary — editor_presentation.js:256-257
    const settingsButton = document.createElement('button');
    settingsButton.textContent = '蓝图详情 · 编辑 / 预览';
    settingsButton.id = 'btnPresentationDetails';
    document.getElementById('summary').prepend(settingsButton);

    // buildList() — editor_app.js:334-349, with the payload's own device labels
    const devices = ${JSON.stringify(devices)};
    const list = document.getElementById('buildingList');
    for (const device of devices) {
      const button = document.createElement('button');
      button.className = 'building';
      button.dataset.id = device.id;
      const image = document.createElement('img');
      image.alt = '';
      image.loading = 'lazy';
      const text = document.createElement('span');
      const name = document.createElement('b');
      const size = document.createElement('small');
      name.textContent = device.name;
      size.textContent = device.w + '×' + device.d + ' · ' + device.id;
      text.append(name, size);
      button.append(image, text);
      list.append(button);
    }
    document.getElementById('buildingCount').textContent = devices.length + ' / ' + devices.length + ' 个设备条目';

    // An uncontrolled <select> marks its default option as selected; the originals shipped the same
    // attribute in their markup (editor_shell.html's #exportScale, editor_presentation.html's
    // #presentationResolution), and React writes it from its defaultValue prop.
    for (const id of ['nodeDirection', 'nodePorts', 'nodeEnvironment', 'nodeItemStatus', 'productScope',
                      'productAvailability', 'coverScope', 'presentationConnectionPair']) {
      const select = document.getElementById(id);
      if (!select) continue;
      const option = select.querySelector('option');
      if (option) option.setAttribute('selected', '');
    }

    // refreshHistory() — editor_app.js:130
    document.getElementById('btnUndo').disabled = true;
    document.getElementById('btnRedo').disabled = true;

    // resize() sets the canvas backing store from the container size and the device pixel ratio —
    // editor_app.js:308-311
    const ratio = window.devicePixelRatio || 1;
    const canvas = document.getElementById('cv');
    canvas.width = Math.round(canvas.parentElement.clientWidth * ratio);
    canvas.height = Math.round(canvas.parentElement.clientHeight * ratio);

    // refreshInspector() with nothing selected — editor_app.js:351-352. The selection fields stay
    // hidden, the placeholder stays visible, and the port list is cleared.
    document.getElementById('selectionFields').hidden = true;
    document.getElementById('emptySelection').hidden = false;
    document.getElementById('portVisibility').replaceChildren();

    // refreshSummary() with an empty document — editor_app.js:442-478. The app boots empty; the sample
    // layout is only imported when the user asks for it, so the baseline is the empty case.
    document.getElementById('nodeCount').textContent = '0 / 160';
    document.getElementById('summaryList').replaceChildren();

    // The template carries these inline styles; set them so the parsed fixture matches the app's
    // React-rendered equivalent.
    document.getElementById('portVisibility').setAttribute('style', 'gap:7px;padding:10px 0px');

    // "refreshProductOptions()" sets these on its first run; the app runs it at boot so the library is
    // reconciled, and the fixture mirrors that state.
    document.getElementById('btnMoreProducts').hidden = true;

    // The boot tail sets the status line and the zoom readout — editor_app.js:306 and 684-686. The
    // overlay is still visible at this point; hiding it is the last step, so the app hides it too and
    // this fixture deliberately leaves it unset.
    document.getElementById('status').textContent = '选择设备或点击“示例”开始编辑';
    document.getElementById('zoom').textContent = '75% · 50×50';
    // The app hides the overlay once the scene is prepared, which is the state both sides are compared
    // in (the parity harness waits for the canvas, i.e. after boot).
    document.getElementById('loading').hidden = true;
  `;
}

async function main() {
  // Feature work intentionally extends the migrated UI. Explicitly capture a reviewed current
  // interface, retaining the original-template path below for auditing the historical migration.
  if (process.argv.includes('--current')) {
    const { startBrowser, startServer } = await import('../tests/harness.mjs');
    const server = await startServer();
    let session;
    try {
      session = await startBrowser(server.base);
      const snapshot = normaliseSnapshot(await session.page.evaluate(EXTRACT_IN_PAGE));
      snapshot.meta = { derivedFrom: 'Reviewed current UI: selection, merge, content export and material totals' };
      await writeFile(OUT, `${JSON.stringify(snapshot, null, 2)}\n`);
      console.log(`[dom-baseline] ${snapshot.nodes} nodes captured from dist/`);
    } finally {
      if (session) await session.close();
      await server.close();
    }
    return;
  }
  const templateDir = path.resolve(process.argv[2] ?? path.join(ROOT, 'tmp/main/src'));
  const shellPath = path.join(templateDir, 'editor_shell.html');
  const presentationPath = path.join(templateDir, 'editor_presentation.html');
  // The licence lives beside the templates' project, not beside the templates themselves.
  const licencePath = path.resolve(templateDir, '../assets/fonts/LICENSE-update.txt');

  for (const required of [shellPath, presentationPath, licencePath]) {
    if (!existsSync(required)) {
      console.error(`Missing baseline input: ${required}`);
      console.error('');
      console.error('The original templates are required to derive the baseline. Fetch or check out the');
      console.error('original project, then pass its src directory:');
      console.error('  node scripts/build_dom_baseline.mjs <path-to-original>/src');
      console.error('');
      console.error('A worktree of the original branch works as-is:');
      console.error('  git worktree add ./tmp/main main && node scripts/build_dom_baseline.mjs');
      process.exitCode = 1;
      return;
    }
  }

  const [shell, presentation, licenceBytes] = await Promise.all([
    readFile(shellPath, 'utf8'),
    readFile(presentationPath, 'utf8'),
    readFile(licencePath),
  ]);

  const devices = deviceRows();
  const tags = presentationTags();
  if (!devices || !tags) return;
  const document = buildOriginalDocument(shell, presentation, licenceBytes.toString('utf8').replace(/\0+$/, ''));

  // Render the settled document in a real browser and extract the same normalised tree the test
  // extracts from the built app. Normalising through one shared extractor is what makes the
  // comparison trustworthy: a baseline produced by a different code path could hide a real mismatch.
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let snapshot;
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1480, height: 1000 });
    await page.setContent(document, { waitUntil: 'domcontentloaded' });
    // Tags come from the payload in the real app; use a fixed, representative list for the fixture.
    page.on('console', event => {
      if (event.type() === 'error') console.error('[fixture console]', event.text());
    });
    page.on('pageerror', event => console.error('[fixture error]', event.message));
    await page.addScriptTag({ content: settledStateScript(devices, tags) });
    snapshot = await page.evaluate(EXTRACT_IN_PAGE);
  } finally {
    await browser.close();
  }

  const normalised = normaliseSnapshot(snapshot);
  normalised.meta = {
    derivedFrom: [
      path.relative(ROOT, shellPath),
      path.relative(ROOT, presentationPath),
      path.relative(ROOT, licencePath),
    ],
    transforms: [
      '__FONT_CSS__ placeholder dropped (font is linked, produces no DOM)',
      '__FONT_LICENSE__ replaced with the escaped licence text',
      'export button split into #btnGamePreview and #btnPng',
      'presentation dialog injected before <footer>',
    ],
    readyText: READY_TEXT,
  };

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(normalised, null, 2)}\n`);
  console.log(`[dom-baseline] wrote ${path.relative(ROOT, OUT)} (${normalised.nodes} nodes)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}
