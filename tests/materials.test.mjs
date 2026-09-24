import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { createChecks, report } from './harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
await build({
  root: ROOT,
  configFile: false,
  logLevel: 'warn',
  build: {
    outDir: 'reports/test-artifacts',
    emptyOutDir: false,
    minify: false,
    target: 'es2022',
    lib: {
      entry: path.join(ROOT, 'src/ui/materials.ts'),
      formats: ['es'],
      fileName: () => 'materials-bundle.mjs',
    },
  },
});
const { constructionMaterials, countLineCells, materialsText } = await import(
  pathToFileURL(path.join(ROOT, 'reports/test-artifacts/materials-bundle.mjs')).href
);
const checks = createChecks();
const data = () => ({ name: '材料测试', size: { x: 32, z: 32 }, nodes: [], conveyors: [] });
const node = (templateId, x = 0, z = 0, direction = 0) => ({ templateId, position: { x, z }, direction });
const building = (id, itemId = id, w = 1, d = 1) => ({ id, itemId, name: id, w, d });
const recipe = (ingredients, outputCount = 1) => ({ id: 'recipe', outputCount, ingredients });
const payload = (constructionRecipes = {}) => ({
  products: {},
  constructionRecipes,
  materialItems: { ore: { name: '矿石', badge: null } },
  lineItems: { item: { id: 'belt', name: '传送带' }, fluid: { id: 'pipe', name: '管道' } },
});
const quantities = summary => Object.fromEntries(summary.materials.map(item => [item.id, item.count]));

checks.check('device aliases aggregate before batch rounding and shared ingredients accumulate', () => {
  const layout = data();
  layout.nodes = [node('a'), node('alias', 2), node('b', 3)];
  const before = JSON.stringify(layout);
  const buildings = { a: building('a', 'device'), alias: building('alias', 'device'), b: building('b') };
  const summary = constructionMaterials(
    layout,
    buildings,
    payload({
      device: recipe([{ id: 'ore', count: 5 }], 2),
      b: recipe([
        { id: 'ore', count: 3 },
        { id: 'glass', count: 7 },
      ]),
    }),
  );
  assert.deepEqual(quantities(summary), { ore: 8, glass: 7 });
  assert.equal(summary.materials[0].name, '矿石');
  assert.deepEqual(summary.missing, []);
  assert.equal(JSON.stringify(layout), before);
});

checks.check('line demand counts cells, deduplicates same-kind overlaps and excludes rotated devices', () => {
  const layout = data();
  const buildings = { a: building('a', 'a', 2, 1) };
  layout.nodes = [node('a', 0, 0, 1)];
  layout.conveyors = [
    { kind: 'item', x: 0, z: 0, dir: 0 },
    { kind: 'fluid', x: 0, z: 1, dir: 0 },
    { kind: 'item', x: 1, z: 0, dir: 0 },
    { kind: 'item', x: 1, z: 0, dir: 1 },
    { kind: 'fluid', x: 1, z: 0, dir: 1 },
    { kind: 'item', x: 2, z: 0, dir: 0 },
  ];
  assert.deepEqual(countLineCells(layout, buildings), { item: 2, fluid: 1 });
  const summary = constructionMaterials(
    layout,
    buildings,
    payload({
      a: recipe([]),
      belt: recipe([{ id: 'ore', count: 2 }]),
      pipe: recipe([{ id: 'ore', count: 3 }]),
    }),
  );
  assert.deepEqual(quantities(summary), { ore: 7 });
});

checks.check('unknown and ambiguous recipes remain visible with device and cell quantities', () => {
  const layout = data();
  layout.nodes = [node('a'), node('b', 2)];
  layout.conveyors = [{ kind: 'item', x: 4, z: 4, dir: 0 }];
  const buildings = { a: building('a'), b: building('b') };
  const info = payload({ b: null });
  const summary = constructionMaterials(layout, buildings, info);
  assert.deepEqual(summary.materials, []);
  assert.deepEqual(
    summary.missing.map(item => [item.id, item.count, item.unit, item.reason]),
    [
      ['a', 1, '个', '未提供材料配方'],
      ['b', 1, '个', '存在多个配方'],
      ['belt', 1, '格', '未提供材料配方'],
    ],
  );
  const text = materialsText(layout, buildings, info);
  assert.match(text, /以下项目未计入材料合计/);
  assert.match(text, /传送带 × 1 格（未提供材料配方）/);
  assert.match(text, /未扣除已有库存/);
});

checks.check('invalid recipes never produce partial totals or infinity', () => {
  const layout = data();
  layout.nodes = [node('a'), node('b', 2)];
  const summary = constructionMaterials(
    layout,
    { a: building('a'), b: building('b') },
    payload({
      a: recipe([{ id: 'ore', count: 5 }], 0),
      b: recipe([
        { id: 'ore', count: 5 },
        { id: 'glass', count: -1 },
      ]),
    }),
  );
  assert.deepEqual(summary.materials, []);
  assert.equal(summary.missing.length, 2);
  assert.ok(summary.missing.every(item => item.reason === '材料配方数据不完整'));
});

checks.check('real furnace, grinder, planter and soil recipes produce their direct manufacturing costs', () => {
  const load = name => JSON.parse(readFileSync(path.join(ROOT, `data/tables/${name}.json`), 'utf8'));
  const recipes = {};
  for (const row of Object.values({ ...load('FactoryHubCraftTable'), ...load('FactoryManualCraftTable') })) {
    assert.equal(row.outcomes.length, 1);
    assert.ok(!recipes[row.outcomes[0].id], 'source recipes must be unambiguous');
    recipes[row.outcomes[0].id] = recipe(row.ingredients, row.outcomes[0].count);
  }
  const reverse = load('FactoryBuildingItemReverseTable');
  const ids = ['furnance_1', 'grinder_1', 'planter_1', 'soil_moss_1'];
  const buildings = Object.fromEntries(ids.map(id => [id, building(id, reverse[id].itemId)]));
  const layout = data();
  layout.nodes = [...ids, 'furnance_1'].map((id, index) => node(id, index * 3));
  const summary = constructionMaterials(layout, buildings, payload(recipes));
  assert.deepEqual(quantities(summary), {
    item_glass_cmpt: 20,
    item_carbon_mtl: 11,
    item_originium_ore: 10,
    item_crystal_shell: 5,
    item_plant_moss_seed_1: 1,
  });
  assert.deepEqual(summary.missing, []);
});

checks.check('missing material metadata retains its ID and direct equipment ingredient', () => {
  const layout = data();
  layout.nodes = [node('upgraded')];
  const summary = constructionMaterials(
    layout,
    { upgraded: building('upgraded') },
    payload({
      upgraded: recipe([{ id: 'base_device', count: 1 }]),
      base_device: recipe([{ id: 'ore', count: 20 }]),
    }),
  );
  assert.deepEqual(quantities(summary), { base_device: 1 });
  assert.equal(summary.materials[0].name, 'base_device');
});

checks.check('empty layout produces an empty list without missing-data warnings', () => {
  const summary = constructionMaterials(data(), {}, payload());
  assert.deepEqual(summary, { materials: [], missing: [], lineCells: { item: 0, fluid: 0 } });
  assert.doesNotMatch(materialsText(data(), {}, payload()), /未计入/);
});

report('materials', checks);
