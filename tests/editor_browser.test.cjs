const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const kit = path.resolve(__dirname, '..');
const out = path.join(kit, 'reports/test-artifacts');
(async () => {
  await fs.mkdir(path.join(kit, 'reports/test-artifacts'), {recursive: true});
  await fs.mkdir(out, {recursive: true});
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  try {
    const context = await browser.newContext({viewport: {width: 1480, height: 1000}, deviceScaleFactor: 1, acceptDownloads: true});
    const page = await context.newPage();
    const errors = [], passed = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(path.join(kit, 'dist/blueprint_editor.html')).href);
    await page.evaluate(() => BlueprintEditor.ready);
    assert.equal(await page.locator('#loading').isHidden(), true);
    await page.locator('#btnDemo').click();
    await page.evaluate(() => prepareScene(BlueprintEditor.getData()));
    assert.equal((await page.evaluate(() => BlueprintEditor.getData())).nodes.length, 11);
    passed.push('offline startup and sample import');
    const grid = async (x, z) => page.evaluate(({x, z}) => {
      const r = document.getElementById('cv').getBoundingClientRect();
      return {x: r.x + view.ox + x * view.s, y: r.y + view.oy + z * view.s};
    }, {x, z});
    const clickGrid = async (x, z) => { const p = await grid(x, z); await page.mouse.click(p.x, p.y); };
    await clickGrid(4.5, 7.5);
    assert.equal(await page.locator('#selectedId').textContent(), 'furnance_1');
    await page.locator('#btnChooseProduct').click();
    await page.locator('#productSearch').fill('item_iron_nugget');
    await page.locator('[data-product="item_iron_nugget"]').click();
    assert.equal((await page.evaluate(() => BlueprintEditor.getData())).nodes[2].productIcon, 'item_iron_nugget');
    await page.locator('#btnUndo').click();
    assert.equal((await page.evaluate(() => BlueprintEditor.getData())).nodes[2].productIcon, 'item_copper_nugget');
    await page.locator('#btnRedo').click();
    assert.equal((await page.evaluate(() => BlueprintEditor.getData())).nodes[2].productIcon, 'item_iron_nugget');
    passed.push('product selection and undo/redo');
    await clickGrid(4.5, 7.5);
    const dirs = await page.evaluate(() => BlueprintEditor.getData().nodes.map(n => n.direction));
    await page.locator('#bpName').fill('测试名称'); await page.locator('#bpName').press('r'); await page.locator('#bpName').press('Tab');
    assert.deepEqual(await page.evaluate(() => BlueprintEditor.getData().nodes.map(n => n.direction)), dirs);
    passed.push('typing R in a text field does not rotate');
    const beforeInvalid = await page.evaluate(() => JSON.stringify(BlueprintEditor.getData()));
    const rejected = await page.evaluate(() => {
      try { BlueprintEditor.importLayout({nodes: [{templateId: '__unknown__', position: {x: 1, z: 1}}]}); return false; }
      catch { return true; }
    });
    assert.equal(rejected, true); assert.equal(await page.evaluate(() => JSON.stringify(BlueprintEditor.getData())), beforeInvalid);
    passed.push('failed import leaves current document untouched');
    // Drag an existing device onto another; this must not mutate the document.
    await clickGrid(4.5, 7.5); const start = await grid(4.5, 7.5), end = await grid(12.5, 7.5);
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, {steps: 8}); await page.mouse.up();
    assert.equal((await page.evaluate(() => BlueprintEditor.getData())).nodes[2].position.x, 3);
    passed.push('drag collision rejected');
    await page.locator('[data-tool="item"]').click();
    const a = await grid(15.5, 10.5), b = await grid(18.5, 11.5);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, {steps: 8}); await page.mouse.up();
    const lines = await page.evaluate(() => BlueprintEditor.getData().conveyors);
    assert(lines.some(b => b.x === 18 && b.z === 11 && b.kind === 'item'));
    assert(lines.some(b => b.x === 18 && b.z === 10 && b.dir === 1 && b.fromDir === 0));
    passed.push('draw route includes final tile and corner direction');
    // Test export without waiting for images of a newly imported rectangular device.
    const isolated = {name: '矩形旋转导出', size: {x: 32, z: 28}, nodes: [{templateId: 'udpipe_loader_2', position: {x: 24, z: 20}, direction: 1}], conveyors: []};
    await page.evaluate(d => BlueprintEditor.importLayout(d), isolated);
    const exportPixels = await page.evaluate(async () => {
      const c = await BlueprintEditor.exportCanvas(undefined, 64, true), image = c.getContext('2d').getImageData(0, 0, c.width, c.height);
      let minX = c.width, minY = c.height, maxX = -1, maxY = -1;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (image.data[(y * c.width + x) * 4 + 3]) {
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
      return {width: c.width, height: c.height, minX, minY, maxX, maxY, cornerAlpha: image.data[3]};
    });
    assert.deepEqual([exportPixels.width, exportPixels.height], [448, 320]);
    assert.equal(exportPixels.cornerAlpha, 0);
    assert(exportPixels.minX >= 64 && exportPixels.minX < 84 && exportPixels.maxX > 360 && exportPixels.maxX < 384);
    assert(exportPixels.minY >= 64 && exportPixels.maxY > 236 && exportPixels.maxY < 256);
    passed.push('cold export awaits image decode; rotated bounds, crop offset and alpha correct');
    await page.locator('#transparent').check();
    const pngWait = page.waitForEvent('download'); await page.locator('#btnPng').click(); const png = await pngWait;
    await png.saveAs(path.join(out, 'rectangular_export.png'));
    const jsonWait = page.waitForEvent('download'); await page.locator('#btnJson').click(); const json = await jsonWait;
    const jsonFile = path.join(out, 'exported_layout.json'); await json.saveAs(jsonFile);
    assert.equal(JSON.parse(await fs.readFile(jsonFile, 'utf8')).nodes[0].direction, 1);
    passed.push('real PNG and JSON downloads');
    await page.waitForFunction(() => document.getElementById('saveStatus').textContent.includes('已保存'));
    const saved = await page.evaluate(() => BlueprintEditor.getData());
    await page.reload(); await page.evaluate(() => BlueprintEditor.ready);
    assert.deepEqual(await page.evaluate(() => BlueprintEditor.getData()), saved);
    passed.push('automatic draft restore after reload');
    // Exercise actual file input, search selection and placement after restore.
    await page.locator('#fileIn').setInputFiles(path.join(kit, 'examples/demo_blueprint.json'));
    await page.waitForFunction(() => BlueprintEditor.getData().nodes.length === 11);
    await page.locator('#search').fill('furnance_1');
    await page.locator('.building[data-id="furnance_1"]').click();
    assert.equal(await page.locator('.building.active').getAttribute('data-id'), 'furnance_1');
    await clickGrid(23.5, 3.5);
    assert.equal((await page.evaluate(() => BlueprintEditor.getData())).nodes.length, 12);
    passed.push('file input import and filtered palette placement');
    const saveShortcut = page.waitForEvent('download');
    await page.locator('#bpName').focus(); await page.locator('#bpName').press('Control+s');
    const shortcut = await saveShortcut; assert(shortcut.suggestedFilename().endsWith('.json'));
    passed.push('Ctrl+S works while name input has focus');
    await page.locator('[data-tool="select"]').click(); await clickGrid(4.5, 7.5);
    await page.evaluate(() => prepareScene(BlueprintEditor.getData()));
    await page.screenshot({path: path.join(out, 'editor_preview.png')});
    const demoPng = await page.evaluate(async () => (await BlueprintEditor.exportCanvas(undefined, 64, false)).toDataURL('image/png'));
    await fs.writeFile(path.join(out, 'layout_export.png'), Buffer.from(demoPng.split(',')[1], 'base64'));
    assert.equal(await page.evaluate(() => PAYLOAD.buildings.filter(b => b.logistic).length), 8);
    assert((await page.evaluate(() => BlueprintEditor.getData().nodes)).some(n => n.templateId === 'log_pipe_splitter'));
    passed.push('all eight original logistic junctions are available');
    await page.setViewportSize({width: 820, height: 920});
    await page.locator('#btnInspector').click();
    assert.equal(await page.locator('#btnChooseProduct').isVisible(), true);
    await page.locator('#btnCloseInspector').click();
    assert.equal(await page.locator('#btnChooseProduct').isVisible(), false);
    passed.push('narrow-window inspector can be opened and dismissed');
    assert.deepEqual(errors, []);
    const report = {passed: passed.length, checks: passed, browserErrors: errors, exportPixels};
    await fs.writeFile(path.join(out, 'browser_verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
