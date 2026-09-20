/**
 * Pure layout logic regression suite.
 *
 * Exercises the same behaviours the previous `editor_core.test.cjs` asserted — rotated footprints,
 * overlap rejection, non-mutating import, routing, pairing and history — against the real TypeScript
 * sources, bundled by `scripts/build_core_bundle.mjs`.
 *
 * The core is deliberately free of DOM and React dependencies, so this runs in plain Node with no
 * browser and no Pyodide: the expensive browser coverage lives in `editor.test.mjs`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCoreBundle } from '../scripts/build_core_bundle.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

function loadFixtures() {
  const table = JSON.parse(readFileSync(path.join(ROOT, 'data/tables/FactoryBuildingTable.json'), 'utf8'));
  const index = JSON.parse(readFileSync(path.join(ROOT, 'assets/blueprint_source/index.json'), 'utf8'));
  const buildings = {};
  for (const [id, entry] of Object.entries(table)) buildings[id] = { w: entry.range.width, d: entry.range.depth };
  for (const key of Object.keys(index)) {
    if (key.startsWith('blueprint/bg_logistic_'))
      buildings[key.slice('blueprint/bg_logistic_'.length)] = { w: 1, d: 1 };
  }
  return buildings;
}

const bundle = await buildCoreBundle();
const C = await import(pathToFileURL(bundle).href);
const buildings = loadFixtures();

const passed = [];
const failed = [];

function check(name, run) {
  try {
    run();
    passed.push(name);
  } catch (error) {
    failed.push(`${name}: ${error.message}`);
  }
}

const layout = () => ({ name: 'fixture', size: { x: 32, z: 28 }, nodes: [], conveyors: [] });
const node = (x = 12, z = 9, direction = 1) => ({ templateId: 'udpipe_loader_2', position: { x, z }, direction });

check('rotated rectangular export bounds use 5 by 3 cells', () => {
  const d = layout();
  d.nodes.push(node());
  assert.deepEqual(C.bounds(d, buildings, 0), { x0: 12, z0: 9, x1: 17, z1: 12 });
});

check('out-of-bounds rotation is rejected', () => {
  const d = layout();
  d.nodes.push(node(28, 10, 0));
  C.validate(d, buildings);
  d.nodes[0].direction = 1;
  assert.throws(() => C.validate(d, buildings), /边界/);
});

check('overlap rejected, touching footprints accepted', () => {
  const d = layout();
  d.nodes.push(node(3, 3, 0), node(6, 3, 0));
  C.validate(d, buildings);
  d.nodes[1].position.x = 5;
  assert.throws(() => C.validate(d, buildings), /重叠/);
});

check('import is non-mutating and preserves gas IDs and extra fields', () => {
  const d = layout();
  d.nodes.push({ ...node(), productIcon: '[gas]Acid', custom: { source: 7 } });
  d.custom = { nested: true };
  const before = JSON.stringify(d);
  const result = C.validate(d, buildings);
  assert.equal(JSON.stringify(d), before);
  assert.equal(result.nodes[0].productIcon, '[gas]Acid');
  assert.deepEqual(result.nodes[0].custom, { source: 7 });
  assert.deepEqual(result.custom, { nested: true });
});

check('unknown device id and bad coordinates are rejected', () => {
  const d = layout();
  d.nodes.push({ templateId: 'nope', position: { x: 0, z: 0 }, direction: 0 });
  assert.throws(() => C.validate(d, buildings), /ID 未知/);
  const e = layout();
  e.nodes.push({ templateId: 'udpipe_loader_2', position: { x: 0.5, z: 0 }, direction: 0 });
  assert.throws(() => C.validate(e, buildings), /坐标必须是整数/);
});

check('route produces one cell per grid step', () => {
  const route = C.route({ x: 9, z: 3 }, { x: 9, z: 7 }, 'item', false, 0);
  assert.equal(route.length, 5);
  assert.equal(C.conveyorSprites(route).length, 5);
  // A single cell keeps the requested direction rather than inventing a heading.
  const single = C.route({ x: 2, z: 2 }, { x: 2, z: 2 }, 'fluid', false, 3);
  assert.equal(single[0].dir, 3);
});

check('corner sprites are chosen from the incoming and outgoing directions', () => {
  const belts = [
    { x: 0, z: 0, kind: 'item', dir: 1 },
    { x: 0, z: 1, kind: 'item', dir: 0 },
  ];
  const sprites = C.conveyorSprites(belts);
  assert.equal(sprites[0].sprite, 'icon_belt_grid');
  assert.match(sprites[1].sprite, /icon_belt_corner_|icon_belt_grid/);
});

check('mergeRoutes replaces covered cells and keeps the incoming direction', () => {
  // A straight-through cell (`fromDir` equals `dir`) must keep its entry heading when redrawn.
  const existing = [{ x: 1, z: 1, kind: 'item', dir: 1, fromDir: 1 }];
  const merged = C.mergeRoutes(existing, [{ x: 1, z: 1, kind: 'item', dir: 1 }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].fromDir, 1);
  // A cell that is not covered by the addition survives.
  const kept = C.mergeRoutes([{ x: 9, z: 9, kind: 'item', dir: 0 }], [{ x: 1, z: 1, kind: 'item', dir: 0 }]);
  assert.equal(kept.length, 2);
});

check('history ignores no-op commits and round-trips changes', () => {
  const history = new C.History();
  const first = layout();
  const second = layout();
  second.name = 'changed';
  assert.equal(history.commit(first, first), false);
  assert.equal(history.commit(first, second), true);
  assert.equal(history.undo(second).name, 'fixture');
  assert.equal(history.redo(first).name, 'changed');
});

check('history is bounded by its limit', () => {
  const history = new C.History(2);
  for (let i = 0; i < 5; i++) history.commit({ n: i }, { n: i + 1 });
  assert.equal(history.past.length, 2);
});

check('connectedRoute snaps a port endpoint and returns a path', () => {
  // `furnance_1` is the smallest device with both a fluid input and a fluid output. Ports are taken
  // from the real table plus the same edge/along transform the baker applies, so the snap targets are
  // the coordinates the canvas would actually snap to.
  const port = (n, input, x, z) => ({
    n,
    input,
    pipe: true,
    x,
    z,
    dir: 0,
    edge: 0,
    along: x,
    inset: 0.1,
    id: `${input ? 'input' : 'output'}:${n}`,
  });
  const index = {
    furnance_1: {
      id: 'furnance_1',
      w: 3,
      d: 3,
      logistic: false,
      ports: [port(3, true, 0, 1), port(3, false, 2, 1)],
    },
  };
  const d = layout();
  d.nodes.push(
    { templateId: 'furnance_1', position: { x: 3, z: 3 }, direction: 0 },
    { templateId: 'furnance_1', position: { x: 3, z: 8 }, direction: 0 },
  );

  // The source end is dragged from inside the first device; the sink lands on the free cell just
  // outside the second device's fluid input at (1, 9).
  const result = C.connectedRoute(
    d,
    index,
    { x: 4, z: 4, gx: 4.5, gz: 4.5 },
    { x: 1, z: 9, gx: 1.5, gz: 9.5 },
    'fluid',
    false,
    0,
  );
  assert.ok(Array.isArray(result.path));
  assert.ok(result.path.length > 0);
});

check('worldPorts rotate with the device and honour hidden ports', () => {
  const building = {
    id: 'furnance_1',
    w: 3,
    d: 3,
    ports: [{ n: 0, input: false, pipe: true, x: 2, z: 1, dir: 0, edge: 0, along: 1, inset: 0.1, id: 'output:0' }],
  };
  const index = { furnance_1: building };
  const base = C.worldPorts({ templateId: 'furnance_1', position: { x: 0, z: 0 }, direction: 0 }, index);
  assert.equal(base.length, 1);
  assert.equal(base[0].dir, 0);
  const hidden = C.worldPorts(
    { templateId: 'furnance_1', position: { x: 0, z: 0 }, direction: 0, closedPorts: ['output:0'] },
    index,
  );
  assert.equal(hidden.length, 0);
  const piped = C.worldPorts(
    { templateId: 'furnance_1', position: { x: 0, z: 0 }, direction: 0, formulaMode: 'normal' },
    index,
  );
  assert.equal(piped.length, 0);
});

check('connectedRoute refuses to route out of bounds', () => {
  const d = layout();
  d.nodes.push(node(0, 0, 0));
  assert.throws(
    () =>
      C.connectedRoute(
        d,
        buildings,
        { x: 0.5, z: 0.5, gx: 0.5, gz: 0.5 },
        { x: 0.5, z: 0.5, gx: 0.5, gz: 0.5 },
        'item',
      ),
    /接口|路径|掉头/,
  );
});

check('underground pairing requires one loader and one unloader', () => {
  const nodes = [
    { templateId: 'udpipe_loader_1', position: { x: 0, z: 0 }, direction: 0 },
    { templateId: 'udpipe_unloader_1', position: { x: 0, z: 2 }, direction: 0 },
  ];
  assert.equal(C.undergroundRole(nodes[0]), 'in');
  assert.equal(C.undergroundRole(nodes[1]), 'out');
  C.pairUnderground(nodes, 0, 1);
  assert.equal(nodes[0].undergroundPair, nodes[1].undergroundPair);
  assert.equal(C.undergroundPeer(nodes, nodes[0]), nodes[1]);
  C.unpair(nodes, nodes[0]);
  assert.equal(nodes[0].undergroundPair, undefined);
  assert.equal(nodes[1].undergroundPair, undefined);
});

check('pairing two loaders is rejected', () => {
  const nodes = [
    { templateId: 'udpipe_loader_1', position: { x: 0, z: 0 }, direction: 0 },
    { templateId: 'udpipe_loader_2', position: { x: 0, z: 2 }, direction: 0 },
  ];
  assert.throws(() => C.pairUnderground(nodes, 0, 1), /入口和一个出口/);
});

check('validate rejects a dangling or doubled underground pair', () => {
  const d = layout();
  d.nodes.push({ ...node(3, 3, 0), undergroundPair: 'pipe-1' });
  assert.throws(() => C.validate(d, buildings), /恰好包含一个入口和一个出口/);
});

check('duplicate conveyor on one cell is rejected', () => {
  const d = layout();
  d.conveyors = [
    { x: 2, z: 2, kind: 'item', dir: 0 },
    { x: 2, z: 2, kind: 'item', dir: 1 },
  ];
  assert.throws(() => C.validate(d, buildings), /重复/);
});

check('an item and a fluid line may share a cell', () => {
  const d = layout();
  d.conveyors = [
    { x: 2, z: 2, kind: 'item', dir: 0 },
    { x: 2, z: 2, kind: 'fluid', dir: 1 },
  ];
  C.validate(d, buildings);
});

check('a single-cell line may not double back on itself', () => {
  const d = layout();
  d.conveyors = [{ x: 2, z: 2, kind: 'item', dir: 0, fromDir: 2 }];
  assert.throws(() => C.validate(d, buildings), /不能原地掉头/);
});

check('size limits are enforced', () => {
  const d = layout();
  d.size = { x: 51, z: 10 };
  assert.throws(() => C.validate(d, buildings), /1–50/);
  const e = layout();
  e.size = { x: 0, z: 10 };
  assert.throws(() => C.validate(e, buildings), /1–50/);
});

check('device count limit is enforced', () => {
  const d = layout();
  d.nodes = Array.from({ length: C.MAX_NODES + 1 }, (_, i) => ({
    templateId: 'udpipe_loader_1',
    position: { x: i % 32, z: Math.floor(i / 32) },
    direction: 0,
  }));
  assert.throws(() => C.validate(d, buildings), /160/);
});

check('presentation fields are validated', () => {
  const bad = layout();
  bad.presentation = { tags: ['1', '2', '3', '4', '5', '6', '7'] };
  assert.throws(() => C.validate(bad, buildings), /6 个标签/);

  const viewport = layout();
  viewport.presentation = { viewport: { zoom: 9, x: 0.5, y: 0.5 } };
  assert.throws(() => C.validate(viewport, buildings), /取景/);

  const colour = layout();
  colour.presentation = { coverColor: 'pink' };
  assert.throws(() => C.validate(colour, buildings), /封面底色/);
});

check('an unsupported schema version is refused', () => {
  const d = layout();
  d.schemaVersion = 1;
  assert.throws(() => C.validate(d, buildings), /版本/);
});

check('closedPorts must reference real ports', () => {
  const d = layout();
  d.nodes.push({ templateId: 'furnance_1', position: { x: 3, z: 3 }, direction: 0, closedPorts: ['nope'] });
  assert.throws(() => C.validate(d, buildings), /接口显示标记无效/);
});

console.log(JSON.stringify({ suite: 'core-logic', passed: passed.length, failed: failed.length, failures: failed }));
if (failed.length) {
  for (const failure of failed) console.error(failure);
  process.exitCode = 1;
}
