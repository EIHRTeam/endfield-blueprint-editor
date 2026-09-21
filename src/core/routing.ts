/**
 * Belt and pipe routing.
 *
 * Routing is purely geometric: endpoints snap to real device ports, the path avoids device
 * footprints, and a breadth-first search finds a detour when the direct L route is blocked. There
 * is no production, throughput or admission simulation.
 *
 * Ported from the previous `editor_core.js` with identical behaviour, including error messages.
 */
import { DV, beltKey, buildingCells, footprint, hit, key, route } from './geometry';
import type { BuildingIndex, Conveyor, Direction, Layout, PortKind, RouteResult, WorldPort } from './types';

/**
 * Every visible port of a node, in absolute cell coordinates.
 *
 * Ports are rotated with the device, snapped to the footprint edge even when the source transform
 * is inset, and filtered by the item-interface mode and the per-port visibility marks.
 */
export function worldPorts(
  node: { templateId: string; direction?: Direction | number; formulaMode?: string; closedPorts?: string[] },
  buildings: BuildingIndex,
): WorldPort[] {
  const building = buildings[node.templateId]!;
  const f = footprint(node, buildings);
  const direction = (node.direction ?? 0) as Direction;

  return (building.ports || [])
    .filter(port => !(port.pipe && node.formulaMode === 'normal') && !node.closedPorts?.includes(port.id))
    .map(port => {
      let x = port.x;
      let z = port.z;
      let dir = port.dir;
      let w = building.w;
      let d = building.d;
      for (let turn = 0; turn < direction; turn++) {
        [x, z] = [d - 1 - z, x];
        [w, d] = [d, w];
        dir = ((dir + 1) % 4) as Direction;
      }
      x += f.x0;
      z += f.z0;
      // Ports sit on the footprint edge, even when the source transform is inset.
      if (dir === 0) x = f.x0 + f.w - 1;
      if (dir === 2) x = f.x0;
      if (dir === 1) z = f.z0 + f.d - 1;
      if (dir === 3) z = f.z0;
      const [dx, dz] = DV[dir]!;
      const world = Object.assign({}, port) as WorldPort;
      world.x = x;
      world.z = z;
      world.dir = dir;
      world.edgeX = x + 0.5 + dx * 0.5;
      world.edgeZ = z + 0.5 + dz * 0.5;
      world.outX = x + dx;
      world.outZ = z + dz;
      return world;
    });
}

/**
 * Resolves which port a drag endpoint should connect to.
 *
 * Dragging from inside a device snaps to that device's nearest matching port; dragging onto a free
 * cell snaps to any port whose outward neighbour is that cell.
 */
export function routeEndpoint(
  layout: Layout,
  buildings: BuildingIndex,
  point: { x: number; z: number; gx?: number; gz?: number },
  kind: PortKind,
  start: boolean,
): { x: number; z: number; port?: WorldPort } {
  const index = hit(layout.nodes, buildings, point.x, point.z);
  const inside = index >= 0 && !buildings[layout.nodes[index]!.templateId]!.logistic;

  const candidates: Array<WorldPort & { score: number; nodeIndex: number }> = [];
  layout.nodes.forEach((node, i) => {
    if (buildings[node.templateId]!.logistic || (inside && i !== index)) return;
    for (const port of worldPorts(node, buildings)) {
      if (port.pipe !== (kind === 'fluid')) continue;
      if (!inside && (port.outX !== point.x || port.outZ !== point.z)) continue;
      const distance = Math.hypot((point.gx ?? point.x + 0.5) - port.edgeX, (point.gz ?? point.z + 0.5) - port.edgeZ);
      // A tiny bias keeps the drag start from snapping back onto the port it came from.
      candidates.push(Object.assign({}, port, { score: distance + (port.input === start ? 0.05 : 0), nodeIndex: i }));
    }
  });
  candidates.sort((a, b) => a.score - b.score);

  if (inside && !candidates.length) {
    throw Error(`该设备没有可见的${kind === 'fluid' ? '流体' : '物品'}接口`);
  }
  const port = candidates[0];
  return port ? { x: port.outX, z: port.outZ, port } : { x: point.x, z: point.z };
}

/**
 * Builds a route between two endpoints, snapping both to ports and detouring around devices.
 *
 * Tries the two L-shaped paths first (cheap and what users expect), then falls back to a
 * breadth-first search over free cells.
 */
