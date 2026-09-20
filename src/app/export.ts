/**
 * Canvas and presentation rendering.
 *
 * `paintScene` is shared with the live canvas, which is what makes the exported PNG match what the
 * user sees. Export only adds the surrounding surface (background, name, margins).
 */
import { bounds, clone } from '../core';
import type { Layout } from '../core/types';
import { paintScene, sceneAssetKeys } from '../render/paintScene';
import type { PaintContext } from '../render/paintScene';
import type { SceneValue } from './SceneContext';
import { FONT_FAMILY } from './fonts';

export interface CanvasExportOptions {
  /** Pixels per cell: 40, 64 or 128. */
  cell: number;
  transparent: boolean;
  hints: boolean;
}

function paintContext(scene: SceneValue, buildings: PaintContext['buildings']): PaintContext {
  return {
    assets: scene.assets,
    buildings,
    products: scene.products,
    sprites: scene.sprites,
    spriteBorders: scene.spriteBorders,
    statusLayers: scene.statusLayers,
  };
}

function buildingIndex(scene: SceneValue): PaintContext['buildings'] {
  const index: PaintContext['buildings'] = {};
  for (const building of scene.payload.buildings) index[building.id] = building;
  return index;
}

/**
 * Renders the layout to an offscreen canvas for PNG export.
 *
 * Coordinates are shifted exactly once; rotated extents come from `core.bounds`.
 */
export async function exportCanvas(
  scene: SceneValue,
  layout: Layout,
  options: CanvasExportOptions,
): Promise<HTMLCanvasElement> {
  const source = clone(layout);
  if (![40, 64, 128].includes(options.cell)) throw Error('无效的导出分辨率');

  const buildings = buildingIndex(scene);
  await scene.assets.preload(
    sceneAssetKeys(source, {
      buildings,
      products: scene.products,
      sprites: scene.sprites,
      assets: scene.assets,
    }),
  );

  const b = bounds(source, buildings, 1);
  const top = options.transparent ? 0 : 48;
  const out = document.createElement('canvas');
  out.width = (b.x1 - b.x0) * options.cell;
  out.height = (b.z1 - b.z0) * options.cell + top;
  const context = out.getContext('2d')!;

  if (!options.transparent) {
    context.fillStyle = '#e6e6e6';
    context.fillRect(0, 0, out.width, out.height);
    context.fillStyle = '#454545';
    context.font = `20px "${FONT_FAMILY}",sans-serif`;
    context.textBaseline = 'middle';
    context.fillText(source.name, 18, 24, out.width - 36);
  }

  paintScene(
    context,
    source,
    paintContext(scene, buildings),
    { s: options.cell, ox: -b.x0 * options.cell, oy: top - b.z0 * options.cell },
    {
      grid: !options.transparent,
      bounds: b,
      hints: options.hints,
      activePair: source.presentation?.connectionPair || null,
    },
  );
  return out;
}

/** Renders the full game-style preview sheet at the requested width. */
export async function exportPresentationPreview(scene: SceneValue, layout: Layout, width: number) {
  const module = await import('../features/presentation/export');
  return module.default(scene, layout, width);
}
