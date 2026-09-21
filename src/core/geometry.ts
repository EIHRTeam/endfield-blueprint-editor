/**
 * Pure geometry over a blueprint layout. No DOM, no React, no canvas.
 *
 * Ported from the previous `editor_core.js` with byte-identical behaviour so the Playwright
 * regression suite keeps asserting the same numbers.
 */
import type {
  Bounds,
  Building,
  BuildingIndex,
  Direction,
  Extent,
  Footprint,
  Layout,
  Point,
  RoutedConveyor,
} from './types';

/** Direction vectors, indexed by direction: 0 = right (+x), 1 = down (+z), 2 = left, 3 = up. */
export const DV: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/**
 * Corner sprite lookup: `CORNER[incoming][outgoing] = [variant, rotationDegrees]`.
 * A missing pair means the two directions are collinear and the straight grid sprite is used.
 */
export const CORNER: Record<number, Record<number, [number, number]>> = {
  0: { 3: [1, 180], 1: [2, 270] },
  1: { 0: [1, 90], 2: [2, 180] },
  2: { 1: [1, 0], 3: [2, 90] },
  3: { 2: [1, 270], 0: [2, 0] },
};

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function key(x: number, z: number): string {
  return `${x},${z}`;
}

/** Unique identity of a conveyor cell: two layers of the same kind cannot share a cell. */
export function beltKey(belt: { kind: string; x: number; z: number }): string {
  return `${belt.kind}:${belt.x},${belt.z}`;
}

/** Footprint of a device rotated into its actual orientation. */
export function dims(building: Building, direction: Direction | number = 0): Extent {
  return direction % 2 ? { w: building.d, d: building.w } : { w: building.w, d: building.d };
}

/** Absolute cell rectangle occupied by a node. */
export function footprint(
  node: { position?: Point; direction?: Direction | number; templateId: string },
  buildings: BuildingIndex,
): Footprint {
  const size = dims(buildings[node.templateId]!, node.direction ?? 0);
  const position = node.position!;
  return { x0: position.x, z0: position.z, w: size.w, d: size.d, x1: 0, z1: 0 } as Footprint;
}

/** Index of the device covering the given cell, or -1. */
export function hit(nodes: Layout['nodes'], buildings: BuildingIndex, x: number, z: number): number {
  return nodes.findIndex(node => {
    const f = footprint(node, buildings);
    return x >= f.x0 && z >= f.z0 && x < f.x0 + f.w && z < f.z0 + f.d;
  });
}

/**
 * Why a node cannot be placed at its current position, or '' when it is fine.
 *
 * Existing routes are deliberately preserved when moving a device: topology is the user's layout
 * and the tool never rewrites belts behind the user's back.
 */
export function placementError(
  data: Layout,
  buildings: BuildingIndex,
  node: { position: Point; direction?: Direction | number; templateId: string },
  ignore = -1,
): string {
  const f = footprint(node, buildings);
  if (f.x0 < 0 || f.z0 < 0 || f.x0 + f.w > data.size.x || f.z0 + f.d > data.size.z) return '超出蓝图边界';
  for (let i = 0; i < data.nodes.length; i++) {
    if (i === ignore) continue;
    const q = footprint(data.nodes[i]!, buildings);
    if (f.x0 < q.x0 + q.w && f.x0 + f.w > q.x0 && f.z0 < q.z0 + q.d && f.z0 + f.d > q.z0) return '与其他设备重叠';
  }
  return '';
}

/** Bounding box of everything placed, padded by `margin` and clamped to the blueprint. */
export function bounds(data: Layout, buildings: BuildingIndex, margin = 1): Bounds {
  let x0 = data.size.x,
    z0 = data.size.z,
    x1 = 0,
    z1 = 0;
  for (const node of data.nodes) {
    const f = footprint(node, buildings);
    x0 = Math.min(x0, f.x0);
    z0 = Math.min(z0, f.z0);
    x1 = Math.max(x1, f.x0 + f.w);
    z1 = Math.max(z1, f.z0 + f.d);
  }
  for (const belt of data.conveyors) {
    x0 = Math.min(x0, belt.x);
    z0 = Math.min(z0, belt.z);
    x1 = Math.max(x1, belt.x + 1);
    z1 = Math.max(z1, belt.z + 1);
  }
  if (!data.nodes.length && !data.conveyors.length) {
    return { x0: 0, z0: 0, x1: data.size.x, z1: data.size.z };
  }
  return {
    x0: Math.max(0, x0 - margin),
    z0: Math.max(0, z0 - margin),
    x1: Math.min(data.size.x, x1 + margin),
    z1: Math.min(data.size.z, z1 + margin),
  };
}

