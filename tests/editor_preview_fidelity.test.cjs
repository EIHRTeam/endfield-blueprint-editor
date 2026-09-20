const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'reports/test-artifacts');

(async () => {
  await fs.mkdir(out, {recursive: true});
  // Independent Pillow compositor, driven by the recovered Unity port grouping rules.
  const oracle = spawnSync('python', ['-c', `
import sys,json
from pathlib import Path
r=Path(sys.argv[1]);sys.path.insert(0,str(r/'src'))
from bake_blueprint_sprites import BlueprintBaker
b=BlueprintBaker();cases=[]
for bid,mode,all_closed in [('planter_1',None,False),('furnance_1',None,False),('shaper_1','normal',False),('planter_1',None,True)]:
 ports=[(field,p['index']) for field in ('inputPorts','outputPorts') for p in b.buildings[bid][field]]
 closed=ports if all_closed else ports[::2]
 for direction in range(4):
  filename='port-oracle-'+str(len(cases))+'.png'
  b.body(bid,direction,mode,closed).save(r/'reports/test-artifacts'/filename)
  cases.append(dict(templateId=bid,direction=direction,formulaMode=mode,closedPorts=[('input:' if f=='inputPorts' else 'output:')+str(n) for f,n in closed],file=filename))
print(json.dumps(cases))
`, root], {encoding: 'utf8'});
  assert.equal(oracle.status, 0, oracle.stderr);
  const cases = JSON.parse(oracle.stdout);
  for (const c of cases) c.image = 'data:image/png;base64,' + (await fs.readFile(path.join(out, c.file))).toString('base64');
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1680, height: 1050}}), checks = [], errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(pathToFileURL(path.join(root, 'dist/blueprint_editor.html')).href);
    await page.evaluate(() => BlueprintEditor.ready);
    const comparisons = await page.evaluate(async cases => {
      const results = [];
      for (const c of cases) {
        const n = {...c, position: {x: 0, z: 0}}; await prepareScene({nodes: [n]});
        const actual = nodeBody(n), im = new Image(); im.src = c.image; await im.decode();
        const pixels = image => {
          const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
          const ctx = cv.getContext('2d'); ctx.fillStyle = '#e6e6e6'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.drawImage(image, 0, 0);
          return ctx.getImageData(0, 0, cv.width, cv.height).data;
        };
        const a = pixels(actual), b = pixels(im); let total = 0, large = 0;
        for (let i = 0; i < a.length; i++) { const diff = Math.abs(a[i] - b[i]); total += diff; if (diff > 8) large++; }
        results.push({id: c.templateId, direction: c.direction, mean: total / a.length, large: large / a.length});
      }
      return results;
    }, cases);
    for (const c of comparisons) assert(c.mean < .6 && c.large < .002, JSON.stringify(c));
    checks.push('16 sparse, all-closed and mixed item/pipe port bodies match independent native-sprite composition in all four rotations');

    const layout = {schemaVersion: 2, name: '环境与接口预览', size: {x: 40, z: 24}, nodes: [
      {templateId: 'planter_1', position: {x: 3, z: 3}, direction: 0, productIcon: 'item_plant_grass_1'},
      {templateId: 'planter_1', position: {x: 12, z: 3}, direction: 1, productIcon: 'item_plant_grass_1', environmentEffect: 'stable'},
      {templateId: 'vaporizer_1', position: {x: 20, z: 4}, direction: 0, productIcon: '[gas]stable'},
      {templateId: 'seedcollector_1', position: {x: 3, z: 13}, direction: 2},
      {templateId: 'power_diffuser_1', position: {x: 21, z: 11}, direction: 0}
    ], conveyors: [{x: 35, z: 20, kind: 'fluid', dir: 0}], presentation: {creatorId: '1000000002', tags: [], coverColor: 'orange'}};
    await page.evaluate(d => BlueprintEditor.importLayout(d), layout);
    const pos = await page.evaluate(() => { const f = C.footprint(data.nodes[0], buildings), r = canvas.getBoundingClientRect(); return {x: r.x + view.ox + (f.x + f.w / 2) * view.s, y: r.y + view.oy + (f.z + f.d / 2) * view.s}; });
    await page.mouse.click(pos.x, pos.y);
    await page.locator('#nodeEnvironment').selectOption('stable');
    await page.locator('#portVisibilityFields summary').click();
    const port = page.locator('[data-port="input:1"]'); await port.uncheck();
    assert.equal(await page.evaluate(() => data.nodes[0].environmentEffect), 'stable');
    assert.deepEqual(await page.evaluate(() => data.nodes[0].closedPorts), ['input:1']);
    await page.locator('#nodeDirection').selectOption('1');
    assert.deepEqual(await page.evaluate(() => data.nodes[0].closedPorts), ['input:1']);
    const connection = await page.evaluate(() => ({closed: C.worldPorts(data.nodes[0], buildings).some(p => p.id === 'input:1'), count: C.worldPorts(data.nodes[0], buildings).length}));
    assert.equal(connection.closed, false);
    await page.locator('#btnUndo').click(); assert.equal(await page.evaluate(() => data.nodes[0].direction), 0);
    await page.locator('#btnRedo').click(); assert.equal(await page.evaluate(() => data.nodes[0].direction), 1);
    checks.push('real environment selector and per-port checkbox persist through rotation and undo; hidden ports are excluded from line snapping');

    const environment = await page.evaluate(async () => {
      const n = {...data.nodes[0], position: {x: 0, z: 0}, direction: 0}, hashes = [];
      for (const effect of ['', 'acid', 'humidity', 'inactive', 'stable', 'xiranite']) {
        n.environmentEffect = effect; await prepareScene({nodes: [n]});
        const cv = document.createElement('canvas'); cv.width = cv.height = 640;
        drawNode(cv.getContext('2d'), n, 128, 0, 0);
        hashes.push(cv.toDataURL());
      }
      return {count: new Set(hashes).size, missing: [...Object.keys(PAYLOAD.products)].filter(k => k === n.productIcon && !PAYLOAD.products[k].badge)};
    });
    assert.equal(environment.count, 6); assert.deepEqual(environment.missing, []);
    checks.push('all five original environment effect sprites produce distinct output independently of the central item badge');
    const hints = await page.evaluate(async () => {
      const off = await BlueprintEditor.exportPreview(data, 1920);
      const on = await BlueprintEditor.exportPreview({...data, presentation: {...data.presentation, showChangeHints: true}}, 1920);
      const a = off.getContext('2d').getImageData(0, 0, off.width, off.height).data;
      const b = on.getContext('2d').getImageData(0, 0, on.width, on.height).data;
      let left = 0, right = 0;
      for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2])
        (i / 4 % off.width < 1908 * .75) ? left++ : right++;
      return {left, right};
    });
    assert(hints.left > 20); assert.equal(hints.right, 0);
    checks.push('full preview defaults to native non-editable mode; optional change-icon hints alter only device annotations');

    await page.evaluate(() => saveNow()); const saved = await page.evaluate(() => BlueprintEditor.getData());
    await page.reload(); await page.evaluate(() => BlueprintEditor.ready);
    assert.deepEqual(await page.evaluate(() => BlueprintEditor.getData()), saved);
    const invalid = await page.evaluate(() => {
      const attempts = [];
      for (const update of [d => d.nodes[0].closedPorts = ['input:999'], d => d.nodes[0].environmentEffect = 'unknown', d => d.presentation.viewport = {zoom: 0, x: .5, y: .5}]) {
        const d = C.clone(data); update(d); try { C.validate(d, buildings); attempts.push(false); } catch { attempts.push(true); }
      } return attempts;
    });
    assert(invalid.every(Boolean));
    checks.push('annotation JSON survives reload and rejects invalid environment, port and viewport values');

    await page.locator('#btnGamePreview').click();
    await page.waitForFunction(() => document.getElementById('presentationCanvas').width === 1920);
    const inventory = await page.evaluate(() => BlueprintPresentation.inventory(data));
    await page.locator('#presentationZoom').fill('220'); await page.locator('#presentationZoom').dispatchEvent('input');
    await page.waitForFunction(() => document.getElementById('presentationZoomLabel').textContent === '220%');
    const box = await page.locator('#presentationCanvas').boundingBox();
    await page.mouse.move(box.x + box.width * .3, box.y + box.height * .5); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .4, box.y + box.height * .5, {steps: 5}); await page.mouse.up();
    assert(Number(await page.locator('#presentationPanX').inputValue()) < 50);
    await page.mouse.wheel(0, -120);
    await page.waitForFunction(() => Number(document.getElementById('presentationZoom').value) > 220);
    await page.locator('#btnApplyPresentation').click();
    assert.deepEqual(await page.evaluate(() => BlueprintPresentation.inventory(data)), inventory);
    assert((await page.evaluate(() => data.presentation.viewport.zoom)) > 2.2);
    checks.push('preview range controls, drag and wheel change saved framing without changing blueprint bounds or equipment counts');
    await page.locator('#btnGamePreview').click();
    await page.waitForFunction(() => document.getElementById('presentationZoomLabel').textContent === `${Math.round(data.presentation.viewport.zoom * 100)}%`);
    await page.screenshot({path: path.join(out, 'preview_fidelity_editor.png')});
    const png = await page.evaluate(async () => (await BlueprintEditor.exportPreview()).toDataURL().split(',')[1]);
    await fs.writeFile(path.join(out, 'preview_fidelity.png'), Buffer.from(png, 'base64'));
    await fs.writeFile(path.join(out, 'preview_fidelity.json'), JSON.stringify(await page.evaluate(() => BlueprintEditor.getData()), null, 2));
    await page.locator('#btnResetViewport').click(); await page.locator('#btnCancelPresentation').click();
    assert((await page.evaluate(() => data.presentation.viewport.zoom)) > 2.2);
    checks.push('cropped full PNG exports original frame artwork and empty-tag placeholder; cancelling framing edits preserves saved composition');
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(out, 'preview_fidelity_verification.json'), JSON.stringify({checks, comparisons, errors}, null, 2));
    console.log(JSON.stringify({passed: checks.length, checks, errors}));
  } finally { await browser.close(); }
})().catch(e => {console.error(e); process.exitCode = 1;});
