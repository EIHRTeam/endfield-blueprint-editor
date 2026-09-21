/**
 * Browser acceptance suite.
 *
 * One warm bake serves the whole suite: booting Pyodide and composing the sprite set takes minutes,
 * so the shared harness boots once and every workflow check runs against that same page. The final
 * check reloads to prove the persistent cache makes the second visit fast.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startServer, startBrowser, createChecks, report } from './harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'reports/test-artifacts');

const checks = createChecks();
await mkdir(OUT, { recursive: true });

const server = await startServer();
let boot = null;

try {
  const started = Date.now();
  boot = await startBrowser(server.base);
  const bakeMs = Date.now() - started;
  checks.passed.push(`cold bake and first paint in ${(bakeMs / 1000).toFixed(1)}s`);

  const { page } = boot;

  /** Converts a cell position to viewport coordinates using the editor's own view transform. */
  const gridPoint = (cellX, cellZ) =>
    page.evaluate(
      cell => {
        const view = window.BlueprintEditor.getViewport();
        const canvas = window.BlueprintEditor.canvas();
        if (!view || !canvas) throw new Error('viewport unavailable');
        const rect = canvas.getBoundingClientRect();
        return {
          x: rect.x + view.ox + (cell.x + 0.5) * view.s,
          y: rect.y + view.oy + (cell.z + 0.5) * view.s,
        };
      },
      { x: cellX, z: cellZ },
    );

  const clickCell = async (x, z) => {
    const point = await gridPoint(x, z);
    await page.mouse.click(point.x, point.y);
  };

  // ---- initial state -------------------------------------------------------
  await checks.checkAsync('starts empty with the loading screen gone', async () => {
    assert.equal(await page.locator('#loading-screen').count(), 0);
    assert.equal(await page.locator('#cv').isVisible(), true);
    assert.equal((await page.evaluate(() => window.BlueprintEditor.getData())).nodes.length, 0);
    assert.ok((await page.locator('.building').count()) > 0, 'device list should be populated');
  });

  await checks.checkAsync('the bundled font is actually applied', async () => {
    const loaded = await page.evaluate(() => document.fonts.check('24px "HarmonyOS Sans SC"', '蓝图'));
    assert.equal(loaded, true);
  });

  // ---- sample document and history ----------------------------------------
  await checks.checkAsync('sample blueprint imports and is undoable', async () => {
    await page.click('#btnDemo');
    assert.equal((await page.evaluate(() => window.BlueprintEditor.getData())).nodes.length, 11);
    await page.click('#btnUndo');
    assert.equal((await page.evaluate(() => window.BlueprintEditor.getData())).nodes.length, 0);
    await page.click('#btnRedo');
    assert.equal((await page.evaluate(() => window.BlueprintEditor.getData())).nodes.length, 11);
  });

  // ---- selection, annotation and export -----------------------------------
  await checks.checkAsync('clicking a device selects it and exposes its properties', async () => {
    const first = await page.evaluate(() => window.BlueprintEditor.getData().nodes[0]);
    await clickCell(first.position.x, first.position.z);
    await page.waitForSelector('#selectionFields');
    const id = await page.locator('#selectedId').textContent();
    assert.equal(id, first.templateId);
    const selected = await page.locator('.summary-card').count();
    assert.ok(selected > 0, 'summary should list the placed devices');
  });

  await checks.checkAsync('an import applies immediately and is undoable', async () => {
    // Re-import the sample so this check does not depend on annotations left by earlier checks.
    await page.click('#btnDemo');
    // The import path once committed to history without updating the live document, so the canvas
    // looked unchanged until the next undo or redo. Both halves of that contract are asserted here.
    const original = await page.evaluate(() => window.BlueprintEditor.getData().nodes[0].productIcon ?? null);
    const imported = original === 'item_iron_nugget' ? 'item_copper_ore' : 'item_iron_nugget';
    await page.evaluate(icon => {
      const data = window.BlueprintEditor.getData();
      data.nodes[0].productIcon = icon;
      window.BlueprintEditor.importLayout(data);
    }, imported);
    assert.equal(
      await page.evaluate(() => window.BlueprintEditor.getData().nodes[0].productIcon),
      imported,
      'the imported document must be live immediately',
    );
    await page.click('#btnUndo');
    assert.equal(
      await page.evaluate(() => window.BlueprintEditor.getData().nodes[0].productIcon ?? null),
      original,
      'undo must restore the pre-import annotation',
    );
    await page.click('#btnRedo');
    assert.equal(
      await page.evaluate(() => window.BlueprintEditor.getData().nodes[0].productIcon),
      imported,
      'redo must restore the imported annotation',
    );
  });

  await checks.checkAsync('JSON round trip is stable', async () => {
    const before = await page.evaluate(() => JSON.stringify(window.BlueprintEditor.getData()));
    const after = await page.evaluate(() => {
      window.BlueprintEditor.importLayout(JSON.parse(JSON.stringify(window.BlueprintEditor.getData())));
      return JSON.stringify(window.BlueprintEditor.getData());
    });
    assert.equal(after, before);
  });

  await checks.checkAsync('viewport tools are available', async () => {
    await page.click('#btnGrid');
    assert.equal(await page.locator('#btnGrid').textContent(), '网格：关');
    await page.click('#btnGrid');
    await page.click('#btnPorts');
    assert.equal(await page.locator('#btnPorts').textContent(), '端口标记：开');
    await page.click('#btnPorts');
    await page.click('#btnHints');
    assert.equal(await page.locator('#btnHints').textContent(), '原版提示：关');
    await page.click('#btnHints');
    await page.click('#btnFit');
  });

  await checks.checkAsync('clearing the layout is undoable', async () => {
    await page.click('#btnClear');
    assert.equal((await page.evaluate(() => window.BlueprintEditor.getData())).nodes.length, 0);
    await page.click('#btnUndo');
    assert.equal((await page.evaluate(() => window.BlueprintEditor.getData())).nodes.length, 11);
  });

  await checks.checkAsync('canvas PNG export produces a sized image', async () => {
    const size = await page.evaluate(async () => {
      const canvas = await window.BlueprintEditor.exportCanvas(window.BlueprintEditor.getData(), 64, false, true);
      return { width: canvas.width, height: canvas.height };
    });
    assert.ok(size.width > 0 && size.height > 0, `unexpected canvas size ${size.width}x${size.height}`);
  });

  await checks.checkAsync('transparent export omits the name band', async () => {
    const [opaque, transparent] = await page.evaluate(async () => {
      const data = window.BlueprintEditor.getData();
      const a = await window.BlueprintEditor.exportCanvas(data, 40, false, true);
      const b = await window.BlueprintEditor.exportCanvas(data, 40, true, true);
      return [a.height, b.height];
    });
    assert.equal(opaque - transparent, 48, 'the 48 px title band should be the only difference');
  });

  await checks.checkAsync('full presentation preview export matches the requested width', async () => {
    const size = await page.evaluate(async () => {
      const canvas = await window.BlueprintEditor.exportPreview(window.BlueprintEditor.getData(), 1920);
      return { width: canvas.width, height: canvas.height };
    });
    assert.equal(size.width, 1920);
    assert.ok(size.height >= 1080);
  });

  await checks.checkAsync('the item library opens and filters', async () => {
    await page.click('#btnItemLibrary');
    await page.waitForSelector('#itemLibrary');
    const total = await page.locator('.product-card').count();
    assert.ok(total > 0, 'library should list icons');
    await page.locator('#productSearch').fill('item_iron_nugget');
    await page.waitForTimeout(200);
    const filtered = await page.locator('.product-card').count();
    assert.ok(filtered > 0 && filtered <= total, `filter narrowed ${total} -> ${filtered}`);
    await page.locator('#btnCloseLibrary').click();
  });

  await checks.checkAsync('the presentation dialog opens and renders a preview', async () => {
    await page.click('#btnGamePreview');
    await page.waitForSelector('#presentationDialog');
    // Wait for a completed paint rather than merely a canvas element.
    await page.waitForFunction(
      () => {
        const canvas = document.getElementById('presentationCanvas');
        return canvas instanceof HTMLCanvasElement && Number(canvas.dataset.revision ?? 0) > 0;
      },
      null,
      { timeout: 120_000 },
    );
    const width = await page.evaluate(() => document.getElementById('presentationCanvas').width);
    assert.equal(width, 1920);
    await page.locator('#btnCancelPresentation').click();
  });

  await page.screenshot({ path: path.join(OUT, 'editor.png') });

  // ---- persistent cache ----------------------------------------------------
  await checks.checkAsync('a reload is served from the persistent cache', async () => {
    const reloadStart = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#bpName', { timeout: 300_000 });
    const reloadMs = Date.now() - reloadStart;
    checks.passed.push(`cached reload in ${(reloadMs / 1000).toFixed(1)}s`);
    assert.ok(reloadMs < bakeMs, `reload ${reloadMs}ms was not faster than the cold bake ${bakeMs}ms`);
  });
} catch (error) {
  checks.failed.push(`suite crashed: ${error.message}`);
} finally {
  if (boot) {
    for (const error of boot.errors) checks.failed.push(error);
    await boot.close();
  }
  await server.close();
}

const summary = {
  suite: 'editor-browser',
  passed: checks.passed.length,
  failed: checks.failed.length,
  failures: checks.failed,
};
await writeFile(path.join(OUT, 'browser-results.json'), `${JSON.stringify(summary, null, 2)}\n`);
report('editor-browser', checks);
