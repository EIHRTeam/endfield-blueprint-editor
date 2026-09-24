import { footprint, undergroundPeer, undergroundRole } from '../core';
import type { Bounds, Layout } from '../core/types';
import type { PaintContext, PaintOptions } from './paintScene';

/**
 * Export bounds in cell units, including loaded annotations drawn outside device footprints.
 *
 * Call after preparing the scene's assets. Hints use their export scale (one source pixel is
 * 1/128 cell); the editor's counter-scaled controls are intentionally not measured here.
 */
export function sceneBounds(
  layout: Layout,
  paint: PaintContext,
  options: Pick<PaintOptions, 'hints' | 'changeHints' | 'activePair'> = {},
): Bounds {
  if (!layout.nodes.length && !layout.conveyors.length) {
    return { x0: 0, z0: 0, x1: layout.size.x, z1: layout.size.z };
  }

  const { assets, buildings, sprites, statusLayers } = paint;
  const b = { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity };
  const include = (x: number, z: number, w: number, h: number) => {
    b.x0 = Math.min(b.x0, x);
    b.z0 = Math.min(b.z0, z);
    b.x1 = Math.max(b.x1, x + w);
    b.z1 = Math.max(b.z1, z + h);
  };
  const stamp = (asset: string | null | undefined, x: number, z: number, w: number, h: number) => {
    if (assets.get(asset)) include(x, z, w, h);
  };

  for (const belt of layout.conveyors) include(belt.x, belt.z, 1, 1);
  for (const node of layout.nodes) {
    const f = footprint(node, buildings);
    const cx = f.x0 + f.w / 2;
    const cz = f.z0 + f.d / 2;
    include(f.x0, f.z0, f.w, f.d);

    if (node.productIcon) {
      for (const layer of statusLayers[node.itemStatus ?? 'normal'] ?? []) {
        stamp(layer.asset, cx + layer.x / 128, cz + layer.y / 128, layer.w / 128, layer.h / 128);
      }
    }
    stamp(sprites[`env_effect_${node.environmentEffect}`], cx - 145 / 128, cz - (75.4 + 35) / 128, 290 / 128, 70 / 128);

    if (!options.hints) continue;
    const building = buildings[node.templateId]!;
    if (building.canModify && options.changeHints !== false) {
      stamp(sprites.change_hint, cx + (67.5 - 44) / 128, cz - 67.5 / 128, 44 / 128, 44 / 128);
    }
    if (!building.underground) continue;
    if (undergroundPeer(layout.nodes, node)) {
      const pinned = options.activePair === node.undergroundPair;
      const frames = (pinned ? building.activeConnectionFrames : building.connectionFrames) ?? [];
      stamp(frames[node.direction ?? 0], f.x0 + 1 / 64, f.z0 + 1 / 64, f.w - 1 / 32, f.d - 1 / 32);
      stamp(sprites[pinned ? 'udpipe_hide' : 'udpipe_show'], cx - 2 / 128, cz - 40.5 / 128, 44 / 128, 44 / 128);
    } else {
      stamp(sprites.udpipe_disconnected, cx - 74 / 128, cz + 21 / 128, 148 / 128, 42 / 128);
    }
  }

  if (options.hints && options.activePair && assets.get(sprites.udpipe_line) && paint.spriteBorders.udpipe_line) {
    const pair = layout.nodes.filter(node => node.undergroundPair === options.activePair);
    const from = pair.find(node => undergroundRole(node) === 'in');
    const to = pair.find(node => undergroundRole(node) === 'out');
    if (pair.length === 2 && from && to) {
      const a = footprint(from, buildings);
      const z = footprint(to, buildings);
      const ax = a.x0 + a.w / 2;
      const az = a.z0 + a.d / 2;
      const zx = z.x0 + z.w / 2;
      const zz = z.z0 + z.d / 2;
      const length = Math.hypot(zx - ax, zz - az);
      if (length > 0) {
        // The connection is a one-cell-wide rectangle rotated onto the segment between centres.
        const xRadius = Math.abs(zz - az) / length / 2;
        const zRadius = Math.abs(zx - ax) / length / 2;
        include(
          Math.min(ax, zx) - xRadius,
          Math.min(az, zz) - zRadius,
          Math.abs(zx - ax) + xRadius * 2,
          Math.abs(zz - az) + zRadius * 2,
        );
      }
    }
  }
  return b;
}