export function connectedRoute(
  layout: Layout,
  buildings: BuildingIndex,
  start: { x: number; z: number; gx?: number; gz?: number },
  end: { x: number; z: number; gx?: number; gz?: number },
  kind: PortKind,
  verticalFirst = false,
  defaultDir: Direction = 0,
): RouteResult {
  const a = routeEndpoint(layout, buildings, start, kind, true);
  const b = routeEndpoint(layout, buildings, end, kind, false);

  const occupied = buildingCells(layout, buildings);
  const free = (p: { x: number; z: number }) =>
    p.x >= 0 && p.z >= 0 && p.x < layout.size.x && p.z < layout.size.z && !occupied.has(key(p.x, p.z));

  if (!free(a) || !free(b)) throw Error('接口外侧没有可用格，请移动设备或从其他接口铺线');

  const existing = layout.conveyors.find(belt => belt.kind === kind && belt.x === b.x && belt.z === b.z);
  const endDir = b.port ? (((b.port.dir + 2) % 4) as Direction) : existing?.dir;
  const startDir = a.port?.dir;

  function decorate(path: Conveyor[]): Conveyor[] {
    if (startDir != null) path[0]!.fromDir = startDir as Direction;
    if (endDir != null) path[path.length - 1]!.dir = endDir;
    return path;
  }

  const valid = (path: Conveyor[]) => path.every(p => free(p) && (p.fromDir == null || (p.fromDir + 2) % 4 !== p.dir));

  for (const vFirst of [verticalFirst, !verticalFirst]) {
    const path = decorate(route(a, b, kind, vFirst, defaultDir) as Conveyor[]);
    if (valid(path)) return { path, start: a, end: b };
  }

  // Shortest grid path around device footprints; still no production or admission simulation.
  const queue: Array<{ x: number; z: number; dir?: number; parent: number }> = [
    { x: a.x, z: a.z, dir: startDir, parent: -1 },
  ];
  const seen = new Set<string>([key(a.x, a.z)]);
  const priority = verticalFirst ? [1, 3, 0, 2] : [0, 2, 1, 3];

  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!;

    if (current.x === b.x && current.z === b.z) {
      const points: Array<{ x: number; z: number; dir?: number }> = [];
      for (let i: number = head; i >= 0; i = queue[i]!.parent) points.push(queue[i]!);
      points.reverse();
      const path: Conveyor[] = points.map((p, j) => {
        const belt: Conveyor = {
          x: p.x,
          z: p.z,
          kind,
          dir: (points[j + 1]?.dir ?? endDir ?? p.dir ?? defaultDir) as Direction,
        };
        if (j) belt.fromDir = p.dir as Direction;
        return belt;
      });
      decorate(path);
      if (!valid(path)) throw Error('请从接口拖向另一格，单格线路不能掉头');
      return { path, start: a, end: b };
    }

    const directions = [...new Set([current.dir, ...priority])].filter((d): d is number => d != null);
    for (const dir of directions) {
      if (head === 0 && startDir != null && dir === (startDir + 2) % 4) continue;
      const p = { x: current.x + DV[dir]![0], z: current.z + DV[dir]![1] };
      if (!free(p) || seen.has(key(p.x, p.z))) continue;
      if (p.x === b.x && p.z === b.z && endDir != null && (dir + 2) % 4 === endDir) continue;
      seen.add(key(p.x, p.z));
      queue.push({ ...p, dir, parent: head });
    }
  }
  throw Error('设备之间没有可铺设的路径，请调整端点');
}

/**
 * Replaces the cells covered by `addition`, preserving the incoming direction of the cell that was
 * already there so a re-drawn first segment keeps its corner.
 */
export function mergeRoutes(existing: Conveyor[], addition: Conveyor[]): Conveyor[] {
  const keys = new Set(addition.map(beltKey));
  const next = JSON.parse(JSON.stringify(addition)) as Conveyor[];
  const previous = existing.find(belt => beltKey(belt) === beltKey(next[0] ?? ({} as Conveyor)));
  if (previous?.fromDir != null && next[0]?.fromDir == null && (previous.fromDir + 2) % 4 !== next[0]!.dir) {
    next[0]!.fromDir = previous.fromDir;
  }
  return existing.filter(belt => !keys.has(beltKey(belt))).concat(next);
}