/** Every cell covered by a non-logistic device. Conveyors may cross these layers later. */
export function buildingCells(layout: Layout, buildings: BuildingIndex): Set<string> {
  const occupied = new Set<string>();
  for (const node of layout.nodes) {
    if (buildings[node.templateId]!.logistic) continue;
    const f = footprint(node, buildings);
    for (let z = f.z0; z < f.z0 + f.d; z++) {
      for (let x = f.x0; x < f.x0 + f.w; x++) occupied.add(key(x, z));
    }
  }
  return occupied;
}

/** Compass heading from `a` to an orthogonally adjacent `b`. */
function heading(a: Point, b: Point): Direction {
  return (b.x > a.x ? 0 : b.x < a.x ? 2 : b.z > a.z ? 1 : 3) as Direction;
}

/** Axis-aligned L route between two cells, walking one axis fully at a time. */
export function route(
  start: Point,
  end: Point,
  kind: string,
  verticalFirst = false,
  defaultDir: Direction = 0,
): Array<{ x: number; z: number; kind: string; dir: number; fromDir?: number }> {
  const points: Point[] = [{ x: start.x, z: start.z }];
  const cursor = { ...start };
  for (const axis of (verticalFirst ? ['z', 'x'] : ['x', 'z']) as Array<'x' | 'z'>) {
    while (cursor[axis] !== end[axis]) {
      cursor[axis] += Math.sign(end[axis] - cursor[axis]);
      points.push({ ...cursor });
    }
  }

  return points.map((p, i) => {
    const belt: { x: number; z: number; kind: string; dir: number; fromDir?: number } = {
      x: p.x,
      z: p.z,
      kind,
      dir: i + 1 < points.length ? heading(p, points[i + 1]!) : i ? heading(points[i - 1]!, p) : defaultDir,
    };
    if (i) belt.fromDir = heading(points[i - 1]!, p);
    return belt;
  });
}

/** Picks the straight or corner sprite for each conveyor cell and its rotation. */
export function conveyorSprites(
  belts: Array<{ kind: string; x: number; z: number; dir: number; fromDir?: number }>,
): RoutedConveyor[] {
  const incoming = new Map<string, number[]>();
  for (const belt of belts) {
    const v = DV[belt.dir]!;
    const k = `${belt.kind}:${belt.x + v[0]},${belt.z + v[1]}`;
    if (!incoming.has(k)) incoming.set(k, []);
    incoming.get(k)!.push(belt.dir);
  }
  return belts.map(belt => {
    const choices = incoming.get(beltKey(belt)) || [];
    const from = belt.fromDir ?? (choices.length === 1 ? choices[0]! : belt.dir);
    const start = (from + 1) % 4;
    const end = (belt.dir + 1) % 4;
    const type = belt.kind === 'fluid' ? 'pipe' : 'belt';
    const routed = Object.assign({}, belt) as RoutedConveyor;
    if (start === end || !CORNER[start]?.[end]) {
      routed.sprite = `icon_${type}_grid`;
      routed.angle = end * 90 - 90;
      return routed;
    }
    const [variant, rotation] = CORNER[start]![end]!;
    routed.sprite = `icon_${type}_corner_${variant}`;
    routed.angle = -rotation;
    return routed;
  });
}

/**
 * Undo/redo over JSON snapshots.
 *
 * Snapshots are serialized so a later mutation of the live document can never corrupt history.
 */
export class History {
  readonly limit: number;
  past: string[] = [];
  future: string[] = [];

  constructor(limit = 100) {
    this.limit = limit;
  }

  commit(before: unknown, after: unknown): boolean {
    const a = JSON.stringify(before);
    const b = JSON.stringify(after);
    if (a === b) return false;
    this.past.push(a);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    return true;
  }

  undo<T>(current: T): T {
    if (!this.past.length) return current;
    this.future.push(JSON.stringify(current));
    return JSON.parse(this.past.pop()!) as T;
  }

  redo<T>(current: T): T {
    if (!this.future.length) return current;
    this.past.push(JSON.stringify(current));
    return JSON.parse(this.future.pop()!) as T;
  }
}
