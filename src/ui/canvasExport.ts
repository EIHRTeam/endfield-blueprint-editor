import { bounds, clone, validate } from '../core';
import type { Bounds, BuildingIndex, Layout } from '../core/types';
import { paintScene } from '../render/paintScene';
import { sceneBounds } from '../render/sceneBounds';
import type { Editor } from './editor';

export interface CanvasExportOptions {
  range?: 'content' | 'canvas';
  margin?: number;
}

/** Shared limits keep accidental huge exports from allocating an unusable canvas. */
export function validateExportSize(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw Error('导出图片尺寸无效');
  }
  if (width > 16384 || height > 16384 || width * height > 64 * 1024 * 1024) {
    throw Error('导出图片过大，请减小每格像素或边距');
  }
}

export function validateCellAndMargin(cell: number, margin: number): void {
  if (!Number.isInteger(cell) || cell < 8 || cell > 256) throw Error('每格像素须为 8–256 的整数');
  if (!Number.isInteger(margin) || margin < 0 || margin > 20) throw Error('边距须为 0–20 格的整数');
}

export function canvasExportMetrics(
  layout: Layout,
  buildings: BuildingIndex,
  cell: number,
  transparent: boolean,
  options: CanvasExportOptions = {},
  visibleBounds?: Bounds,
) {
  const margin = options.margin ?? 1;
  validateCellAndMargin(cell, margin);
  const range = options.range ?? 'content';
  if (range !== 'content' && range !== 'canvas') throw Error('无效的导出范围');
  const content = range === 'content' && Boolean(layout.nodes.length || layout.conveyors.length);
  const area = content
    ? (visibleBounds ?? bounds(layout, buildings, 0))
    : { x0: 0, z0: 0, x1: layout.size.x, z1: layout.size.z };
  const padding = content ? margin : 0;
  // Export padding is independent of the editable grid. Round outward in pixel space so fractional
  // overlay extents remain visible even at odd cell resolutions.
  const left = Math.floor((area.x0 - padding) * cell);
  const topEdge = Math.floor((area.z0 - padding) * cell);
  const right = Math.ceil((area.x1 + padding) * cell);
  const bottom = Math.ceil((area.z1 + padding) * cell);
  const top = transparent ? 0 : 48;
  const width = right - left;
  const height = bottom - topEdge + top;
  validateExportSize(width, height);
  return { bounds: { x0: left / cell, z0: topEdge / cell, x1: right / cell, z1: bottom / cell }, top, width, height };
}

/** Content-sized PNG export; callers own the UI defaults, so API calls remain deterministic. */
export async function exportCanvas(
  editor: Editor,
  base: string,
  layout: Layout = editor.data,
  cell = 64,
  transparent = false,
  hints = editor.showHints,
  options: CanvasExportOptions = {},
): Promise<HTMLCanvasElement> {
  const paint = editor.paintContextPublic();
  const source = validate(clone(layout), paint.buildings);
  // Reject invalid settings and clearly oversized canvases before loading or allocating anything.
  canvasExportMetrics(source, paint.buildings, cell, transparent, options);
  await editor.prepareScene(source, base);
  const visibleBounds = sceneBounds(source, paint, {
    hints,
    activePair: source.presentation?.connectionPair || null,
  });
  const m = canvasExportMetrics(source, paint.buildings, cell, transparent, options, visibleBounds);
  const out = document.createElement('canvas');
  out.width = m.width;
  out.height = m.height;
  const ctx = out.getContext('2d');
  if (!ctx) throw Error('无法创建导出画布，请减小每格像素');
  if (!transparent) {
    ctx.fillStyle = '#e6e6e6';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.fillStyle = '#454545';
    ctx.font = '20px "HarmonyOS Sans SC",sans-serif';
    ctx.textBaseline = 'middle';
    const inset = Math.min(18, out.width / 8);
    ctx.fillText(source.name, inset, 24, out.width - inset * 2);
  }
  paintScene(
    ctx,
    source,
    paint,
    { s: cell, ox: -m.bounds.x0 * cell, oy: m.top - m.bounds.z0 * cell },
    {
      grid: !transparent && editor.showGrid,
      bounds: m.bounds,
      hints,
      activePair: source.presentation?.connectionPair || null,
    },
  );
  return out;
}
