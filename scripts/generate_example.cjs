const {chromium} = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const root = path.resolve(__dirname, '..');
(async () => {
  await fs.mkdir(path.join(root, "reports/test-artifacts"), {recursive: true});
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1680, height: 1050}});
    await page.goto(pathToFileURL(path.join(root, 'dist/blueprint_editor.html')).href);
    await page.evaluate(() => BlueprintEditor.ready);
    const result = await page.evaluate(async () => {
      const layout = {schemaVersion: 2, name: '环境与接口标记示例', size: {x: 40, z: 20}, nodes: [], conveyors: [],
        presentation: {creatorId: '', tags: [], coverId: 'item_liquid_xiranite', coverColor: 'orange', viewport: {zoom: 1.32, x: .2, y: .45}}};
      function add(id, x, z, direction = 0, productIcon, extra = {}) {
        layout.nodes.push({templateId: id, position: {x, z}, direction, ...(productIcon ? {productIcon} : {}), ...extra});
        return layout.nodes.length - 1;
      }
      const reactor = add('mix_pool_1', 5, 2, 2, 'item_liquid_plant_grass_1');
      const gas1 = add('gas_reactor_1', 12, 3, 3, 'item_liquid_xiranite');
      const oven1 = add('xiranite_oven_1', 20, 2, 0, 'item_xiranite_powder', {environmentEffect: 'stable', closedPorts: ['input:0', 'input:1', 'input:2', 'input:3', 'input:4']});
      const gas2 = add('gas_reactor_1', 5, 9, 0, 'item_xiranite_powder');
      const gas3 = add('gas_reactor_1', 12, 10, 3, 'item_liquid_xiranite');
      const oven2 = add('xiranite_oven_1', 19, 9, 0, 'item_xiranite_powder', {environmentEffect: 'stable', closedPorts: ['input:0', 'input:1', 'input:2', 'input:3', 'input:4']});
      add('vaporizer_1', 17, 6, 0, '[gas]stable');
      add('power_station_1', 1, 0); add('power_diffuser_1', 6, 0); add('power_diffuser_1', 2, 6); add('power_diffuser_1', 25, 8);
      add('furnance_1', 28, 3, 0, 'item_iron_nugget'); add('shaper_1', 28, 10, 1, 'item_copper_nugget');
      add('grinder_1', 34, 3, 0, 'item_plant_grass_powder_1');
      for (const [i, x] of [0, 5, 10, 15, 20, 25, 30, 35].entries()) add(i < 4 ? 'unloader_1' : 'loader_1', x, 17, 0, i % 2 ? 'item_liquid_xiranite' : 'item_liquid_plant_grass_1');
      function route(a, b, kind) {
        layout.conveyors = C.mergeRoutes(layout.conveyors, C.connectedRoute(layout, buildings, a, b, kind).path);
      }
      function endpoint(index, id) {
        const p = C.worldPorts(layout.nodes[index], buildings).find(p => p.id === id);
        return {x: p.outX, z: p.outZ, gx: p.edgeX, gz: p.edgeZ};
      }
      route(endpoint(gas1, 'output:0'), endpoint(reactor, 'input:2'), 'fluid');
      route(endpoint(gas3, 'output:0'), endpoint(oven2, 'input:5'), 'fluid');
      route(endpoint(gas2, 'output:0'), endpoint(oven1, 'input:5'), 'fluid');
      route({x: 6, z: 16}, endpoint(reactor, 'input:0'), 'item');
      route(endpoint(oven1, 'output:2'), {x: 26, z: 16}, 'item');
      route(endpoint(oven2, 'output:1'), {x: 20, z: 16}, 'item');
      route({x: 11, z: 16}, {x: 11, z: 1}, 'item');
      route({x: 39, z: 1}, {x: 39, z: 16}, 'fluid');
      for (const [id, x, z, icon] of [['log_pipe_conditioner', 11, 15, 'item_liquid_xiranite'], ['log_conditioner', 11, 8, 'item_iron_nugget'], ['log_pipe_converger', 26, 15], ['log_splitter', 26, 8]]) {
        if (buildings[id] && C.hit(layout.nodes, buildings, x, z) < 0) add(id, x, z, 0, icon);
      }
      C.validate(layout, buildings); BlueprintEditor.importLayout(layout);
      const crop = await BlueprintEditor.exportPreview(layout);
      const full = await BlueprintEditor.exportPreview({...layout, presentation: {...layout.presentation, viewport: {zoom: 1, x: .5, y: .5}}});
      return {layout, crop: crop.toDataURL().split(',')[1], full: full.toDataURL().split(',')[1]};
    });
    for (const name of ['crop', 'full']) await fs.writeFile(path.join(root, `reports/test-artifacts/display_example_${name}.png`), Buffer.from(result[name], 'base64'));
    await fs.writeFile(path.join(root, 'examples/environment_ports.json'), JSON.stringify(result.layout, null, 2));
    await page.locator('#btnGamePreview').click();
    await page.waitForFunction(() => document.getElementById('presentationCanvas').width === 1920);
    await page.screenshot({path: path.join(root, 'reports/test-artifacts/display_example_editor.png')});
    console.log('Created environment / port display example.');
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
