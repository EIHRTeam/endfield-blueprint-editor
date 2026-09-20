/**
 * Viewport helpers for the editor canvas.
 *
 * The view is a uniform scale plus a translation, exactly like the previous implementation, so
 * "fit" keeps the same margins and the wheel keeps the same cursor anchoring.
 */
import { bounds } from '../../core';
import type { BuildingIndex, Layout } from '../../core/types';

export interface View {
  /** Pixels per cell. */
  s: number;
  /** Screen-space origin of cell (0, 0). */
  ox: number;
  oy: number;
}

export const MIN_SCALE = 6;
export const MAX_SCALE = 128;
const FIT_MAX_SCALE = 96;

export function initialView(): View {
  return { s: 30, ox: 35, oy: 55 };
}

/** Fits everything placed into the viewport, with the original margins. */
export function fitView(data: Layout, buildings: BuildingIndex, width: number, height: number): View {
  const b = bounds(data, buildings, 1);
  const w = b.x1 - b.x0;
  const h = b.z1 - b.z0;
  const s = Math.min(FIT_MAX_SCALE, Math.max(MIN_SCALE, Math.min((width - 70) / w, (height - 100) / h)));
  return {
    s,
    ox: (width - w * s) / 2 - b.x0 * s,
    oy: 30 + (height - h * s) / 2 - b.z0 * s,
  };
}

/** Zooms around a cursor position so the cell under the pointer stays put. */
export function zoomAt(view: View, x: number, y: number, factor: number): View {
  const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.s * factor));
  const k = s / view.s;
  return { s, ox: x - (x - view.ox) * k, oy: y - (y - view.oy) * k };
}

/** Converts a client-space point to cell space, keeping the fractional position for snapping. */
export function toCell(view: View, rect: { left: number; top: number }, clientX: number, clientY: number) {
  const gx = (clientX - rect.left - view.ox) / view.s;
  const gz = (clientY - rect.top - view.oy) / view.s;
  return { x: Math.floor(gx), z: Math.floor(gz), gx, gz };
}

export function insideLayout(data: Layout, cell: { x: number; z: number }): boolean {
  return cell.x >= 0 && cell.z >= 0 && cell.x < data.size.x && cell.z < data.size.z;
}
