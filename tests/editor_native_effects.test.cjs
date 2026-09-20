const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'reports/test-artifacts');

(async () => {
  const checks = [], errors = [], browser = await chromium.launch({channel: 'chrome', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1680, height: 1100}});
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(pathToFileURL(path.join(root, 'dist/blueprint_editor.html')).href);
    await page.evaluate(() => BlueprintEditor.ready);
    const grid = await page.evaluate(() => {
      const create = () => { const cv = document.createElement('canvas'); cv.width = cv.height = 512; return cv; };
      const a = create(), b = create(); drawNativeGrid(a.getContext('2d'), {s: 128, ox: 0, oy: 0}, {x: 0, y: 0, w: 512, h: 512});
      for (const x of [0, 256]) for (const y of [0, 256]) b.getContext('2d').drawImage(asset(PAYLOAD.sprites.grid), x, y);
      const pixels = a.getContext('2d').getImageData(0, 0, 512, 512).data;
      return {identical: a.toDataURL() === b.toDataURL(), alphas: [...new Set(Array.from(pixels).filter((v, i) => i % 4 === 3))].length};
    });
    assert(grid.identical); assert(grid.alphas > 3);
    checks.push('grid output exactly repeats the native transparent tile, including multiple line/intersection alpha levels');
    const fixture = {schemaVersion: 2, name: '暗管原始显示效果', size: {x: 30, z: 24}, nodes: [
      {templateId: 'udpipe_unloader_2', position: {x: 18, z: 13}, direction: 1},
      {templateId: 'udpipe_loader_2', position: {x: 2, z: 3}, direction: 0},
      {templateId: 'udpipe_loader_1', position: {x: 11, z: 2}, direction: 2}
    ], conveyors: []};
    await page.evaluate(d => BlueprintEditor.importLayout(d), fixture);
    const center = await page.evaluate(() => { const f = C.footprint(data.nodes[1], buildings), r = canvas.getBoundingClientRect(); return {x: r.x + view.ox + (f.x + f.w / 2) * view.s, y: r.y + view.oy + (f.z + f.d / 2) * view.s}; });
    await page.mouse.click(center.x, center.y);
    await page.locator('#undergroundPeer').selectOption('0');
    await page.locator('#btnConnection').click();
    assert.equal(await page.locator('#btnConnection').textContent(), '收起连接');
    await page.evaluate(() => prepareScene(data));
    const effect = await page.evaluate(() => {
      const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128;
      const c = cv.getContext('2d'); drawSlicedSprite(c, 'udpipe_line', 0, 0, 256, 128, 1);
      const im = c.getImageData(0, 0, 256, 128).data;
      let bestY = 0, best = 0;
      for (let y = 0; y < 128; y++) { const a = im[(y * 256 + 128) * 4 + 3]; if (a > best) {best = a; bestY = y;} }
      const middle = Array.from({length: 56}, (_, i) => im[(bestY * 256 + i + 100) * 4 + 3]);
      return {centerAlpha: best, edgeAlpha: im[bestY * 256 * 4 + 3], continuous: middle.every(a => a > 0),
        distinctFrames: buildings.udpipe_loader_2.connectionFrames.every((key, i) => key !== buildings.udpipe_loader_2.activeConnectionFrames[i]),
        active: activePair === data.nodes[0].undergroundPair};
    });
    assert(effect.continuous && effect.centerAlpha > effect.edgeAlpha && effect.distinctFrames && effect.active);
    await page.screenshot({path: path.join(out, 'native_effects_editor.png')});
    checks.push('real pair/view controls activate original concentric frames and a continuous cyan connection with faded ends');
    const selection = await page.evaluate(() => {
      const result = [];
      for (const key of ['selection_frame', 'hover_frame']) {
        const cv = document.createElement('canvas'); cv.width = 600; cv.height = 360;
        const c = cv.getContext('2d'); drawSlicedSprite(c, key, 0, 0, 600, 360, 1);
        const p = c.getImageData(0, 0, 600, 360).data;
        result.push({key, visible: p.some((v, i) => i % 4 === 3 && v > 0), center: p[(180 * 600 + 300) * 4 + 3]});
      }
      return result;
    });
    assert(selection.every(r => r.visible && r.center === 0));
    checks.push('native selected corners and hover outlines preserve a transparent center when stretched over rectangular devices');
    await page.locator('#btnGamePreview').click();
    const pairId = await page.evaluate(() => data.nodes[0].undergroundPair);
    await page.locator('#presentationConnectionPair').selectOption(pairId);
    await page.locator('#btnApplyPresentation').click();
    const saved = await page.evaluate(() => BlueprintEditor.getData());
    assert.equal(saved.presentation.connectionPair, pairId);
    const pictures = await page.evaluate(async () => {
      const on = await BlueprintEditor.exportPreview(data), offData = C.clone(data); offData.presentation.connectionPair = '';
      const off = await BlueprintEditor.exportPreview(offData), repeated = await BlueprintEditor.exportPreview(data);
      const a = on.getContext('2d').getImageData(0, 0, on.width, on.height).data, b = off.getContext('2d').getImageData(0, 0, off.width, off.height).data;
      let left = 0, right = 0;
      for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) (i / 4 % on.width < 1908) ? left++ : right++;
      return {left, right, stable: on.toDataURL() === repeated.toDataURL(), png: on.toDataURL().split(',')[1]};
    });
    assert(pictures.left > 500 && pictures.right === 0 && pictures.stable);
    await fs.writeFile(path.join(out, 'native_effects_preview.png'), Buffer.from(pictures.png, 'base64'));
    await fs.writeFile(path.join(out, 'native_effects_layout.json'), JSON.stringify(saved, null, 2));
    checks.push('saved connection choice affects only the exported layout; the 0.5-second pulse snapshot exports deterministically');
    await page.reload(); await page.evaluate(() => BlueprintEditor.ready);
    assert.deepEqual(await page.evaluate(() => BlueprintEditor.getData()), saved);
    const stale = await page.evaluate(async () => {
      const d = C.clone(data); C.removeNode(d.nodes, 0); C.validate(d, buildings);
      const png = await BlueprintEditor.exportPreview(d, 1920); BlueprintEditor.importLayout(d);
      return {width: png.width, connection: d.presentation.connectionPair};
    });
    assert.equal(stale.width, 1920); assert.equal(stale.connection, pairId);
    await page.locator('#btnGamePreview').click();
    assert.equal(await page.locator('#presentationConnectionPair').inputValue(), pairId);
    assert(await page.locator('#presentationConnectionPair').isDisabled());
    await page.locator('#btnApplyPresentation').click();
    const invalid = await page.evaluate(() => { const d = C.clone(data); d.presentation.connectionPair = {}; try { C.validate(d, buildings); return false; } catch { return true; } });
    assert(invalid); assert.deepEqual(errors, []);
    checks.push('connection choice survives reload and remains safe after removing a peer; invalid field types are rejected');
    console.log(JSON.stringify({passed: checks.length, checks, errors}));
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
