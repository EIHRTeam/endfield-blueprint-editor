const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const kit = path.resolve(__dirname, '..'), out = path.join(kit, 'reports/test-artifacts');
(async () => {
  await fs.mkdir(path.join(kit, 'reports/test-artifacts'), {recursive: true});
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1520, height: 1020}}), errors = [], checks = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(pathToFileURL(path.join(kit, 'dist/blueprint_editor.html')).href);
    await page.evaluate(() => BlueprintEditor.ready);
    const fixture = {schemaVersion: 2, name: '拖动中旋转', size: {x: 24, z: 22}, conveyors: [],
      nodes: [{templateId: 'tools_assebling_mc_1', position: {x: 3, z: 5}, direction: 0}]};
    await page.evaluate(d => { BlueprintEditor.importLayout(d); view.s = 42; view.ox = 20; view.oy = 15; requestDraw(); }, fixture);
    await page.evaluate(() => prepareScene(data));
    const grid = async (x, z) => page.evaluate(({x, z}) => { const r = canvas.getBoundingClientRect();
      return {x: r.x + view.ox + x * view.s, y: r.y + view.oy + z * view.s}; }, {x, z});
    const start = await grid(5.5, 7.5), first = await grid(9.5, 7.5), end = await grid(10.5, 8.5);
    const countBefore = await page.evaluate(() => history.past.length);
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(first.x, first.y, {steps: 6});
    await page.keyboard.press('r');
    const during = await page.evaluate(() => ({document: C.clone(data.nodes[0]), preview: C.clone(gesture.preview), count: history.past.length}));
    assert.deepEqual(during.document, fixture.nodes[0]); assert.equal(during.preview.direction, 1); assert.equal(during.count, countBefore);
    await page.mouse.move(end.x, end.y, {steps: 4});
    assert.equal(await page.evaluate(() => gesture.preview.direction), 1);
    await page.screenshot({path: path.join(kit, 'reports/test-artifacts/drag_rotation_preview.png')});
    await page.mouse.up();
    const placed = await page.evaluate(() => C.clone(data.nodes[0]));
    assert.deepEqual(placed.position, {x: 8, z: 6}); assert.equal(placed.direction, 1);
    assert.equal(await page.evaluate(() => history.past.length), countBefore + 1);
    checks.push('R rotates the moving preview only; further mouse movement preserves it; release commits once');
    await page.locator('#btnUndo').click(); assert.deepEqual(await page.evaluate(() => C.clone(data.nodes[0])), fixture.nodes[0]);
    await page.locator('#btnRedo').click(); assert.deepEqual(await page.evaluate(() => C.clone(data.nodes[0])), placed);
    checks.push('one undo/redo restores both position and rotation');
    let p = await grid(9.5, 8.5), q = await grid(13.5, 8.5);
    await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(q.x, q.y, {steps: 5}); await page.keyboard.press('r');
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => C.clone(data.nodes[0])), placed);
    assert.equal(await page.evaluate(() => history.past.length), countBefore + 1);
    checks.push('Escape cancels a moved and rotated preview without changing the document');
    // The same cancellation contract must hold for a lost pointer stream.
    await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(q.x, q.y, {steps: 3}); await page.keyboard.press('r');
    await page.locator('#cv').dispatchEvent('pointercancel'); await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => C.clone(data.nodes[0])), placed);
    checks.push('pointer cancellation does not leak preview rotation into the original');
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(out, 'drag_rotation_verification.json'), JSON.stringify({checks, during, placed, errors}, null, 2));
    console.log(JSON.stringify({passed: checks.length, checks, errors}, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
