/* End-to-end acceptance run against the live local preview. All edits use the UI. */
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'reports/live-workflow');
const url = process.argv[2] || 'http://127.0.0.1:8769/blueprint_editor.html';

(async () => {
  await fs.mkdir(out, {recursive: true});
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  const context = await browser.newContext({viewport: {width: 1920, height: 1200}, acceptDownloads: true});
  const page = await context.newPage(), errors = [], failures = [], steps = [];
  let stage = 'startup';
  const done = text => { steps.push(text); console.log(text); };
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => failures.push({url: request.url(), error: request.failure()?.errorText}));
  page.on('response', response => { if (response.status() >= 400) failures.push({url: response.url(), status: response.status()}); });
  const documentData = () => page.evaluate(() => BlueprintEditor.getData());
  const grid = (x, z) => page.evaluate(({x, z}) => { const r = canvas.getBoundingClientRect(); return {x: r.x + view.ox + x * view.s, y: r.y + view.oy + z * view.s}; }, {x, z});
  const clickGrid = async (x, z) => { const p = await grid(x, z); await page.mouse.click(p.x, p.y); };
  const selectNode = async index => {
    await page.locator('[data-tool="select"]').click();
    const f = await page.evaluate(i => C.footprint(data.nodes[i], buildings), index);
    await clickGrid(f.x + f.w / 2 - .15, f.z + f.d / 2);
    assert.equal(await page.evaluate(() => selected), index);
  };
  const place = async (id, x, z) => {
    const count = (await documentData()).nodes.length;
    await page.locator('#search').fill(id); await page.locator(`.building[data-id="${id}"]`).click();
    await clickGrid(x + .25, z + .25);
    assert.equal((await documentData()).nodes.length, count + 1, `place ${id}: ${await page.locator('#status').textContent()}`);
    return count;
  };
  const mark = async (index, product) => {
    await selectNode(index); await page.locator('#btnChooseProduct').click();
    await page.locator('#productSearch').fill(product); await page.locator(`[data-product="${product}"]`).click();
    assert.equal((await documentData()).nodes[index].productIcon, product);
  };
  const connect = async (from, output, to, input, kind) => {
    await page.locator(`[data-tool="${kind}"]`).click();
    const points = await page.evaluate(({from, output, to, input}) => [
      C.worldPorts(data.nodes[from], buildings).find(p => p.id === output),
      C.worldPorts(data.nodes[to], buildings).find(p => p.id === input)
    ].map(p => ({x: p.edgeX - C.DV[p.dir][0] * .08, z: p.edgeZ - C.DV[p.dir][1] * .08, outX: p.outX, outZ: p.outZ})), {from, output, to, input});
    const a = await grid(points[0].x, points[0].z), b = await grid(points[1].x, points[1].z);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, {steps: 12}); await page.mouse.up();
    const d = await documentData();
    for (const p of points) assert(d.conveyors.some(c => c.x === p.outX && c.z === p.outZ && c.kind === kind), await page.locator('#status').textContent());
  };
  const download = async (selector, name) => {
    const waiting = page.waitForEvent('download'); await page.locator(selector).click();
    const file = await waiting; assert.equal(await file.failure(), null); await file.saveAs(path.join(out, name));
    return path.join(out, name);
  };
  try {
    const response = await page.goto(url); assert.equal(response.status(), 200);
    await page.evaluate(() => BlueprintEditor.ready); await page.locator('#loading').waitFor({state: 'hidden'});
    assert.equal((await documentData()).nodes.length, 0);
    done('Live HTTP page starts with an empty isolated draft and the embedded font loaded.');
    stage = 'place devices';
    const warehouse = await place('unloader_1', 4, 3);
    const furnace = await place('furnance_1', 4, 9);
    const furnace2 = await place('furnance_1', 13, 9);
    const shaper = await place('shaper_1', 4, 16);
    const tank = await place('liquid_storager_1', 20, 9);
    const assembler = await place('tools_assebling_mc_1', 22, 3);
    await place('power_diffuser_1', 16, 4);
    await page.locator('#btnFit').click();
    done('Placed seven devices from search results, including two instances of the same furnace.');
    stage = 'drag rotation';
    await selectNode(assembler);
    const original = (await documentData()).nodes[assembler];
    const a = await grid(24.5, 4.5), b = await grid(28.5, 4.5);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, {steps: 8}); await page.keyboard.press('r');
    assert.deepEqual((await documentData()).nodes[assembler], original);
    assert.equal(await page.evaluate(() => gesture.preview.direction), 1);
    await page.mouse.up();
    const moved = (await documentData()).nodes[assembler];
    assert.equal(moved.direction, 1); assert.deepEqual(moved.position, {x: 26, z: 3});
    await page.locator('#btnUndo').click(); assert.deepEqual((await documentData()).nodes[assembler], original);
    await page.locator('#btnRedo').click(); assert.deepEqual((await documentData()).nodes[assembler], moved);
    await page.locator('#btnFit').click();
    done('Dragging and R rotate the moving rectangle; one undo/redo restores position and orientation.');
    stage = 'items and annotations';
    await mark(warehouse, 'item_iron_nugget'); await mark(furnace, 'item_iron_nugget');
    await mark(furnace2, 'item_liquid_plant_grass_1'); await mark(tank, 'item_liquid_plant_grass_1');
    await mark(shaper, 'item_copper_nugget');
    await selectNode(furnace);
    await page.locator('#nodeItemStatus').selectOption('limited'); await page.locator('#nodeItemStatusColor').fill('#ff8844');
    await page.locator('#nodeItemStatusColor').dispatchEvent('change');
    await page.locator('#portVisibilityFields summary').click(); await page.locator('[data-port="input:0"]').uncheck();
    await selectNode(furnace2); await page.locator('#nodeEnvironment').selectOption('stable');
    done('Selected item icons, a limited-time color, a hidden unused port, and a blue environment banner through the inspector.');
    stage = 'connect lines and gates';
    await connect(warehouse, 'output:0', furnace, 'input:1', 'item');
    await connect(furnace, 'output:1', shaper, 'input:1', 'item');
    await connect(furnace, 'output:3', furnace2, 'input:3', 'fluid');
    await connect(furnace2, 'output:3', tank, 'input:0', 'fluid');
    const itemGate = await place('log_conditioner', 5, 6), pipeGate = await place('log_pipe_conditioner', 10, 10);
    await mark(itemGate, 'item_iron_nugget'); await mark(pipeGate, 'item_liquid_plant_grass_1');
    const connections = await page.evaluate(() => ({lines: data.conveyors.length,
      inside: data.conveyors.filter(c => C.buildingCells(data, buildings).has(C.key(c.x, c.z))).length}));
    assert(connections.lines >= 19); assert.equal(connections.inside, 0);
    await page.locator('#search').fill(''); await page.locator('#btnFit').click();
    await page.screenshot({path: path.join(out, 'editor.png')});
    done('Connected two belts and two pipes to device ports and marked both item/pipe admission gates.');
    stage = 'right-side details';
    await page.locator('#btnGamePreview').click();
    await page.locator('#presentationName').fill('全流程联调示例');
    await page.locator('#presentationTags').fill('制图，联调');
    await page.locator('#presentationDescription').fill('通过页面完成设备摆放、接口设置、物品标记、连线和导出。');
    await page.locator('#btnChooseCover').click(); await page.locator('#coverSearch').fill('item_iron_nugget');
    await page.locator('[data-cover="item_iron_nugget"]').click(); await page.locator('[data-cover-color="orange"]').click();
    await page.locator('#btnApplyPresentation').click();
    const saved = await documentData();
    const inventory = await page.evaluate(() => BlueprintPresentation.inventory(data).map(i => ({id: i.id, count: i.count})));
    assert.equal(inventory.find(i => i.id === 'item_port_furnance_1').count, 2);
    assert.equal(inventory.find(i => i.id === 'item_log_belt_01').count, 0);
    assert.equal(inventory.find(i => i.id === 'item_log_pipe_01').count, 0);
    assert.equal(saved.nodes.length, 9);
    done('Edited the preview title, tags, description and original cover; the automatic inventory counts both furnaces and lists both line types.');
    stage = 'download and round trip';
    const jsonPath = await download('#btnJson', 'layout.json');
    assert.deepEqual(JSON.parse(await fs.readFile(jsonPath, 'utf8')), saved);
    await page.locator('#btnGamePreview').click();
    await page.waitForFunction(() => document.getElementById('presentationCanvas').width === 1920);
    await download('#btnExportPresentation', 'preview.png');
    await page.screenshot({path: path.join(out, 'preview-editor.png')});
    await page.locator('#btnApplyPresentation').click();
    await page.locator('#btnClear').click(); assert.equal((await documentData()).nodes.length, 0);
    await page.locator('#fileIn').setInputFiles(jsonPath);
    await page.waitForFunction(() => data.nodes.length === 9); assert.deepEqual(await documentData(), saved);
    await page.locator('#btnGamePreview').click(); await download('#btnExportPresentation', 'preview-roundtrip.png');
    assert.deepEqual(await fs.readFile(path.join(out, 'preview.png')), await fs.readFile(path.join(out, 'preview-roundtrip.png')));
    await page.locator('#btnApplyPresentation').click();
    await page.locator('#transparent').check(); await download('#btnPng', 'canvas-transparent.png');
    await page.waitForFunction(() => document.getElementById('saveStatus').textContent.includes('已保存'));
    await page.reload(); await page.evaluate(() => BlueprintEditor.ready); assert.deepEqual(await documentData(), saved);
    assert.deepEqual(errors, []); assert.deepEqual(failures, []);
    const png = await fs.readFile(path.join(out, 'preview.png'));
    assert.equal(png.readUInt32BE(16), 2560); assert(png.readUInt32BE(20) >= 1440);
    done('Saved JSON, cleared and reimported it, downloaded an identical full PNG, exported transparent PNG, and restored the draft after reload.');
    const report = {url, completedAt: new Date().toISOString(), passed: steps.length, steps, nodes: saved.nodes.length, lineCells: connections.lines,
      inventory, preview: {width: png.readUInt32BE(16), height: png.readUInt32BE(20), sha256: createHash('sha256').update(png).digest('hex'), roundTripIdentical: true}, errors, networkFailures: failures};
    await fs.writeFile(path.join(out, 'verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({passed: steps.length, nodes: report.nodes, lineCells: report.lineCells, preview: report.preview}));
  } catch (error) {
    await page.screenshot({path: path.join(out, 'failure.png')}).catch(() => {});
    await fs.writeFile(path.join(out, 'failure.json'), JSON.stringify({stage, message: error.message, steps, errors, failures}, null, 2));
    throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
