/**
 * The canvas painter.
 *
 * One function paints a layout for both the live editor and every PNG export. Sharing it is what
 * guarantees that what you see is what you export; the previous implementation had the same
 * property and this port keeps it.
 *
 * Ported from the previous `editor_app.js` (`drawNode`, `drawSlicedSprite`, `drawNativeGrid`,
 * `paintScene`) with identical geometry and colour choices.
 */
import {
  DV,
  buildingCells,
  conveyorSprites,
  footprint,
  key as cellKey,
  undergroundPeer,
  undergroundRole,
  worldPorts,
} from '../core';
import type {
  BlueprintNode,
  BuildingIndex,
  Bounds,
  Layout,
  PresentationPayload,
  Product,
  SpriteBorders,
  StatusLayer,
  WorldPort,
} from '../core/types';
import type { AssetStore } from './assets';
import { nodeBody } from './nodeBody';

export interface PaintContext {
  assets: AssetStore;
  buildings: BuildingIndex;
  products: Record<string, Product>;
  sprites: Record<string, string>;
  spriteBorders: SpriteBorders;
  statusLayers: Record<string, StatusLayer[]>;
}

export interface PaintTransform {
  /** Pixels per cell. */
  s: number;
  /** Screen-space origin of cell (0, 0), in pixels. */
  ox: number;
  oy: number;
}

export interface PaintOptions {
  grid?: boolean;
  gridRect?: { x: number; y: number; w: number; h: number };
  bounds?: Bounds;
  ports?: boolean;
  hints?: boolean;
  /** Exports use the 128 px source unit; the live canvas counter-scales the UI controls. */
  hintScale?: number;
  changeHints?: boolean;
  activePair?: string | null;
  /** Index of the device to dim while it is being dragged. */
  dimIndex?: number;
  /** When true, only the belt/pipe layers are painted. */
  linesOnly?: boolean;
}

const FONT = 'HarmonyOS Sans SC';

/** Product ids are lower-cased for gas pseudo-items, matching the baking layer's keys. */
export function productKey(id: string | null | undefined): string | null {
  if (!id) return null;
  return id.startsWith('[gas]') ? id.toLowerCase() : id;
}

function productInfo(products: Record<string, Product>, id: string | null | undefined): Product | undefined {
  const lookup = productKey(id);
  return lookup ? products[lookup] : undefined;
}

/**
 * Stamps a nine-slice sprite.
 *
 * Centre and edge regions stretch while corners keep their pixel size, which is how the original
 * Unity `Image.Type.Sliced` controls behave.
 */
export function drawSlicedSprite(
  c: CanvasRenderingContext2D,
  image: CanvasImageSource | null,
  border: [number, number, number, number] | undefined,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
): void {
  if (!image || !border || w <= 0 || h <= 0) return;
  const [left, bottom, right, top] = border;
  const kx = Math.min(scale, w / Math.max(1, left + right));
  const ky = Math.min(scale, h / Math.max(1, top + bottom));
  const iw = (image as HTMLImageElement).width;
  const ih = (image as HTMLImageElement).height;
  const sx = [0, left, iw - right, iw];
  const sy = [0, top, ih - bottom, ih];
  const dx = [x, x + left * kx, x + w - right * kx, x + w];
  const dy = [y, y + top * ky, y + h - bottom * ky, y + h];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      if (sx[col + 1]! > sx[col]! && sy[row + 1]! > sy[row]! && dx[col + 1]! > dx[col]! && dy[row + 1]! > dy[row]!) {
        c.drawImage(
          image,
          sx[col]!,
          sy[row]!,
          sx[col + 1]! - sx[col]!,
          sy[row + 1]! - sy[row]!,
          dx[col]!,
          dy[row]!,
          dx[col + 1]! - dx[col]!,
          dy[row + 1]! - dy[row]!,
        );
      }
    }
  }
}

/**
 * Fills a rectangle with the game's original grid tile, aligned to the cell grid.
 *
 * Using the native tile rather than a drawn line grid is what makes the canvas match the game.
 */
