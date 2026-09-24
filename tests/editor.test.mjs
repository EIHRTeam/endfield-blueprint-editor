/**
 * Browser acceptance suite.
 *
 * One warm bake serves the whole suite: booting Pyodide and composing the sprite set takes minutes,
 * so the shared harness boots once and every workflow check runs against that same page. The final
 * check reloads to prove the persistent cache makes the second visit fast.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
    assert.ok(width > 0);
    assert.equal(await page.locator('#presentationSizing').inputValue(), 'content');
    await page.locator('#presentationSizing').selectOption('fixed');
    await page.waitForFunction(() => document.getElementById('presentationCanvas').width === 1920);
    await page.locator('#btnCancelPresentation').click();
  });

  await checks.checkAsync('rectangle selection copies devices and lines for repeated undoable placement', async () => {
    await page.evaluate(() =>
      window.BlueprintEditor.importLayout({
        schemaVersion: 2,
        name: '批量编辑验收',
        size: { x: 30, z: 24 },
        nodes: [
          { templateId: 'battle_trap_1', position: { x: 4, z: 4 }, direction: 0, productIcon: 'item_iron_nugget' },
        ],
        conveyors: [
          { x: 6, z: 5, kind: 'item', dir: 0 },
          { x: 7, z: 5, kind: 'item', dir: 0 },
          { x: 25, z: 20, kind: 'fluid', dir: 1 },
        ],
      }),
    );
    await page.click('[data-tool="region"]');
    const start = await gridPoint(3, 3);
    const end = await gridPoint(8, 7);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 8 });
    await page.mouse.up();
    assert.equal(await page.locator('#btnCopy').isEnabled(), true);
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Control+v');
    await clickCell(12, 5);
    await clickCell(18, 5);
    let data = await page.evaluate(() => window.BlueprintEditor.getData());
    assert.equal(data.nodes.length, 3);
    assert.equal(data.conveyors.length, 7);
    assert.deepEqual(data.nodes[1].position, { x: 12, z: 5 });
    assert.equal(data.nodes[1].productIcon, 'item_iron_nugget');
    await clickCell(12, 5);
    assert.equal(
      (await page.evaluate(() => window.BlueprintEditor.getData())).nodes.length,
      3,
      'overlap must not add a copy',
    );
    assert.match(await page.locator('#status').textContent(), /重叠/);
    await page.keyboard.press('Escape');
    await clickCell(22, 15);
    assert.equal(
      (await page.evaluate(() => window.BlueprintEditor.getData())).nodes.length,
      3,
      'Escape ends placement',
    );
    await page.click('#btnUndo');
    data = await page.evaluate(() => window.BlueprintEditor.getData());
    assert.equal(data.nodes.length, 2);
    assert.equal(data.conveyors.length, 5);
    await page.click('#btnRedo');
    assert.equal((await page.evaluate(() => window.BlueprintEditor.getData())).nodes.length, 3);
  });

  await checks.checkAsync(
    'merge file previews without replacing the current document and can be cancelled',
    async () => {
      const before = await page.evaluate(() => window.BlueprintEditor.getData());
      const incoming = {
        schemaVersion: 2,
        name: '另一半蓝图',
        size: { x: 50, z: 50 },
        nodes: [{ templateId: 'battle_trap_1', position: { x: 30, z: 30 }, direction: 1 }],
        conveyors: [],
      };
      const file = { name: 'half.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(incoming)) };
      const chooser = page.waitForEvent('filechooser');
      await page.click('#btnMerge');
      await (await chooser).setFiles(file);
      await page.waitForFunction(() => document.getElementById('canvasHint').textContent.includes('粘贴'));
      assert.deepEqual(await page.evaluate(() => window.BlueprintEditor.getData()), before);
      await page.keyboard.press('Escape');
      assert.deepEqual(await page.evaluate(() => window.BlueprintEditor.getData()), before);
      await page.setInputFiles('#mergeFileIn', file);
      await page.waitForFunction(() => document.getElementById('canvasHint').textContent.includes('粘贴'));
      await clickCell(20, 15);
      await page.keyboard.press('Escape');
      const merged = await page.evaluate(() => window.BlueprintEditor.getData());
      assert.equal(merged.name, before.name);
      assert.deepEqual(merged.size, before.size);
      assert.equal(merged.nodes.length, before.nodes.length + 1);
      assert.deepEqual(merged.nodes.at(-1).position, { x: 20, z: 15 });
      await page.click('#btnUndo');
      assert.deepEqual(await page.evaluate(() => window.BlueprintEditor.getData()), before);
    },
  );

  await checks.checkAsync('material totals follow edits and disclose missing line recipes', async () => {
    const before = await page.locator('#materialsList').innerText();
    assert.match(before, /\d/);
    assert.match(await page.locator('#materialsWarning').textContent(), /传送带|管道/);
    await page.click('#btnClear');
    const empty = await page.locator('#materialsList').innerText();
    assert.notEqual(empty, before);
    await page.click('#btnUndo');
    assert.equal(await page.locator('#materialsList').innerText(), before);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.click('#btnCopyMaterials');
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /建造材料/);
  });

  await checks.checkAsync('PNG dialog exports exact custom cell sizes and zero content margin', async () => {
    await page.evaluate(() =>
      window.BlueprintEditor.importLayout({
        schemaVersion: 2,
        name: '尺寸验收',
        size: { x: 30, z: 24 },
        nodes: [{ templateId: 'battle_trap_1', position: { x: 4, z: 4 }, direction: 0 }],
        conveyors: [{ x: 8, z: 4, kind: 'item', dir: 0 }],
      }),
    );
    await page.waitForFunction(() => document.getElementById('bpName').value === '尺寸验收');
    await page.click('#btnPng');
    await page.locator('#exportScale').fill('0');
    await page.click('#btnConfirmCanvasExport');
    await page.waitForFunction(() => document.getElementById('canvasExportError').textContent.includes('8–256'));
    assert.equal(await page.locator('#canvasExportDialog').isVisible(), true);
    await page.locator('#exportScale').fill('72');
    await page.locator('#exportMargin').fill('0');
    await page.locator('#transparent').check();
    const ready = page.waitForEvent('download');
    await page.click('#btnConfirmCanvasExport');
    const download = await ready;
    await download.saveAs(path.join(OUT, 'content-canvas.png'));
    const png = await readFile(await download.path());
    assert.equal(png.readUInt32BE(16), 5 * 72);
    assert.equal(png.readUInt32BE(20), 2 * 72);
    assert.equal(await page.locator('#canvasExportDialog').isVisible(), false);
    assert.equal(download.suggestedFilename(), '尺寸验收.png');
    assert.equal(await page.locator('#bpName').inputValue(), '尺寸验收');
    const full = await page.evaluate(async () => {
      const canvas = await window.BlueprintEditor.exportCanvas(undefined, 72, true, false, {
        range: 'canvas',
        margin: 0,
      });
      return [canvas.width, canvas.height];
    });
    assert.deepEqual(full, [30 * 72, 24 * 72]);
  });

  await checks.checkAsync('content presentation scales with cells and keeps narrow layouts compact', async () => {
    const sizes = await page.evaluate(async () => {
      const api = window.BlueprintEditor;
      const a = await api.exportPreview(api.getData(), 1920, { fitToContent: true, cell: 64, margin: 0 });
      const b = await api.exportPreview(api.getData(), 1920, { fitToContent: true, cell: 128, margin: 0 });
      return [
        [a.width, a.height],
        [b.width, b.height],
      ];
    });
    assert.ok(sizes[0][0] < 1000, 'narrow content should not retain the fixed 1920 px width');
    assert.ok(Math.abs(sizes[1][0] - sizes[0][0] * 2) <= 1);
    assert.ok(Math.abs(sizes[1][1] - sizes[0][1] * 2) <= 1);
    await page.click('#btnGamePreview');
    await page.locator('#presentationSizing').selectOption('content');
    await page.locator('#presentationCell').fill('64');
    await page.locator('#presentationMargin').fill('0');
    await page.waitForFunction(width => document.getElementById('presentationCanvas').width === width, sizes[0][0]);
    await page.screenshot({ path: path.join(OUT, 'content-preview.png') });
    await page.locator('#btnCancelPresentation').click();
  });

  await checks.checkAsync('zero-margin PNG retains every painted pixel of environment annotations', async () => {
    const result = await page.evaluate(async () => {
      const source = {
        schemaVersion: 2,
        name: '环境条裁切回归',
        size: { x: 10, z: 10 },
        nodes: [
          { templateId: 'log_pipe_conditioner', position: { x: 4, z: 4 }, direction: 0, environmentEffect: 'acid' },
        ],
        conveyors: [],
      };
      const pixels = canvas => {
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let alpha = 0;
        for (let i = 3; i < data.length; i += 4) alpha += data[i];
        return alpha;
      };
      const api = window.BlueprintEditor;
      const tight = await api.exportCanvas(source, 64, true, false, { margin: 0 });
      const padded = await api.exportCanvas(source, 64, true, false, { margin: 2 });
      const edge = { ...source, nodes: [{ ...source.nodes[0], environmentEffect: '', position: { x: 0, z: 0 } }] };
      const withMargin = await api.exportCanvas(edge, 64, true, false, { margin: 3 });
      return {
        tight: [tight.width, tight.height],
        tightAlpha: pixels(tight),
        paddedAlpha: pixels(padded),
        edge: [withMargin.width, withMargin.height],
      };
    });
    assert.deepEqual(result.tight, [146, 88]);
    assert.ok(result.tightAlpha > 0);
    assert.equal(result.tightAlpha, result.paddedAlpha, 'cropping must preserve every visible pixel');
    assert.deepEqual(result.edge, [448, 448]);
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
