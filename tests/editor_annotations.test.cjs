const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const kit = path.resolve(__dirname, '..'), out = path.join(kit, 'reports/test-artifacts');
const layout = {schemaVersion: 2, name: '准入口、仓库口与环境标记', size: {x: 28, z: 20}, conveyors: [
  ...[20, 21, 22].map(x => ({x, z: 4, dir: 0, kind: 'item'})),
  ...[20, 21].map(x => ({x, z: 6, dir: 0, kind: 'fluid'})),
  {x: 3, z: 3, dir: 0, kind: 'item'} // Legacy penetrating cell is hidden, so it is not counted.
], nodes: [
  {templateId: 'furnance_1', position: {x: 2, z: 2}, direction: 0, productIcon: 'item_copper_nugget'},
  {templateId: 'furnance_1', position: {x: 2, z: 7}, direction: 1, productIcon: 'item_iron_nugget'},
  {templateId: 'log_conditioner', position: {x: 8, z: 3}, direction: 0},
  {templateId: 'log_pipe_conditioner', position: {x: 8, z: 8}, direction: 1},
  {templateId: 'unloader_1', position: {x: 12, z: 2}, direction: 1},
  {templateId: 'loader_1', position: {x: 12, z: 7}, direction: 1, productIcon: 'item_liquid_water'},
  {templateId: 'log_hongs_bus', position: {x: 14, z: 2}, direction: 0},
  {templateId: 'vaporizer_1', position: {x: 2, z: 13}, direction: 0}
]};
(async () => {
  await fs.mkdir(path.join(kit, 'reports/test-artifacts'), {recursive: true});
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1560, height: 1080}}), errors = [], checks = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(pathToFileURL(path.join(kit, 'dist/blueprint_editor.html')).href); await page.evaluate(() => BlueprintEditor.ready);
    await page.evaluate(d => BlueprintEditor.importLayout(d), layout);
    async function select(i) {
      const p = await page.evaluate(i => { const f = C.footprint(data.nodes[i], buildings), r = canvas.getBoundingClientRect();
        return {x: r.x + view.ox + (f.x + f.w / 2) * view.s, y: r.y + view.oy + (f.z + f.d / 2) * view.s}; }, i);
      await page.mouse.click(p.x, p.y);
    }
    for (const [index, id] of [[2, 'item_iron_nugget'], [3, 'item_liquid_plant_grass_1'], [4, 'item_gas_acid']]) {
      await select(index); await page.locator('#btnChooseProduct').click();
      await page.locator('#productSearch').fill(id); await page.locator(`[data-product="${id}"]`).click();
      assert.equal(await page.evaluate(i => data.nodes[i].productIcon, index), id);
    }
    checks.push('both admission gates and rotated warehouse mouth accept independent round item annotations');
    await select(7); await page.locator('#btnChooseProduct').click(); await page.locator('#productScope').selectOption('environment');
    assert.equal(await page.locator('.product-card').count(), 5);
    await page.locator('[data-product="[gas]acid"]').click();
    assert.equal(await page.evaluate(() => data.nodes[7].productIcon), '[gas]acid');
    checks.push('original yellow acid-environment symbol is selectable from the environment category');
    const card = page.locator('.summary-card[data-item="item_port_furnance_1"]');
    assert.equal(await card.locator('b').textContent(), '2');
    assert.equal(await card.locator('img').count(), 1);
    assert((await card.getAttribute('style')).includes('--rarity'));
    await card.click(); assert.equal(await page.evaluate(() => selected), 0);
    await card.click(); assert.equal(await page.evaluate(() => selected), 1);
    assert(await page.evaluate(() => ['log_conditioner', 'log_pipe_conditioner'].every(id => buildings[id].palette !== buildings[id].faces[0])));
    checks.push('equipment cards use original item images, rarity color and counts; clicking cycles matching devices');
    const beltCard = page.locator('.summary-card[data-item="item_log_belt_01"]');
    const pipeCard = page.locator('.summary-card[data-item="item_log_pipe_01"]');
    assert.equal(await beltCard.locator('b').textContent(), '3');
    assert.equal(await pipeCard.locator('b').textContent(), '2');
    await beltCard.click(); assert.equal(await page.evaluate(() => tool), 'item');
    await pipeCard.click(); assert.equal(await page.evaluate(() => tool), 'fluid');
    await card.click();
    checks.push('line cards count visible belt and pipe cells and activate the matching drawing tool');
    await page.evaluate(() => prepareScene(data));
    await page.locator('#summaryList img').evaluateAll(images => Promise.all(images.map(i => i.decode())));
    await page.screenshot({path: path.join(kit, 'reports/test-artifacts/annotations_equipment_editor.png')});
    const png = await page.evaluate(async () => (await BlueprintEditor.exportCanvas(undefined, 64, false)).toDataURL().split(',')[1]);
    await fs.writeFile(path.join(kit, 'reports/test-artifacts/annotations_equipment.png'), Buffer.from(png, 'base64'));
    await fs.writeFile(path.join(kit, 'reports/test-artifacts/annotations_equipment.json'), JSON.stringify(await page.evaluate(() => BlueprintEditor.getData()), null, 2));
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(out, 'annotations_verification.json'), JSON.stringify({checks, errors}, null, 2));
    console.log(JSON.stringify({passed: checks.length, checks, errors}, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
