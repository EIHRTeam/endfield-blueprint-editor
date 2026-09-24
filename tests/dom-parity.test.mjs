/**
 * Reviewed interface regression suite. The baseline began with the original HTML templates and is
 * intentionally updated when features extend the shell. Both sides use the same DOM extractor;
 * behavior tests separately verify that the new controls perform their advertised operations.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { EXTRACT_IN_PAGE, describe, normaliseSnapshot } from '../scripts/render_dom_snapshot.mjs';
import { createChecks, report, startBrowser, startServer } from './harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const checks = createChecks();

const baseline = JSON.parse(await readFile(path.join(ROOT, 'tests/fixtures/dom-baseline.json'), 'utf8'));

const server = await startServer();
let session;
try {
  session = await startBrowser(server.base);

  const snapshot = await session.page.evaluate(EXTRACT_IN_PAGE);
  const actual = normaliseSnapshot(snapshot);

  // ---- the whole tree, compared as readable lines so a failure names the exact node ----
  await checks.checkAsync('DOM matches the reviewed interface baseline', async () => {
    const expectedLines = describe(baseline);
    const actualLines = describe(actual);
    const expected = new Set(expectedLines);
    const observed = new Set(actualLines);

    const missing = expectedLines.filter(line => !observed.has(line));
    const extra = actualLines.filter(line => !expected.has(line));

    const detail = [
      missing.length ? `\nmissing (${missing.length}):\n  ${missing.slice(0, 12).join('\n  ')}` : '',
      extra.length ? `\nunexpected (${extra.length}):\n  ${extra.slice(0, 12).join('\n  ')}` : '',
    ].join('');
    assert.equal(missing.length + extra.length, 0, `DOM differs from the reviewed baseline${detail}`);
  });

  // ---- attribute whitelist -------------------------------------------------------------
  // Neither side may use an attribute outside the originals' vocabulary, so this fails on a *new*
  // attribute added by the port rather than silently tolerating it.
  await checks.checkAsync('neither side uses an attribute outside the reviewed vocabulary', async () => {
    assert.deepEqual(
      actual.unexpectedAttributes,
      [],
      `app introduced attributes: ${actual.unexpectedAttributes.join(', ')}`,
    );
    assert.deepEqual(
      baseline.unexpectedAttributes,
      [],
      `baseline has unexpected attributes: ${baseline.unexpectedAttributes.join(', ')}`,
    );
  });

  // ---- structural assertions that the line comparison alone could miss -----------------
  await checks.checkAsync('#summary is inside #properties and led by #btnPresentationDetails', async () => {
    const shape = await session.page.evaluate(() => {
      const summary = document.getElementById('summary');
      const properties = document.getElementById('properties');
      return {
        insideProperties: Boolean(summary && properties && properties.contains(summary) && summary !== properties),
        firstChildId: summary?.firstElementChild?.id ?? null,
      };
    });
    assert.equal(shape.insideProperties, true, '#summary must be a descendant of #properties');
    assert.equal(shape.firstChildId, 'btnPresentationDetails', '#btnPresentationDetails must be prepended');
  });

  await checks.checkAsync('editor dialogs use native <dialog> elements', async () => {
    const tags = await session.page.evaluate(() =>
      ['itemLibrary', 'fontLicenseDialog', 'presentationDialog', 'canvasExportDialog'].map(
        id => document.getElementById(id)?.tagName ?? null,
      ),
    );
    assert.deepEqual(tags, ['DIALOG', 'DIALOG', 'DIALOG', 'DIALOG']);
  });

  await checks.checkAsync('#selectedPreview is an <img>, as in the original', async () => {
    assert.equal(await session.page.evaluate(() => document.getElementById('selectedPreview')?.tagName), 'IMG');
  });

  await checks.checkAsync('#loading is a single text line, not a progress surface', async () => {
    const shape = await session.page.evaluate(() => {
      const loading = document.getElementById('loading');
      return { tag: loading?.tagName, childElements: loading?.children.length ?? -1 };
    });
    assert.equal(shape.tag, 'DIV');
    assert.equal(shape.childElements, 0, '#loading must contain no elements');
  });

  await checks.checkAsync('the original button texts are unchanged', async () => {
    const texts = await session.page.evaluate(() => ({
      btnGrid: document.getElementById('btnGrid')?.textContent,
      btnPorts: document.getElementById('btnPorts')?.textContent,
      btnHints: document.getElementById('btnHints')?.textContent,
      btnGamePreview: document.getElementById('btnGamePreview')?.textContent,
      btnPng: document.getElementById('btnPng')?.textContent,
      canvasHint: document.getElementById('canvasHint')?.textContent,
    }));
    assert.equal(texts.btnGrid, '网格：开');
    assert.equal(texts.btnPorts, '端口标记：关');
    assert.equal(texts.btnHints, '原版提示：开');
    assert.equal(texts.btnGamePreview, '蓝图预览');
    assert.equal(texts.btnPng, '导出画布 PNG');
    assert.equal(texts.canvasHint, '点击选中 · 拖动移动 · R 旋转 · Delete 删除');
  });
} catch (error) {
  checks.failed.push(`suite crashed: ${error.message}`);
} finally {
  if (session) await session.close();
  await server.close();
}

report('dom-parity', checks);
