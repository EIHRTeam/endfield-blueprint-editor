/** Rectangular selection and reusable, local-coordinate blueprint fragments. */
import { bounds, clone, footprint } from './geometry';
import type { BlueprintNode, Bounds, BuildingIndex, Conveyor, Direction, Layout, Point, Size } from './types';
import { validate } from './validate';

export interface Selection {
  nodeIndices: number[];
  conveyorIndices: number[];
}

export interface BlueprintFragment {
  size: Size;
  nodes: BlueprintNode[];
  conveyors: Conveyor[];
}

/** End cells are included; callers can drag in either direction. */
export function selectionBounds(start: Point, end: Point): Bounds {
  return {
    x0: Math.min(start.x, end.x),
    z0: Math.min(start.z, end.z),
    x1: Math.max(start.x, end.x) + 1,
    z1: Math.max(start.z, end.z) + 1,
  };
}

/** Devices must be fully enclosed; a selection never cuts a device in half. */
export function selectRegion(layout: Layout, buildings: BuildingIndex, area: Bounds): Selection {
  return {
    nodeIndices: layout.nodes.flatMap((node, index) => {
      const f = footprint(node, buildings);
      return f.x0 >= area.x0 && f.z0 >= area.z0 && f.x0 + f.w <= area.x1 && f.z0 + f.d <= area.z1 ? [index] : [];
    }),
    conveyorIndices: layout.conveyors.flatMap((belt, index) =>
      belt.x >= area.x0 && belt.z >= area.z0 && belt.x < area.x1 && belt.z < area.z1 ? [index] : [],
    ),
  };
}

/** Copies only content and drops pairing metadata when the other endpoint was not selected. */
export function copyFragment(layout: Layout, buildings: BuildingIndex, selection?: Selection): BlueprintFragment {
  const nodes = clone(
    selection ? selection.nodeIndices.map(index => layout.nodes[index]).filter(Boolean) : layout.nodes,
  );
  const conveyors = clone(
    selection ? selection.conveyorIndices.map(index => layout.conveyors[index]).filter(Boolean) : layout.conveyors,
  );
  if (!nodes.length && !conveyors.length) throw Error('选区内没有完整设备或线路');
  const pairCounts = new Map<string, number>();
  for (const node of nodes) {
    if (node.undergroundPair) pairCounts.set(node.undergroundPair, (pairCounts.get(node.undergroundPair) ?? 0) + 1);
  }
  for (const node of nodes) {
    if (node.undergroundPair && pairCounts.get(node.undergroundPair) !== 2) delete node.undergroundPair;
  }
  const b = bounds({ ...layout, nodes, conveyors }, buildings, 0);
  for (const node of nodes) {
    node.position.x -= b.x0;
    node.position.z -= b.z0;
  }
  for (const belt of conveyors) {
    belt.x -= b.x0;
    belt.z -= b.z0;
  }
  return { size: { x: b.x1 - b.x0, z: b.z1 - b.z0 }, nodes, conveyors };
}

/** Clockwise rotation preserves rectangular footprints and line entry/exit headings. */
export function rotateFragment(fragment: BlueprintFragment, buildings: BuildingIndex): BlueprintFragment {
  const rotated = clone(fragment);
  rotated.size = { x: fragment.size.z, z: fragment.size.x };
  for (const node of rotated.nodes) {
    const f = footprint(node, buildings);
    node.position = { x: fragment.size.z - f.z0 - f.d, z: f.x0 };
    node.direction = ((node.direction + 1) % 4) as Direction;
  }
  for (const belt of rotated.conveyors) {
    [belt.x, belt.z] = [fragment.size.z - belt.z - 1, belt.x];
    belt.dir = ((belt.dir + 1) % 4) as Direction;
    if (belt.fromDir != null) belt.fromDir = ((belt.fromDir + 1) % 4) as Direction;
  }
  return rotated;
}

/** A preview uses the same offset and fresh pair IDs as the eventual transaction. */
export function fragmentAt(
  fragment: BlueprintFragment,
  point: Point,
  existing: BlueprintNode[] = [],
): BlueprintFragment {
  const placed = clone(fragment);
  const occupiedPairs = new Set(existing.map(node => node.undergroundPair).filter(Boolean));
  const remappedPairs = new Map<string, string>();
  let serial = 1;
  for (const node of placed.nodes) {
    node.position.x += point.x;
    node.position.z += point.z;
    if (!node.undergroundPair) continue;
    const original = node.undergroundPair;
    if (!remappedPairs.has(original)) {
      while (occupiedPairs.has(`pipe-${serial}`)) serial++;
      const pair = `pipe-${serial++}`;
      occupiedPairs.add(pair);
      remappedPairs.set(original, pair);
    }
    node.undergroundPair = remappedPairs.get(original)!;
  }
  for (const belt of placed.conveyors) {
    belt.x += point.x;
    belt.z += point.z;
  }
  return placed;
}

/** Validates the whole addition before returning anything; the original never changes on failure. */
export function mergeFragment(
  layout: Layout,
  fragment: BlueprintFragment,
  point: Point,
  buildings: BuildingIndex,
): Layout {
  if (!fragment.nodes.length && !fragment.conveyors.length) throw Error('没有可粘贴的内容');
  const placed = fragmentAt(fragment, point, layout.nodes);
  return validate(
    { ...layout, nodes: [...layout.nodes, ...placed.nodes], conveyors: [...layout.conveyors, ...placed.conveyors] },
    buildings,
  );
}
