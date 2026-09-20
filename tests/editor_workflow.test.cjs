const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const kit = path.resolve(__dirname, '..'), out = path.join(kit, 'reports/test-artifacts');
const fixture = {schemaVersion: 2, name: '传送带接口收口检查', size: {x: 24, z: 22}, nodes: [
  {templateId: 'tools_assebling_mc_1', position: {x: 8, z: 8}, direction: 0}
], conveyors: []};
(async () => {
  await fs.mkdir(path.join(kit, 'reports/test-artifacts'), {recursive: true});
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1520, height: 1040}}), errors = [], checks = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(pathToFileURL(path.join(kit, 'dist/blueprint_editor.html')).href);
    await page.evaluate(() => BlueprintEditor.ready);
    await page.evaluate(d => BlueprintEditor.importLayout(d), fixture);
    await page.locator('#btnItemLibrary').click();
    assert.equal(await page.locator('#productScope').inputValue(), 'all');
    await page.locator('#productSearch').fill('铁');
    assert(await page.locator('.product-card').count() > 2);
    assert(await page.locator('.product-card img').count() > 2);
    await page.locator('.product-card img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
    const container = await page.evaluate(() => {
      const rows = Object.entries(PAYLOAD.products).filter(([id, p]) => id.startsWith('item_fbottle_iron_') && p.contentId);
      return {count: rows.length, names: rows.map(([id, p]) => p.name), badges: new Set(rows.map(([id, p]) => p.badge)).size};
    });
    assert(container.count > 2 && container.badges > 2); assert(container.names.every(n => n.includes(' · ')));
    await page.screenshot({path: path.join(kit, 'reports/test-artifacts/item_library_search.png')});
    await page.locator('#productSearch').fill('item_iron_nugget');
    await page.locator('[data-product="item_iron_nugget"]').click();
    assert.equal(await page.evaluate(() => tool), 'icon');
    const grid = async (x, z) => page.evaluate(({x, z}) => { const r = canvas.getBoundingClientRect();
      return {x: r.x + view.ox + x * view.s, y: r.y + view.oy + z * view.s}; }, {x, z});
    let center = await grid(11, 10); await page.mouse.click(center.x, center.y);
    assert.equal(await page.evaluate(() => data.nodes[0].productIcon), 'item_iron_nugget');
    checks.push('global Chinese/ID image search works without selecting a device; image brush applies badge');
    checks.push('filled bottles carry distinct content icons and searchable content names');
    await page.keyboard.press('Escape');
    center = await grid(11, 10); await page.mouse.click(center.x, center.y);
    await page.locator('#btnChooseProduct').click();
    await page.locator('#productSearch').fill('item_arrow_chip_bomb');
    assert.equal(await page.locator('[data-product="item_arrow_chip_bomb"]').count(), 1);
    await page.keyboard.press('Delete'); assert.equal(await page.evaluate(() => data.nodes.length), 1);
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#itemLibrary').isVisible(), false);
    checks.push('device picker defaults to all items and modal keyboard does not delete canvas devices');
    await page.locator('#btnItemLibrary').click(); await page.locator('#productAvailability').selectOption('missing');
    assert.equal(await page.locator('.product-card').count(), 29);
    assert.equal(await page.locator('.product-card:enabled').count(), 0);
    assert((await page.locator('#productResults').textContent()).includes('游戏表未配置图标'));
    await page.locator('#productAvailability').selectOption('available'); await page.locator('#productSearch').fill('item_port_soil_1');
    assert.equal(await page.locator('[data-product="item_port_soil_1"]').isEnabled(), true);
    await page.locator('#btnCloseLibrary').click();
    checks.push('all 30 audited records resolved to one original sprite and 29 explicit unavailable records');
    await page.locator('[data-tool="item"]').click();
    // Leave visible space above the lone machine for a four-cell drag.
    await page.evaluate(() => { view.s = 48; view.ox = 20; view.oy = 20; requestDraw(); });
    const port = await page.evaluate(() => C.worldPorts(data.nodes[0], buildings).find(p => !p.pipe && p.input && p.dir === 3));
    assert(port);
    const a = await grid(port.outX + .5, port.outZ - 3 + .5), b = await grid(port.x + .5, port.z + .15);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, {steps: 12}); await page.mouse.up();
    const route = await page.evaluate(() => ({lines: data.conveyors, blocked: [...C.buildingCells(data, buildings)]}));
    assert(route.lines.length >= 4);
    assert(route.lines.every(p => !route.blocked.includes(`${p.x},${p.z}`)));
    assert.deepEqual([route.lines.at(-1).x, route.lines.at(-1).z, route.lines.at(-1).dir], [port.outX, port.outZ, 1]);
    assert((await page.locator('#status').textContent()).includes('吸附接口'));
    checks.push('real mouse drag into device terminates outside the visible input port');
    const interiorChanges = await page.evaluate(async () => {
      await prepareScene(data);
      const d = C.clone(data), p = C.worldPorts(d.nodes[0], buildings).find(p => !p.pipe && p.input && p.dir === 3);
      // Reproduce the old JSON with a complete extra belt tile inside the building.
      d.conveyors.push({x: p.x, z: p.z, kind: 'item', dir: 1, fromDir: 1});
      const render = layout => { const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 1100;
        paintScene(canvas.getContext('2d'), layout, {s: 48, ox: 0, oy: 0}); return canvas.getContext('2d').getImageData(0, 0, 1200, 1100).data; };
      const a = render(d), b = render({...d, conveyors: []}), f = C.footprint(d.nodes[0], buildings); let changed = 0;
      for (let y = Math.ceil((f.z + .35) * 48); y < (f.z + f.d) * 48; y++)
        for (let x = f.x * 48; x < (f.x + f.w) * 48; x++) { const offset = (y * 1200 + x) * 4;
          if (a.slice(offset, offset + 4).some((v, i) => v !== b[offset + i])) changed++; }
      return changed;
    });
    assert.equal(interiorChanges, 0);
    checks.push('legacy penetrating belt tile is clipped; transparent building interior stays unchanged');
    const png = await page.evaluate(async () => (await BlueprintEditor.exportCanvas(undefined, 64, false)).toDataURL().split(',')[1]);
    await fs.writeFile(path.join(kit, 'reports/test-artifacts/conveyor_port_fix.png'), Buffer.from(png, 'base64'));
    const rotated = structuredClone(fixture); rotated.nodes[0].direction = 1;
    await page.evaluate(d => BlueprintEditor.importLayout(d), rotated);
    const rotatedRoute = await page.evaluate(() => {
      const p = C.worldPorts(data.nodes[0], buildings).find(p => !p.pipe && p.input && p.dir === 0);
      const route = C.connectedRoute(data, buildings, {x: p.outX + 3, z: p.outZ}, {x: p.x, z: p.z}, 'item');
      const blocked = C.buildingCells(data, buildings);
      return {last: route.path.at(-1), outside: route.path.every(q => !blocked.has(C.key(q.x, q.z))), p};
    });
    assert(rotatedRoute.outside); assert.equal(rotatedRoute.last.dir, 2);
    assert.equal(rotatedRoute.last.x, rotatedRoute.p.outX);
    checks.push('rotated rectangular device has correctly rotated snapping and arrow direction');
    await page.setViewportSize({width: 820, height: 840});
    await page.locator('#btnItemLibrary').click(); await page.locator('#productSearch').fill('清水');
    const box = await page.locator('#itemLibrary').boundingBox();
    assert(box.x >= 0 && box.x + box.width <= 820); assert(await page.locator('.product-card img').count() > 0);
    await page.screenshot({path: path.join(out, 'item_library_narrow.png')});
    checks.push('image picker remains searchable and fully onscreen at narrow window size');
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(out, 'workflow_verification.json'), JSON.stringify({checks, interiorChanges, errors}, null, 2));
    console.log(JSON.stringify({passed: checks.length, checks, interiorChanges, errors}, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
