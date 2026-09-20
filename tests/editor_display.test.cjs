const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const kit = path.resolve(__dirname, '..');
const out = path.join(kit, 'reports/test-artifacts');
const proof = {schemaVersion: 2, name: '物品、准入口与暗管连接', size: {x: 28, z: 20}, conveyors: [], nodes: [
  {templateId: 'furnance_1', position: {x: 2, z: 2}, direction: 0, productIcon: 'item_copper_nugget'},
  {templateId: 'furnance_1', position: {x: 8, z: 2}, direction: 0, productIcon: 'item_iron_nugget'},
  {templateId: 'unloader_1', position: {x: 14, z: 2}, direction: 0, productIcon: 'item_iron_ore'},
  {templateId: 'log_conditioner', position: {x: 3, z: 8}, direction: 0, productIcon: 'item_copper_nugget'},
  {templateId: 'log_pipe_conditioner', position: {x: 9, z: 8}, direction: 0, productIcon: 'item_liquid_water'},
  {templateId: 'udpipe_loader_2', position: {x: 2, z: 12}, direction: 1},
  {templateId: 'udpipe_unloader_2', position: {x: 12, z: 12}, direction: 1},
  {templateId: 'udpipe_unloader_1', position: {x: 20, z: 12}, direction: 0}
]};
(async () => {
  await fs.mkdir(path.join(kit, 'reports/test-artifacts'), {recursive: true});
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  try {
    const context = await browser.newContext({viewport: {width: 1600, height: 1060}});
    const page = await context.newPage(), errors = [], checks = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(pathToFileURL(path.join(kit, 'dist/blueprint_editor.html')).href);
    await page.evaluate(() => BlueprintEditor.ready);
    await page.evaluate(d => BlueprintEditor.importLayout(d), proof);
    async function select(index) {
      const p = await page.evaluate(i => { const n = data.nodes[i], f = C.footprint(n, buildings), r = canvas.getBoundingClientRect();
        return {x: r.x + view.ox + (f.x + f.w / 2) * view.s, y: r.y + view.oy + (f.z + f.d / 2) * view.s}; }, index);
      await page.mouse.click(p.x, p.y);
    }
    await select(3);
    assert.equal(await page.locator('#productLabel').textContent(), '准入物品图标');
    await page.locator('#btnChooseProduct').click();
    await page.locator('#productScope').selectOption('solid');
    await page.locator('#productSearch').fill('item_iron_nugget');
    await page.locator('[data-product="item_iron_nugget"]').click();
    await page.locator('#btnChooseProduct').click();
    await page.locator('#productScope').selectOption('solid');
    assert.equal(await page.evaluate(() => data.nodes[3].productIcon), 'item_iron_nugget');
    await page.locator('#productSearch').fill('');
    const hasLiquid = await page.locator('[data-product="item_liquid_water"]').count(); assert.equal(hasLiquid, 0);
    checks.push('item admission icon is searchable and solid filter excludes liquid');
    await page.locator('#btnCloseLibrary').click();
    await select(4);
    await page.locator('#btnChooseProduct').click();
    await page.locator('#productScope').selectOption('liquid');
    await page.locator('[data-product="item_liquid_sewage"]').click();
    await page.locator('#btnChooseProduct').click();
    await page.locator('#productScope').selectOption('liquid');
    assert.equal(await page.evaluate(() => data.nodes[4].productIcon), 'item_liquid_sewage');
    assert.equal(await page.locator('[data-product="item_iron_nugget"]').count(), 0);
    checks.push('pipe admission supports liquid badge selection');
    await page.locator('#btnCloseLibrary').click();
    await select(2); await page.locator('#btnChooseProduct').click();
    await page.locator('#productSearch').fill('item_copper_ore');
    await page.locator('[data-product="item_copper_ore"]').click();
    assert.equal(await page.evaluate(() => data.nodes[2].productIcon), 'item_copper_ore');
    checks.push('warehouse unloader can select display item without a recipe');
    const changeCoverage = await page.evaluate(() => ({furnace: buildings.furnance_1.canModify,
      warehouse: buildings.unloader_1.canModify, valve: buildings.log_conditioner.canModify,
      pump: buildings.pump_1.products.includes('item_liquid_water'), subHub: buildings.sp_sub_hub_1.products.length,
      newlyExtracted: Boolean(productInfo('item_arrow_chip_bomb')?.badge)}));
    assert.deepEqual([changeCoverage.furnace, changeCoverage.warehouse, changeCoverage.valve], [true, false, false]);
    assert(changeCoverage.pump && changeCoverage.subHub > 0 && changeCoverage.newlyExtracted);
    checks.push('change hint follows original table; pump, sub-hub and missing-item catalog completed');
    await select(5);
    assert.equal(await page.locator('#btnConnection').isDisabled(), true);
    await page.locator('#undergroundPeer').selectOption('6');
    assert.equal(await page.locator('#btnConnection').isDisabled(), false);
    assert.equal(await page.evaluate(() => data.nodes[5].undergroundPair === data.nodes[6].undergroundPair), true);
    await page.locator('#btnConnection').click(); assert.equal(await page.locator('#btnConnection').textContent(), '收起连接');
    const linked = await page.evaluate(() => BlueprintEditor.getData());
    await page.locator('#btnDeleteNode').click();
    assert.equal(await page.evaluate(() => data.nodes.filter(n => n.undergroundPair).length), 0);
    await page.locator('#btnUndo').click();
    assert.deepEqual(await page.evaluate(() => BlueprintEditor.getData()), linked);
    checks.push('pair and view underground endpoints; deleting and undoing preserves valid pairing');
    // Inspect pixels, not only metadata: all three overlays alter their expected region.
    const pixels = await page.evaluate(async () => {
      const enabled = await BlueprintEditor.exportCanvas(undefined, 64, true, true);
      const disabled = await BlueprintEditor.exportCanvas(undefined, 64, true, false);
      const a = enabled.getContext('2d').getImageData(0, 0, enabled.width, enabled.height).data;
      const b = disabled.getContext('2d').getImageData(0, 0, disabled.width, disabled.height).data;
      const bounds = C.bounds(data, buildings, 1);
      return data.nodes.map(n => { const f = C.footprint(n, buildings); let changed = 0;
        for (let y = (f.z - bounds.z0) * 64; y < (f.z - bounds.z0 + f.d) * 64; y++)
          for (let x = (f.x - bounds.x0) * 64; x < (f.x - bounds.x0 + f.w) * 64; x++) {
            const offset = (y * enabled.width + x) * 4;
            if (a.slice(offset, offset + 4).some((v, i) => v !== b[offset + i])) changed++;
          }
        return changed; });
    });
    assert(pixels[0] > 50 && pixels[5] > 50 && pixels[7] > 50);
    assert.equal(pixels[2], 0); assert.equal(pixels[3], 0);
    checks.push('PNG pixel differences verify change, connected and disconnected overlays; no false change badge on valves');
    // Select pipe admission for the screenshot, preserving pair and item settings on disk.
    await select(4);
    await page.evaluate(() => { activePair = null; requestDraw(); saveNow(); });
    await page.screenshot({path: path.join(out, 'display_completion_editor.png')});
    const png = await page.evaluate(async () => (await BlueprintEditor.exportCanvas(undefined, 64, false, true)).toDataURL().split(',')[1]);
    await fs.writeFile(path.join(kit, 'reports/test-artifacts/display_completion.png'), Buffer.from(png, 'base64'));
    const saved = await page.evaluate(() => BlueprintEditor.getData());
    await fs.writeFile(path.join(kit, 'reports/test-artifacts/display_completion.json'), JSON.stringify(saved, null, 2));
    await page.reload(); await page.evaluate(() => BlueprintEditor.ready);
    assert.deepEqual(await page.evaluate(() => BlueprintEditor.getData()), saved);
    checks.push('item annotations and both underground endpoints survive autosave/reload');
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(out, 'display_verification.json'), JSON.stringify({checks, pixels, errors}, null, 2));
    console.log(JSON.stringify({passed: checks.length, checks, pixels, errors}, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