function drawNativeGrid(
  c: CanvasRenderingContext2D,
  image: CanvasImageSource | null,
  transform: PaintTransform,
  rect: { x: number; y: number; w: number; h: number },
): void {
  if (!image) return;
  const { s, ox, oy } = transform;
  const pattern = c.createPattern(image, 'repeat');
  if (!pattern) return;
  pattern.setTransform(new DOMMatrix([s / 128, 0, 0, s / 128, ox, oy]));
  c.save();
  c.fillStyle = pattern;
  c.fillRect(rect.x, rect.y, rect.w, rect.h);
  c.restore();
}

/** Paints one device: body, icon, status badge, environment banner and optional port markers. */
export function drawNode(
  c: CanvasRenderingContext2D,
  node: BlueprintNode,
  paint: PaintContext,
  transform: PaintTransform,
  ports = false,
): void {
  const { assets, buildings, sprites, statusLayers } = paint;
  const building = buildings[node.templateId]!;
  const f = footprint(node, buildings);
  const { s, ox, oy } = transform;
  const x = ox + f.x0 * s;
  const y = oy + f.z0 * s;
  const w = f.w * s;
  const h = f.d * s;

  const body = nodeBody(node, buildings, assets, sprites);
  if (body) c.drawImage(body, x, y, w, h);

  const iconKey = node.productIcon ? productInfo(paint.products, node.productIcon)?.badge : building.symbol;
  const icon = assets.get(iconKey ?? (node.productIcon ? sprites.badge_bg : null));
  const side = ((node.productIcon ? 120 : 126) / 128) * s;
  if (icon) c.drawImage(icon, x + (w - side) / 2, y + (h - side) / 2, side, side);
  if (node.productIcon && !iconKey) {
    c.save();
    c.fillStyle = '#ffffff';
    c.font = `${Math.max(9, s * 0.55)}px "${FONT}",sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('?', x + w / 2, y + h / 2);
    c.restore();
  }

  if (node.productIcon) {
    for (const layer of statusLayers[node.itemStatus ?? 'normal'] ?? []) {
      let image: CanvasImageSource | null = assets.get(layer.asset);
      if (!image) continue;
      if (layer.theme) image = assets.tintedStatus(image as HTMLImageElement, node.itemStatusColor || '#00ffff');
      c.drawImage(
        image,
        x + w / 2 + (layer.x / 128) * s,
        y + h / 2 + (layer.y / 128) * s,
        (layer.w / 128) * s,
        (layer.h / 128) * s,
      );
    }
  }

  const env = assets.get(sprites[`env_effect_${node.environmentEffect}`]);
  if (env) {
    c.drawImage(env, x + w / 2 - (145 / 128) * s, y + h / 2 - ((75.4 + 35) / 128) * s, (290 / 128) * s, (70 / 128) * s);
  }

  if (ports && s >= 16) {
    // Port markers are drawn in device-local space and rotated with the device.
    for (const port of building.ports) {
      if ((node.formulaMode === 'normal' && port.pipe) || node.closedPorts?.includes(port.id)) continue;
      let px = port.x;
      let pz = port.z;
      let dir = port.dir;
      let W = building.w;
      let D = building.d;
      for (let turn = 0; turn < (node.direction ?? 0); turn++) {
        [px, pz] = [D - 1 - pz, px];
        [W, D] = [D, W];
        dir = ((dir + 1) % 4) as typeof dir;
      }
      const mx = x + (px + 0.5 + DV[dir]![0] * 0.36) * s;
      const my = y + (pz + 0.5 + DV[dir]![1] * 0.36) * s;
      const r = Math.max(3, s * 0.11);
      c.fillStyle = port.pipe ? (port.input ? '#3574cd' : '#27a6b6') : port.input ? '#ce635b' : '#52a361';
      c.beginPath();
      if (port.pipe) c.arc(mx, my, r, 0, Math.PI * 2);
      else c.rect(mx - r, my - r, r * 2, r * 2);
      c.fill();
      if (s >= 36) {
        c.fillStyle = '#fff';
        c.font = `${Math.max(9, s * 0.19)}px "${FONT}",sans-serif`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(String(port.n), mx, my);
      }
    }
  }
}

/**
 * Paints a whole layout.
 *
 * Layer order matters and is deliberate: belts under devices, devices under pipes, and the original
 * UI hints on top. A small native-sprite extension closes the padding between the grid boundary and
 * a visible port without ever exposing a belt tile inside a device.
 */
export function paintScene(
  c: CanvasRenderingContext2D,
  layout: Layout,
  paint: PaintContext,
  transform: PaintTransform,
  options: PaintOptions = {},
): void {
  const { buildings, sprites, assets } = paint;
  const { s, ox, oy } = transform;

  if (options.grid) {
    const b = options.bounds ?? { x0: 0, z0: 0, x1: layout.size.x, z1: layout.size.z };
    drawNativeGrid(
      c,
      assets.get(sprites.grid),
      transform,
      options.gridRect ?? {
        x: ox + b.x0 * s,
        y: oy + b.z0 * s,
        w: (b.x1 - b.x0) * s + 1,
        h: (b.z1 - b.z0) * s + 1,
      },
    );
  }

  const occupied = buildingCells(layout, buildings);
  const lines = conveyorSprites(layout.conveyors.filter(belt => !occupied.has(cellKey(belt.x, belt.z))));

  const layer = (kind: 'item' | 'fluid') => {
    for (const belt of lines) {
      if (belt.kind !== kind) continue;
      const image = assets.get(sprites[belt.sprite]);
      if (!image) continue;
      c.save();
      c.translate(ox + (belt.x + 0.5) * s, oy + (belt.z + 0.5) * s);
      c.rotate((belt.angle * Math.PI) / 180);
      c.drawImage(image, -s / 2, -s / 2, s, s);
      c.restore();
    }

    const lookup = new Map(lines.filter(belt => belt.kind === kind).map(belt => [cellKey(belt.x, belt.z), belt]));
    for (const node of layout.nodes) {
      if (buildings[node.templateId]!.logistic) continue;
      for (const port of worldPorts(node, buildings)) {
        if (port.pipe !== (kind === 'fluid')) continue;
        const line = lookup.get(cellKey(port.outX, port.outZ));
        if (!line || (line.dir !== (port.dir + 2) % 4 && (line.fromDir ?? line.dir) !== port.dir)) continue;
        const image = assets.get(sprites[kind === 'fluid' ? 'icon_pipe_grid' : 'icon_belt_grid']);
        if (!image) continue;
        const depth = (port.inset ?? 0.12) * s;
        const edgeX = ox + port.edgeX * s;
        const edgeY = oy + port.edgeZ * s;
        c.save();
        c.beginPath();
        if (port.dir === 0) c.rect(edgeX - depth, edgeY - s / 2, depth, s);
        if (port.dir === 2) c.rect(edgeX, edgeY - s / 2, depth, s);
        if (port.dir === 1) c.rect(edgeX - s / 2, edgeY - depth, s, depth);
        if (port.dir === 3) c.rect(edgeX - s / 2, edgeY, s, depth);
        c.clip();
        c.translate(ox + (port.x + 0.5) * s, oy + (port.z + 0.5) * s);
        c.rotate((port.dir * Math.PI) / 2);
        c.drawImage(image, -s / 2, -s / 2, s, s);
        c.restore();
      }
    }
  };

  layer('item');

  if (!options.linesOnly) {
    layout.nodes.forEach((node, index) => {
      c.save();
      if (options.dimIndex === index) c.globalAlpha *= 0.25;
      drawNode(c, node, paint, transform, options.ports);
      c.restore();
    });
  }

  layer('fluid');

  if (options.hints) paintHints(c, layout, paint, transform, options);
}

/** Paints the original UI hints: change-icon badge, underground hints and the connection band. */
function paintHints(
  c: CanvasRenderingContext2D,
  layout: Layout,
  paint: PaintContext,
  transform: PaintTransform,
  options: PaintOptions,
): void {
  const { buildings, sprites, assets } = paint;
  const { s, ox, oy } = transform;
  // Unity counter-scales these UI controls on screen. Exports use the 128 px source unit.
  const q = options.hintScale ?? s / 128;

  for (const node of layout.nodes) {
    const building = buildings[node.templateId]!;
    const f = footprint(node, buildings);
    const cx = ox + (f.x0 + f.w / 2) * s;
    const cy = oy + (f.z0 + f.d / 2) * s;
    const peer = undergroundPeer(layout.nodes, node);

    const stamp = (image: CanvasImageSource | null, x: number, y: number, w: number, h: number) => {
      if (image) c.drawImage(image, x, y, w, h);
    };

    if (building.canModify && options.changeHints !== false) {
      stamp(assets.get(sprites.change_hint), cx + (67.5 / 128) * s - 44 * q, cy - (67.5 / 128) * s, 44 * q, 44 * q);
    }
    if (!building.underground) continue;

    if (peer) {
      const pinned = options.activePair === node.undergroundPair;
      const frames = (pinned ? building.activeConnectionFrames : building.connectionFrames) ?? [];
      stamp(
        assets.get(frames[node.direction ?? 0]),
        ox + f.x0 * s + s / 64,
        oy + f.z0 * s + s / 64,
        f.w * s - s / 32,
        f.d * s - s / 32,
      );
      stamp(assets.get(sprites[pinned ? 'udpipe_hide' : 'udpipe_show']), cx - 2 * q, cy - 40.5 * q, 44 * q, 44 * q);
    } else {
      stamp(assets.get(sprites.udpipe_disconnected), cx - 74 * q, cy + 21 * q, 148 * q, 42 * q);
    }
  }

  if (!options.activePair) return;
  const pair = layout.nodes.filter(node => node.undergroundPair === options.activePair);
  if (pair.length !== 2) return;
  const from = pair.find(node => undergroundRole(node) === 'in');
  const to = pair.find(node => undergroundRole(node) === 'out');
  if (!from || !to) return;

  const center = (node: BlueprintNode) => {
    const f = footprint(node, buildings);
    return { x: ox + (f.x0 + f.w / 2) * s, y: oy + (f.z0 + f.d / 2) * s };
  };
  const a = center(from);
  const b = center(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  c.save();
  c.translate(a.x, a.y);
  c.rotate(Math.atan2(dy, dx));
  drawSlicedSprite(
    c,
    assets.get(sprites.udpipe_line),
    paint.spriteBorders.udpipe_line,
    0,
    -s / 2,
    Math.hypot(dx, dy),
    s,
    s / 128,
  );
  c.restore();
}

/**
 * Every asset key `paintScene` may touch for a layout.
 *
 * Callers preload the result so painting never draws a half-loaded scene. This mirrors the previous
 * `prepareScene` exactly; a wrong key set shows up as flicker, not as an error.
 */
export function sceneAssetKeys(
  layout: Layout,
  paint: Pick<PaintContext, 'buildings' | 'products' | 'sprites' | 'assets'>,
): Set<string> {
  const keys = new Set<string>(Object.values(paint.sprites));
  for (const node of layout.nodes) {
    const building = paint.buildings[node.templateId]!;
    const product = productInfo(paint.products, node.productIcon);
    keys.add(node.productIcon ? (product?.badge ?? '') : (building.symbol ?? ''));
    keys.add(building.connectionFrames?.[node.direction ?? 0] ?? '');
    keys.add(building.activeConnectionFrames?.[node.direction ?? 0] ?? '');
    if (node.closedPorts?.length) {
      keys.add(building.bareFaces?.[node.direction ?? 0] ?? '');
      keys.add(building.waistFaces?.[node.direction ?? 0] ?? '');
      keys.add(building.edgeDecoration ?? '');
    }
  }
  keys.delete('');
  return keys;
}

/** Bounds helper re-exported for callers that paint from a layout without importing the core. */
export type { WorldPort, PresentationPayload };
export { footprint as nodeFootprint };
