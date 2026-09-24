/** PNG dimensions and content fitting, without the expensive sprite bake. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { createChecks, report } from './harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
await build({
  root: ROOT,
  logLevel: 'warn',
  configFile: false,
  build: {
    outDir: 'reports/test-artifacts',
    emptyOutDir: false,
    minify: false,
    target: 'es2022',
    lib: {
      entry: {
        canvasExport: path.join(ROOT, 'src/ui/canvasExport.ts'),
        presentationPaint: path.join(ROOT, 'src/ui/presentationPaint.ts'),
      },
      formats: ['es'],
      fileName: (_format, entry) => `${entry}-test.mjs`,
    },
  },
});
const C = await import(pathToFileURL(path.join(ROOT, 'reports/test-artifacts/canvasExport-test.mjs')).href);
const P = await import(pathToFileURL(path.join(ROOT, 'reports/test-artifacts/presentationPaint-test.mjs')).href);
const checks = createChecks();
const building = {
  id: 'test_device',
  name: '测试设备',
  w: 3,
  d: 5,
  ports: [],
  faces: [],
  normalFaces: [],
};
const buildings = { [building.id]: building };
const layout = () => ({
  name: '尺寸测试',
  size: { x: 32, z: 28 },
  nodes: [{ templateId: building.id, position: { x: 12, z: 9 }, direction: 1 }],
  conveyors: [],
});

let allocations = 0;
const contexts = [];
globalThis.document = {
  createElement(tag) {
    assert.equal(tag, 'canvas');
    allocations++;
    const context = new Proxy(
      {
        calls: [],
        measureText: text => ({ width: text.length * 20 }),
        createLinearGradient: () => ({ addColorStop() {} }),
      },
      {
        get(target, key) {
          if (key in target) return target[key];
          return (...args) => target.calls.push([key, ...args]);
        },
      },
    );
    contexts.push(context);
    return { width: 0, height: 0, getContext: () => context };
  },
};
const assets = { get: () => null, preload: async () => {} };
const paint = { assets, buildings, products: {}, sprites: {}, spriteBorders: {}, statusLayers: {} };
const editor = {
  data: layout(),
  showGrid: false,
  showHints: false,
  paintContextPublic: () => paint,
  prepareScene: async () => {},
  assets,
  payload: {
    ...paint,
    buildings: [building],
    lineItems: {},
    presentation: { sprites: {}, covers: { '': { asset: 'cover' } }, rarityLayers: {} },
  },
};

await checks.checkAsync(
  'arbitrary cell size exports a tight rotated footprint without changing its source',
  async () => {
    const source = layout();
    const before = structuredClone(source);
    const canvas = await C.exportCanvas(editor, '', source, 73, true, false, { margin: 0 });
    assert.deepEqual([canvas.width, canvas.height], [365, 219]);
    assert.deepEqual(source, before);
  },
);

await checks.checkAsync('legacy defaults keep one-cell padding and the opaque title band', async () => {
  const opaque = await C.exportCanvas(editor, '', layout(), 40, false, false);
  const transparent = await C.exportCanvas(editor, '', layout(), 40, true, false);
  assert.deepEqual([transparent.width, transparent.height], [280, 200]);
  assert.equal(opaque.height - transparent.height, 48);
});

await checks.checkAsync('conveyor-only exports include both route endpoints', async () => {
  const source = layout();
  source.nodes = [];
  source.conveyors = [
    { x: 4, z: 5, dir: 0, kind: 'item' },
    { x: 9, z: 8, dir: 1, kind: 'fluid' },
  ];
  const canvas = await C.exportCanvas(editor, '', source, 51, true, false, { margin: 0 });
  assert.deepEqual([canvas.width, canvas.height], [306, 204]);
});

await checks.checkAsync('canvas range includes the complete blueprint and empty layouts stay exportable', async () => {
  const full = await C.exportCanvas(editor, '', layout(), 17, true, false, { range: 'canvas', margin: 0 });
  assert.deepEqual([full.width, full.height], [544, 476]);
  const empty = { ...layout(), nodes: [] };
  const canvas = await C.exportCanvas(editor, '', empty, 17, true, false);
  assert.deepEqual([canvas.width, canvas.height], [544, 476]);
});

await checks.checkAsync(
  'bad resolutions, margins, unknown devices, and excessive image sizes are rejected before allocation',
  async () => {
    const before = allocations;
    for (const cell of [0, 7, 257, NaN, Infinity, 12.5]) {
      await assert.rejects(C.exportCanvas(editor, '', layout(), cell, true, false), /每格像素/);
    }
    for (const margin of [-1, 21, NaN, 1.5]) {
      await assert.rejects(C.exportCanvas(editor, '', layout(), 64, true, false, { margin }), /边距/);
    }
    await assert.rejects(C.exportCanvas(editor, '', layout(), 64, true, false, { range: 'other' }), /范围/);
    const invalid = layout();
    invalid.nodes[0].templateId = 'missing';
    await assert.rejects(C.exportCanvas(editor, '', invalid), /ID 未知/);
    const large = { ...layout(), size: { x: 50, z: 50 }, nodes: [] };
    await assert.rejects(C.exportCanvas(editor, '', large, 256), /过大/);
    assert.equal(allocations, before);
  },
);

await checks.checkAsync('the fixed preview API preserves its requested width and original aspect ratio', async () => {
  const canvas = await P.exportPreviewSheet(editor, layout(), 1920, '');
  assert.deepEqual([canvas.width, canvas.height], [1920, 1080]);
});

await checks.checkAsync(
  'content preview keeps the requested cell size and removes fixed viewport whitespace',
  async () => {
    const source = layout();
    source.presentation = { viewport: { zoom: 4, x: 0, y: 1 } };
    const options = { fitToContent: true, cell: 73, margin: 0 };
    const m = P.metrics(editor, source, options);
    const t = P.viewportTransform(editor, source, m);
    assert.equal(t.overflowX, 0);
    assert.equal(t.overflowY, 0);
    assert.equal(t.ox + t.bounds.x0 * t.s, t.area.x);
    assert.equal(t.ox + t.bounds.x1 * t.s, t.area.x + t.area.w);
    const canvas = await P.exportPreviewSheet(editor, source, 2560, '', options);
    const scale = contexts.at(-1).calls.find(([method]) => method === 'scale')[1];
    assert.equal(t.s * scale, 73);
    assert.ok(canvas.width < 1000, `narrow layout unexpectedly expanded to ${canvas.width}`);
    assert.ok(canvas.width > t.gridW * 73, 'the details panel must be retained');
    assert.ok(canvas.height < 600, 'short layouts must not retain the old minimum frame height');
  },
);

checks.check('wide and tall content fits fully without clipping or viewport zoom effects', () => {
  for (const [x, z] of [
    [49, 0],
    [0, 49],
    [49, 49],
  ]) {
    const source = {
      name: 'extended route',
      size: { x: 50, z: 50 },
      nodes: [],
      conveyors: [
        { x: 0, z: 0 },
        { x, z },
      ],
    };
    const m = P.metrics(editor, source, { fitToContent: true, cell: 64, margin: 2 });
    const t = P.viewportTransform(editor, source, m);
    const right = t.ox + t.bounds.x1 * t.s;
    const bottom = t.oy + t.bounds.z1 * t.s;
    assert.ok(right + 2 * t.s <= t.area.x + t.area.w);
    assert.ok(bottom + 2 * t.s <= t.area.y + t.area.h);
    assert.ok(right < m.panelX);
  }
});

const smallBuilding = { ...building, id: 'log_pipe_conditioner', w: 1, d: 1, logistic: true };
const smallBuildings = { [smallBuilding.id]: smallBuilding };
const smallLayout = (x = 4, z = 4) => ({
  name: '边界回归',
  size: { x: 10, z: 10 },
  nodes: [{ templateId: smallBuilding.id, position: { x, z }, direction: 0 }],
  conveyors: [],
});

checks.check('requested margins remain symmetric at all four blueprint corners', () => {
  for (const [x, z] of [
    [0, 0],
    [9, 0],
    [0, 9],
    [9, 9],
  ]) {
    for (const margin of [0, 1, 3, 20]) {
      const m = C.canvasExportMetrics(smallLayout(x, z), smallBuildings, 64, true, { margin });
      assert.deepEqual([m.width, m.height], [(1 + 2 * margin) * 64, (1 + 2 * margin) * 64]);
      assert.deepEqual(m.bounds, { x0: x - margin, z0: z - margin, x1: x + 1 + margin, z1: z + 1 + margin });
    }
  }
});

await checks.checkAsync('zero-margin PNG retains the whole visible environment banner after assets load', async () => {
  for (const cell of [8, 64, 73, 256]) {
    for (const transparent of [false, true]) {
      let loaded = false;
      const banner = { id: 'environment' };
      const environmentPaint = {
        ...paint,
        buildings: smallBuildings,
        assets: { get: key => (loaded && key === 'acid' ? banner : null) },
        sprites: { env_effect_acid: 'acid' },
      };
      const environmentEditor = {
        ...editor,
        paintContextPublic: () => environmentPaint,
        prepareScene: async () => {
          loaded = true;
        },
      };
      const source = smallLayout();
      source.nodes[0].environmentEffect = 'acid';
      const out = await C.exportCanvas(environmentEditor, '', source, cell, transparent, false, { margin: 0 });
      const call = contexts.at(-1).calls.find(([method, image]) => method === 'drawImage' && image === banner);
      assert.ok(call, 'environment banner must be painted even when hints are off');
      const [, , x, y, w, h] = call;
      assert.ok(x >= 0 && y >= (transparent ? 0 : 48), `banner begins outside content: ${x},${y}`);
      assert.ok(x + w <= out.width && y + h <= out.height, 'banner must fit inside the exported pixels');
      if (cell === 64 && transparent) assert.deepEqual([out.width, out.height], [146, 88]);
    }
  }
});

await checks.checkAsync('missing environment sprites do not create empty padding', async () => {
  const source = smallLayout();
  source.nodes[0].environmentEffect = 'acid';
  const out = await C.exportCanvas(
    { ...editor, paintContextPublic: () => ({ ...paint, buildings: smallBuildings }) },
    '',
    source,
    64,
    true,
    false,
    { margin: 0 },
  );
  assert.deepEqual([out.width, out.height], [64, 64]);
});

checks.check('content preview fits visible banners while retaining the original cell dimension label', () => {
  const banner = {};
  const source = smallLayout();
  source.nodes[0].environmentEffect = 'acid';
  const environmentEditor = {
    ...editor,
    assets: { get: key => (key === 'acid' ? banner : null) },
    payload: { ...editor.payload, buildings: [smallBuilding], sprites: { env_effect_acid: 'acid' } },
  };
  const m = P.metrics(environmentEditor, source, { fitToContent: true, cell: 64, margin: 0 });
  const t = P.viewportTransform(environmentEditor, source, m);
  assert.deepEqual([t.gridW, t.gridH], [1, 1], 'metadata dimensions describe occupied cells');
  assert.ok(m.contentBounds.x0 < 4 && m.contentBounds.x1 > 5 && m.contentBounds.z0 < 4);
  const epsilon = 1e-9;
  assert.ok(t.ox + m.contentBounds.x0 * t.s >= t.area.x - epsilon);
  assert.ok(t.ox + m.contentBounds.x1 * t.s <= t.area.x + t.area.w + epsilon);
  assert.ok(t.oy + m.contentBounds.z0 * t.s >= t.area.y - epsilon);
  assert.ok(t.oy + m.contentBounds.z1 * t.s <= t.area.y + t.area.h + epsilon);
});

report('export', checks);
