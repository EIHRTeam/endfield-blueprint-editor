const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {pathToFileURL} = require('node:url');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'reports/test-artifacts');

(async () => {
  const checks = [], errors = [];
  const html = await fs.readFile(path.join(root, 'dist/blueprint_editor.html'), 'utf8');
  const embedded = Buffer.from(html.match(/data:font\/ttf;base64,([A-Za-z0-9+/=]+)/)[1], 'base64');
  const font = await fs.readFile(path.join(root, 'assets/fonts/HarmonyOS_Sans_SC.ttf'));
  const hash = b => createHash('sha256').update(b).digest('hex');
  assert.equal(hash(embedded), hash(font));
  assert(html.includes('Huawei Device Co., Ltd.'));
  checks.push('offline HTML embeds the exact original HarmonyOS Sans SC font bytes and its license');
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1680, height: 1050}});
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      const originalLoad = document.fonts.load.bind(document.fonts);
      const gate = new Promise(resolve => window.releaseFontTest = resolve);
      document.fonts.load = async (...args) => { const faces = await originalLoad(...args); await gate; return faces; };
      window.textMeasures = [];
      const originalMeasure = CanvasRenderingContext2D.prototype.measureText;
      CanvasRenderingContext2D.prototype.measureText = function (...args) {
        window.textMeasures.push({font: this.font, status: document.fonts.status});
        return originalMeasure.apply(this, args);
      };
    });
    await page.goto(pathToFileURL(path.join(root, 'dist/blueprint_editor.html')).href);
    const layout = {schemaVersion: 2, name: '鸿蒙字体蓝图预览测试', size: {x: 12, z: 12}, nodes: [
      {templateId: 'planter_1', direction: 0, position: {x: 2, z: 2}, productIcon: 'item_plant_grass_1'}
    ], conveyors: [], presentation: {tags: ['鸿蒙字体', '测试'], description: '离线预览与 PNG 导出采用相同字体。'}};
    await page.evaluate(d => {
      BlueprintEditor.importLayout(d); window.textMeasures = []; window.coldExportDone = false;
      window.coldExport = BlueprintEditor.exportPreview(d, 1920).then(c => { window.coldExportDone = true; return c.toDataURL(); });
    }, layout);
    assert.equal(await page.evaluate(() => coldExportDone), false);
    assert.deepEqual(await page.evaluate(() => textMeasures), []);
    await page.evaluate(() => releaseFontTest());
    const fonts = await page.evaluate(async () => {
      await BlueprintEditor.ready;
      const first = await coldExport, second = (await BlueprintEditor.exportPreview(data, 1920)).toDataURL();
      return {same: first === second, faces: [...document.fonts].map(f => ({family: f.family, status: f.status, weight: f.weight})),
        body: getComputedStyle(document.body).fontFamily, measures: textMeasures};
    });
    assert(fonts.same); assert(fonts.body.includes('HarmonyOS Sans SC'));
    assert(fonts.faces.some(f => f.family.includes('HarmonyOS Sans SC') && f.status === 'loaded' && f.weight === '40 900'));
    assert(fonts.measures.length > 0 && fonts.measures.every(m => m.font.includes('HarmonyOS Sans SC') && m.status === 'loaded'));
    checks.push('first export waits for the embedded variable font before measuring text and matches subsequent export pixels');

    const pos = await page.evaluate(() => { const f = C.footprint(data.nodes[0], buildings), r = canvas.getBoundingClientRect(); return {x: r.x + view.ox + (f.x + f.w / 2) * view.s, y: r.y + view.oy + (f.z + f.d / 2) * view.s}; });
    await page.mouse.click(pos.x, pos.y);
    await page.locator('#nodeItemStatus').selectOption('limited');
    await page.locator('#nodeItemStatusColor').fill('#ff8844');
    await page.locator('#nodeItemStatusColor').dispatchEvent('change');
    await page.locator('#nodeDirection').selectOption('1');
    assert.equal(await page.evaluate(() => data.nodes[0].itemStatus), 'limited');
    assert.equal(await page.evaluate(() => data.nodes[0].itemStatusColor), '#ff8844');
    await page.locator('#btnUndo').click(); assert.equal(await page.evaluate(() => data.nodes[0].direction), 0);
    await page.locator('#btnRedo').click(); assert.equal(await page.evaluate(() => data.nodes[0].direction), 1);
    // Re-select after undo and redo, then ensure the license modal captures keyboard input.
    await page.mouse.click(pos.x, pos.y);
    const before = await page.evaluate(() => BlueprintEditor.getData());
    await page.locator('#btnFontLicense').click();
    await page.keyboard.press('r'); await page.keyboard.press('Delete');
    assert.deepEqual(await page.evaluate(() => BlueprintEditor.getData()), before);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#fontLicenseDialog').evaluate(e => e.open), false);
    checks.push('manual status and color controls support rotation and undo; font license modal does not mutate the selected device');

    const rendered = await page.evaluate(async () => {
      const states = ['normal', 'locked', 'limited', 'expired'], samples = [], rotationCounts = [];
      const sheet = document.createElement('canvas'); sheet.width = 1280; sheet.height = 360;
      const sc = sheet.getContext('2d'); sc.fillStyle = '#e6e6e6'; sc.fillRect(0, 0, sheet.width, sheet.height);
      for (const [index, status] of states.entries()) {
        const crops = [];
        for (let direction = 0; direction < 4; direction++) {
          const n = {...data.nodes[0], position: {x: 0, z: 0}, direction, itemStatus: status};
          await prepareScene({nodes: [n]}); const cv = document.createElement('canvas'); cv.width = cv.height = 640;
          const c = cv.getContext('2d'); c.fillStyle = '#e6e6e6'; c.fillRect(0, 0, 640, 640); drawNode(c, n, 128, 0, 0);
          const crop = document.createElement('canvas'); crop.width = crop.height = 160;
          crop.getContext('2d').drawImage(cv, 240, 240, 160, 160, 0, 0, 160, 160); crops.push(crop.toDataURL());
          if (!direction) { sc.drawImage(cv, index * 320, 35, 320, 320); sc.font = '24px "HarmonyOS Sans SC"'; sc.fillStyle = '#444'; sc.fillText(['普通', '锁定', '限时有效', '限时过期'][index], index * 320 + 30, 28); }
        }
        samples.push(crops[0]); rotationCounts.push(new Set(crops).size);
      }
      return {distinct: new Set(samples).size, rotationCounts, sheet: sheet.toDataURL().split(',')[1]};
    });
    assert.equal(rendered.distinct, 4); assert.deepEqual(rendered.rotationCounts, [1, 1, 1, 1]);
    await fs.writeFile(path.join(out, 'item_status_layers.png'), Buffer.from(rendered.sheet, 'base64'));
    checks.push('all four item states render distinctly and remain upright in every device rotation using the original sprite layers');
    const exported = await page.evaluate(async () => {
      const normal = C.clone(data); delete normal.nodes[0].itemStatus;
      const a = (await BlueprintEditor.exportPreview(normal, 1920)).toDataURL();
      const b = (await BlueprintEditor.exportPreview(data, 1920)).toDataURL();
      const changedColor = C.clone(data); changedColor.nodes[0].itemStatusColor = '#00ffff';
      const c = (await BlueprintEditor.exportPreview(changedColor, 1920)).toDataURL();
      return {status: a !== b, color: b !== c};
    });
    assert(exported.status && exported.color);
    checks.push('full preview PNG preserves optional item status and theme color with change-icon hints disabled');
    await page.evaluate(() => saveNow());
    await page.reload(); await page.evaluate(() => releaseFontTest()); await page.evaluate(() => BlueprintEditor.ready);
    assert.deepEqual(await page.evaluate(() => BlueprintEditor.getData()), before);
    const rejected = await page.evaluate(() => [n => n.itemStatus = 'wrong', n => n.itemStatusColor = 'red'].map(edit => {
      const d = C.clone(data); edit(d.nodes[0]); try { C.validate(d, buildings); return false; } catch { return true; }
    }));
    assert(rejected.every(Boolean)); assert.deepEqual(errors, []);
    checks.push('status and color survive draft reload; invalid annotation values are rejected without browser errors');
    console.log(JSON.stringify({passed: checks.length, checks, errors}));
  } finally { await browser.close(); }
})().catch(e => {console.error(e); process.exitCode = 1;});
