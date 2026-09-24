/** Selection and merge regressions run against the real core and Editor without a browser bake. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'reports/test-artifacts/selection');
await build({
  root: ROOT,
  configFile: false,
  logLevel: 'warn',
  build: {
    outDir: OUT,
    emptyOutDir: true,
    minify: false,
    target: 'es2022',
    lib: {
      entry: {
        selection: path.join(ROOT, 'src/core/selection.ts'),
        editor: path.join(ROOT, 'src/ui/editor.ts'),
      },
      formats: ['es'],
      fileName: (_, entry) => `${entry}.mjs`,
    },
  },
});
const C = await import(pathToFileURL(path.join(OUT, 'selection.mjs')).href);
const { Editor } = await import(pathToFileURL(path.join(OUT, 'editor.mjs')).href);
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

const buildings = {
  device: { id: 'device', name: '测试设备', w: 2, d: 3, ports: [] },
  unit: { id: 'unit', name: '测试单格设备', w: 1, d: 1, ports: [] },
  udpipe_loader_1: { id: 'udpipe_loader_1', name: '暗管入口', w: 1, d: 1, ports: [], underground: true },
  udpipe_unloader_1: { id: 'udpipe_unloader_1', name: '暗管出口', w: 1, d: 1, ports: [], underground: true },
};
const node = (x, z, templateId = 'device', direction = 0) => ({ templateId, position: { x, z }, direction });
const line = (x, z, kind = 'item') => ({ x, z, kind, dir: 0, fromDir: 3 });
const layout = (nodes = [], conveyors = []) => ({
  schemaVersion: 2,
  name: '测试布局',
  size: { x: 50, z: 50 },
  nodes,
  conveyors,
});
const paired = () =>
  layout(
    [
      { ...node(5, 5, 'udpipe_loader_1'), undergroundPair: 'pipe-1' },
      { ...node(9, 5, 'udpipe_unloader_1'), undergroundPair: 'pipe-1' },
    ],
    [line(6, 5)],
  );

check('reverse drags and full-footprint selection include both line layers', () => {
  const source = layout([node(3, 3), node(8, 3, 'device', 1)], [line(5, 3), line(5, 3, 'fluid'), line(11, 3)]);
  const area = C.selectionBounds({ x: 10, z: 5 }, { x: 3, z: 3 });
  assert.deepEqual(C.selectRegion(source, buildings, area), { nodeIndices: [0, 1], conveyorIndices: [0, 1] });
  assert.deepEqual(C.selectRegion(source, buildings, { ...area, z1: 4 }), {
    nodeIndices: [],
    conveyorIndices: [0, 1],
  });
});

check('copy trims empty margins and preserves node and line properties without mutation', () => {
  const source = layout(
    [{ ...node(9, 7), productIcon: '[gas]Acid', custom: { value: 4 }, itemStatus: 'limited' }],
    [line(8, 8)],
  );
  const before = structuredClone(source);
  const fragment = C.copyFragment(source, buildings);
  assert.deepEqual(fragment.size, { x: 3, z: 3 });
  assert.deepEqual(fragment.nodes[0].position, { x: 1, z: 0 });
  assert.deepEqual(fragment.nodes[0].custom, { value: 4 });
  assert.equal(fragment.nodes[0].productIcon, '[gas]Acid');
  assert.equal(fragment.conveyors[0].fromDir, 3);
  fragment.nodes[0].custom.value = 9;
  assert.deepEqual(source, before);
});

check('line-only selections are reusable and empty selections report an error', () => {
  const source = layout([], [line(7, 9), line(8, 9)]);
  const fragment = C.copyFragment(source, buildings, { nodeIndices: [], conveyorIndices: [0, 1] });
  assert.deepEqual(fragment.size, { x: 2, z: 1 });
  const merged = C.mergeFragment(layout(), fragment, { x: 2, z: 3 }, buildings);
  assert.deepEqual(
    merged.conveyors.map(belt => [belt.x, belt.z]),
    [
      [2, 3],
      [3, 3],
    ],
  );
  assert.throws(() => C.copyFragment(source, buildings, { nodeIndices: [], conveyorIndices: [] }), /没有/);
});

check('copying one underground endpoint clears only the copied pairing', () => {
  const source = paired();
  const fragment = C.copyFragment(source, buildings, { nodeIndices: [0], conveyorIndices: [] });
  assert.equal(fragment.nodes[0].undergroundPair, undefined);
  assert.equal(source.nodes[0].undergroundPair, 'pipe-1');
  assert.equal(source.nodes[1].undergroundPair, 'pipe-1');
});

check('each repeated paste creates independent underground pairs', () => {
  const source = paired();
  const before = structuredClone(source);
  const fragment = C.copyFragment(source, buildings);
  const once = C.mergeFragment(source, fragment, { x: 15, z: 15 }, buildings);
  const twice = C.mergeFragment(once, fragment, { x: 25, z: 25 }, buildings);
  assert.deepEqual(
    twice.nodes.map(n => n.undergroundPair),
    ['pipe-1', 'pipe-1', 'pipe-2', 'pipe-2', 'pipe-3', 'pipe-3'],
  );
  assert.deepEqual(source, before);
  assert.equal(fragment.nodes[0].undergroundPair, 'pipe-1');
});

check('multiple imported pair IDs cannot collide with destination pair IDs', () => {
  const source = paired();
  source.nodes.push(
    { ...node(12, 5, 'udpipe_loader_1'), undergroundPair: 'pipe-2' },
    { ...node(14, 5, 'udpipe_unloader_1'), undergroundPair: 'pipe-2' },
  );
  const fragment = C.copyFragment(source, buildings);
  const merged = C.mergeFragment(paired(), fragment, { x: 5, z: 15 }, buildings);
  assert.deepEqual(
    merged.nodes.slice(2).map(n => n.undergroundPair),
    ['pipe-2', 'pipe-2', 'pipe-3', 'pipe-3'],
  );
});

check('rotation preserves non-square devices, route headings and four-turn identity', () => {
  const fragment = C.copyFragment(layout([node(4, 4)], [line(7, 5)]), buildings);
  const rotated = C.rotateFragment(fragment, buildings);
  assert.deepEqual(rotated.size, { x: 3, z: 4 });
  assert.deepEqual(rotated.nodes[0].position, { x: 0, z: 0 });
  assert.equal(rotated.nodes[0].direction, 1);
  assert.deepEqual(rotated.conveyors[0], { x: 1, z: 3, kind: 'item', dir: 1, fromDir: 0 });
  let cycle = fragment;
  for (let i = 0; i < 4; i++) cycle = C.rotateFragment(cycle, buildings);
  assert.deepEqual(cycle, fragment);
});

check('device collisions, duplicate lines and out-of-bounds pastes fail atomically', () => {
  const source = layout([node(4, 4)], [line(9, 9)]);
  const before = structuredClone(source);
  const fragment = C.copyFragment(source, buildings);
  assert.throws(() => C.mergeFragment(source, fragment, { x: 4, z: 4 }, buildings), /重叠/);
  assert.throws(() => C.mergeFragment(source, fragment, { x: 49, z: 49 }, buildings), /边界/);
  const lines = C.copyFragment(layout([], [line(0, 0)]), buildings);
  assert.throws(() => C.mergeFragment(source, lines, { x: 9, z: 9 }, buildings), /重复/);
  assert.throws(() => C.mergeFragment(source, lines, { x: -1, z: 0 }, buildings), /越界/);
  assert.deepEqual(source, before);
});

check('merging respects the existing blueprint device limit', () => {
  const full = layout(Array.from({ length: 160 }, (_, i) => node(i % 40, Math.floor(i / 40), 'unit')));
  const fragment = C.copyFragment(layout([node(0, 0, 'unit')]), buildings);
  assert.throws(() => C.mergeFragment(full, fragment, { x: 0, z: 10 }, buildings), /160/);
  assert.equal(full.nodes.length, 160);
});

const previousStorage = globalThis.localStorage;
const previousFrame = globalThis.requestAnimationFrame;
globalThis.localStorage = { getItem: () => null };
globalThis.requestAnimationFrame = () => 1;
function editorWith(source) {
  const editor = new Editor({
    payload: { buildings: Object.values(buildings), products: {}, sprites: {}, spriteBorders: {}, statusLayers: {} },
    assets: {},
    onRevision: () => {},
    status: { setStatus: () => {}, setSaveStatus: () => {} },
  });
  editor.data = structuredClone(source);
  editor.scheduleSave = () => {};
  return editor;
}

check('import-to-merge and Escape cancellation do not change the document or history', () => {
  const original = layout([node(2, 2)]);
  original.presentation = { description: '保留原蓝图详情' };
  const editor = editorWith(original);
  editor.mergeLayout(paired());
  assert.deepEqual(editor.data, original);
  assert.equal(editor.history.past.length, 0);
  assert.equal(editor.pasting, true);
  assert.deepEqual(editor.clipboard.size, { x: 5, z: 1 });
  editor.cancelPaste();
  assert.equal(editor.pasteAt({ x: 20, z: 20 }), false);
  assert.equal(editor.history.past.length, 0);
  assert.deepEqual(editor.data, original);
});

check('repeated editor pastes each undo and redo as one complete transaction', () => {
  const original = paired();
  const editor = editorWith(original);
  editor.selectRegion({ x0: 5, z0: 5, x1: 10, z1: 6 });
  assert.equal(editor.copySelection(), true);
  assert.equal(editor.beginPaste(), true);
  assert.equal(editor.pasteAt({ x: 15, z: 15 }), true);
  const once = structuredClone(editor.data);
  assert.equal(editor.pasteAt({ x: 25, z: 25 }), true);
  const twice = structuredClone(editor.data);
  assert.equal(editor.pasting, true);
  assert.equal(editor.history.past.length, 2);
  assert.equal(editor.pasteAt({ x: 25, z: 25 }), false);
  assert.deepEqual(editor.data, twice);
  assert.equal(editor.history.past.length, 2);
  editor.undo();
  assert.deepEqual(editor.data, once);
  editor.undo();
  assert.deepEqual(editor.data, original);
  editor.redo();
  assert.deepEqual(editor.data, once);
  editor.redo();
  assert.deepEqual(editor.data, twice);
});

check('single-device copy and incomplete-pair region deletion preserve the other endpoint', () => {
  const editor = editorWith(paired());
  editor.selected = 0;
  assert.equal(editor.copySelection(), true);
  assert.equal(editor.clipboard.nodes[0].undergroundPair, undefined);
  editor.selectRegion({ x0: 5, z0: 5, x1: 7, z1: 6 });
  editor.deleteSelected();
  assert.equal(editor.data.nodes.length, 1);
  assert.equal(editor.data.nodes[0].undergroundPair, undefined);
  assert.equal(editor.data.conveyors.length, 0);
  assert.equal(editor.history.past.length, 1);
  editor.undo();
  assert.deepEqual(editor.data, paired());
});

/** Record sprite choices while exercising the actual Editor.draw / paintScene path. */
function previewMatchesPlacement(source, copied, point) {
  const editor = editorWith(source);
  editor.buildings.device.faces = ['device-body', 'device-body', 'device-body', 'device-body'];
  editor.assets = { get: key => (key ? { key, width: 128, height: 128 } : null) };
  for (const key of ['icon_belt_grid', 'icon_belt_corner_1', 'icon_belt_corner_2']) {
    editor.payload.sprites[key] = key;
  }
  editor.showGrid = false;
  editor.showHints = false;
  const calls = [];
  editor.ctx = new Proxy(
    { drawImage: (image, ...coordinates) => calls.push([image.key, ...coordinates]) },
    { get: (target, property) => target[property] ?? (() => {}) },
  );
  editor.canvas = { width: 1000, height: 1000 };
  editor.clipboard = C.copyFragment(copied, buildings);
  editor.beginPaste();
  editor.hover = { ...point, gx: point.x, gz: point.z };
  const before = structuredClone(editor.data);
  editor.draw();
  const preview = structuredClone(calls);
  assert.deepEqual(editor.data, before, 'preview must not modify the destination');
  assert.equal(editor.pasteAt(point), true);
  editor.cancelPaste();
  calls.length = 0;
  editor.draw();
  assert.deepEqual(preview, calls, 'preview sprites must match the committed scene without duplicate drawing');
  return preview;
}

