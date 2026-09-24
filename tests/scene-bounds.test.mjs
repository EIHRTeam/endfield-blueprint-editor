/** Compare content bounds with the rectangles actually stamped by the shared scene painter. */
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
        sceneBounds: path.join(ROOT, 'src/render/sceneBounds.ts'),
        paintScene: path.join(ROOT, 'src/render/paintScene.ts'),
      },
      formats: ['es'],
      fileName: (_format, entry) => `${entry}-bounds-test.mjs`,
    },
  },
});
const { sceneBounds } = await import(
  pathToFileURL(path.join(ROOT, 'reports/test-artifacts/sceneBounds-bounds-test.mjs'))
);
const { paintScene } = await import(
  pathToFileURL(path.join(ROOT, 'reports/test-artifacts/paintScene-bounds-test.mjs'))
);
const checks = createChecks();
const image = { width: 128, height: 128 };

function fixture() {
  const device = {
    id: 'device',
    w: 3,
    d: 5,
    ports: [],
    faces: ['body', 'body', 'body', 'body'],
    normalFaces: ['body', 'body', 'body', 'body'],
    symbol: 'symbol',
  };
  const small = { ...device, id: 'small', w: 1, d: 1, logistic: true, canModify: true };
  const loader = {
    ...small,
    id: 'udpipe_loader_1',
    underground: true,
    connectionFrames: ['frame', 'frame', 'frame', 'frame'],
    activeConnectionFrames: ['active', 'active', 'active', 'active'],
  };
  const unloader = { ...loader, id: 'udpipe_unloader_1' };
  const sprites = Object.fromEntries(
    [
      'env_effect_acid',
      'change_hint',
      'udpipe_disconnected',
      'udpipe_show',
      'udpipe_hide',
      'udpipe_line',
      'icon_belt_grid',
      'icon_belt_corner_1',
      'icon_belt_corner_2',
      'icon_pipe_grid',
      'icon_pipe_corner_1',
      'icon_pipe_corner_2',
    ].map(key => [key, key]),
  );
  const available = new Set([...Object.values(sprites), 'body', 'symbol', 'frame', 'active', 'status', 'product']);
  return {
    available,
    paint: {
      buildings: Object.fromEntries([device, small, loader, unloader].map(building => [building.id, building])),
      assets: {
        get: key => (available.has(key) ? image : null),
        tintedStatus: source => source,
      },
      products: { item: { badge: 'product' } },
      sprites,
      spriteBorders: { udpipe_line: [10, 10, 10, 10] },
      statusLayers: { limited: [{ asset: 'status', x: -90, y: -82, w: 212, h: 208, theme: true }] },
    },
  };
}

const node = (templateId = 'small', x = 0, z = 0, extra = {}) => ({
  templateId,
  position: { x, z },
  direction: 0,
  ...extra,
});
const layout = (nodes = [], conveyors = []) => ({ name: 'bounds', size: { x: 32, z: 28 }, nodes, conveyors });

/** Minimal affine Canvas recorder: includes the transformed destination of every drawImage call. */
function paintedBounds(source, paint, options, cell = 64) {
  let matrix = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const points = [];
  let stamps = 0;
  const ox = 47;
  const oy = 83;
  const context = {
    save() {
      stack.push([...matrix]);
    },
    restore() {
      matrix = stack.pop();
    },
    translate(x, y) {
      matrix[4] += matrix[0] * x + matrix[2] * y;
      matrix[5] += matrix[1] * x + matrix[3] * y;
    },
    rotate(angle) {
      const [a, b, c, d, e, f] = matrix;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      matrix = [a * cos + c * sin, b * cos + d * sin, c * cos - a * sin, d * cos - b * sin, e, f];
    },
    drawImage(...args) {
      stamps++;
      const [x, y, w, h] = args.slice(args.length === 9 ? 5 : 1);
      for (const [px, py] of [
        [x, y],
        [x + w, y],
        [x, y + h],
        [x + w, y + h],
      ]) {
        points.push({
          x: (matrix[0] * px + matrix[2] * py + matrix[4] - ox) / cell,
          z: (matrix[1] * px + matrix[3] * py + matrix[5] - oy) / cell,
        });
      }
    },
  };
  paintScene(context, source, paint, { s: cell, ox, oy }, options);
  return {
    bounds: {
      x0: Math.min(...points.map(point => point.x)),
      z0: Math.min(...points.map(point => point.z)),
      x1: Math.max(...points.map(point => point.x)),
      z1: Math.max(...points.map(point => point.z)),
    },
    stamps,
  };
}

function matchesPainter(source, paint, options = {}, cell = 64) {
  const actual = sceneBounds(source, paint, options);
  const drawn = paintedBounds(source, paint, options, cell);
  assert.ok(drawn.stamps > 0);
  for (const key of ['x0', 'z0', 'x1', 'z1']) {
    assert.ok(Math.abs(actual[key] - drawn.bounds[key]) < 1e-10, `${key}: ${actual[key]} !== ${drawn.bounds[key]}`);
  }
  return actual;
}

