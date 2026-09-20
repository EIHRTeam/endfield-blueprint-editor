/**
 * The inspector's device preview.
 *
 * Reuses the scene renderer so the thumbnail includes the same body, item icon, status badge,
 * environment banner and hints as the canvas — the original implementation had the same property.
 */
import { clone, dims, footprint } from '../core';
import type { Layout } from '../core/types';
import { paintScene } from '../render/paintScene';
import type { SceneValue } from '../app/SceneContext';

/** Paints the currently selected device into the inspector's canvas. */
export function paintInspectorPreview(
  target: HTMLCanvasElement,
  scene: SceneValue,
  layout: Layout,
  selectedIndex: number,
): void {
  const node = layout.nodes[selectedIndex];
  if (!node) return;
  const buildings: Parameters<typeof footprint>[1] = {};
  for (const building of scene.payload.buildings) buildings[building.id] = building;

  const building = buildings[node.templateId]!;
  const size = dims(building, node.direction);
  // Cap the preview so very wide devices still fit the panel.
  const scale = Math.min(64, 176 / size.w, 126 / size.d);
  const snapshot = clone(node);
  const width = Math.ceil(size.w * scale + 12);
  const height = Math.ceil(size.d * scale + 12);
  const ratio = devicePixelRatio || 1;
  target.width = Math.ceil(width * ratio);
  target.height = Math.ceil(height * ratio);
  target.style.width = `${width}px`;
  target.style.height = `${height}px`;

  const context = target.getContext('2d')!;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const previewLayout: Layout = {
    ...layout,
    nodes: layout.nodes.map((candidate, index) => (index === selectedIndex ? snapshot : candidate)),
  };

  paintScene(
    context,
    previewLayout,
    {
      assets: scene.assets,
      buildings,
      products: scene.products,
      sprites: scene.sprites,
      spriteBorders: scene.spriteBorders,
      statusLayers: scene.statusLayers,
    },
    { s: scale, ox: 6 - snapshot.position.x * scale, oy: 6 - snapshot.position.z * scale },
    { hints: true },
  );
}