const previousPixelRatio = globalThis.devicePixelRatio;
globalThis.devicePixelRatio = 1;
check('paste preview hides imported conveyors behind destination devices just like the committed scene', () => {
  const draws = previewMatchesPlacement(layout([node(3, 3)]), layout([], [line(0, 0)]), { x: 3, z: 3 });
  assert.deepEqual(
    draws.map(([sprite]) => sprite),
    ['device-body'],
  );
});

check('paste preview updates existing conveyor corners using the combined route topology', () => {
  const source = layout([], [{ x: 5, z: 5, kind: 'item', dir: 0 }]);
  const copied = layout([], [{ x: 0, z: 0, kind: 'item', dir: 1 }]);
  const draws = previewMatchesPlacement(source, copied, { x: 5, z: 4 });
  assert.equal(draws.length, 2);
  assert.ok(draws.some(([sprite]) => sprite.startsWith('icon_belt_corner_')));
});
globalThis.devicePixelRatio = previousPixelRatio;

globalThis.localStorage = previousStorage;
globalThis.requestAnimationFrame = previousFrame;
console.log(
  JSON.stringify({ suite: 'selection-merge', passed: passed.length, failed: failed.length, failures: failed }),
);
if (failed.length) {
  for (const failure of failed) console.error(failure);
  process.exitCode = 1;
}