checks.check('rotated device footprints and conveyor endpoints match their painted extent', () => {
  const { paint } = fixture();
  const source = layout(
    [node('device', 12, 9, { direction: 1 })],
    [
      { x: 4, z: 5, dir: 0, kind: 'item' },
      { x: 19, z: 17, dir: 1, kind: 'fluid' },
    ],
  );
  const before = structuredClone(source);
  assert.deepEqual(matchesPainter(source, paint), { x0: 4, z0: 5, x1: 20, z1: 18 });
  assert.deepEqual(source, before);
});

checks.check('acid banner on a one-cell device retains its full 145-pixel width at 64 pixels per cell', () => {
  const { paint } = fixture();
  const source = layout([node('small', 0, 0, { environmentEffect: 'acid' })]);
  const b = matchesPainter(source, paint);
  assert.equal((b.x1 - b.x0) * 64, 145);
  assert.ok(b.x0 < 0 && b.z0 < 0, 'annotations must extend beyond the blueprint edge');
  matchesPainter(source, paint, {}, 73);
});

checks.check('absent environment assets and unselected environments add no annotation whitespace', () => {
  const { paint, available } = fixture();
  const source = layout([node('small', 0, 0, { environmentEffect: 'acid' })]);
  available.delete('env_effect_acid');
  assert.deepEqual(matchesPainter(source, paint), { x0: 0, z0: 0, x1: 1, z1: 1 });
  available.add('env_effect_acid');
  source.nodes[0].environmentEffect = '';
  assert.deepEqual(matchesPainter(source, paint), { x0: 0, z0: 0, x1: 1, z1: 1 });
});

checks.check('product status layers expand bounds only when the product and layer asset are present', () => {
  const { paint, available } = fixture();
  const source = layout([node('small', 0, 0, { productIcon: 'item', itemStatus: 'limited' })]);
  const b = matchesPainter(source, paint);
  assert.ok(b.x0 < 0 && b.z0 < 0 && b.x1 > 1 && b.z1 > 1);
  available.delete('status');
  assert.deepEqual(matchesPainter(source, paint), { x0: 0, z0: 0, x1: 1, z1: 1 });
  available.add('status');
  delete source.nodes[0].productIcon;
  assert.deepEqual(matchesPainter(source, paint), { x0: 0, z0: 0, x1: 1, z1: 1 });
});

checks.check('change badges follow both hint switches and asset availability', () => {
  const { paint, available } = fixture();
  const source = layout([node()]);
  assert.deepEqual(matchesPainter(source, paint, { hints: true }), { x0: 0, z0: -3.5 / 128, x1: 1 + 3.5 / 128, z1: 1 });
  for (const options of [{ hints: false }, { hints: true, changeHints: false }]) {
    assert.deepEqual(matchesPainter(source, paint, options), { x0: 0, z0: 0, x1: 1, z1: 1 });
  }
  available.delete('change_hint');
  assert.deepEqual(matchesPainter(source, paint, { hints: true }), { x0: 0, z0: 0, x1: 1, z1: 1 });
});

checks.check('disconnected underground marker contributes its overhanging width only when visible', () => {
  const { paint, available } = fixture();
  const source = layout([node('udpipe_loader_1')]);
  const options = { hints: true, changeHints: false };
  assert.deepEqual(matchesPainter(source, paint, options), { x0: -10 / 128, z0: 0, x1: 1 + 10 / 128, z1: 1 });
  available.delete('udpipe_disconnected');
  assert.deepEqual(matchesPainter(source, paint, options), { x0: 0, z0: 0, x1: 1, z1: 1 });
  available.add('udpipe_disconnected');
  assert.deepEqual(matchesPainter(source, paint, { hints: false }), { x0: 0, z0: 0, x1: 1, z1: 1 });
});

checks.check('paired underground frames and rotated connection bands stay within measured bounds', () => {
  const { paint, available } = fixture();
  for (const [x, z] of [
    [5, 0],
    [0, 5],
    [5, 3],
    [1, 7],
  ]) {
    const source = layout([
      node('udpipe_loader_1', 0, 0, { undergroundPair: 'pipe-1' }),
      node('udpipe_unloader_1', x, z, { undergroundPair: 'pipe-1', direction: 3 }),
    ]);
    const options = { hints: true, changeHints: false, activePair: 'pipe-1' };
    matchesPainter(source, paint, options);
    matchesPainter(source, paint, { ...options, activePair: null });
    matchesPainter(source, paint, { hints: false, activePair: 'pipe-1' });
    available.delete('udpipe_line');
    matchesPainter(source, paint, options);
    available.add('udpipe_line');
    const border = paint.spriteBorders.udpipe_line;
    delete paint.spriteBorders.udpipe_line;
    matchesPainter(source, paint, options);
    paint.spriteBorders.udpipe_line = border;
  }
});

checks.check('empty layouts keep the complete canvas and missing bodies retain device and line footprints', () => {
  const { paint, available } = fixture();
  assert.deepEqual(sceneBounds(layout(), paint), { x0: 0, z0: 0, x1: 32, z1: 28 });
  available.clear();
  const source = layout([node('device', 30, 27, { direction: 1 })], [{ x: -1, z: -2, kind: 'item', dir: 0 }]);
  assert.deepEqual(sceneBounds(source, paint), { x0: -1, z0: -2, x1: 35, z1: 30 });
});

report('scene-bounds', checks);
