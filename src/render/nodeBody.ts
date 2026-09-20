/**
 * Composes a device's visible body for one orientation.
 *
 * Most devices reuse a pre-composed face. Devices with per-port visibility need their edges redrawn,
 * because hiding an interface removes its stub from the body artwork. Those are composed once per
 * distinct portrait and cached.
 *
 * Ported from the previous `editor_app.js` (`portGroups`/`nodeBody`) with identical output.
 */
import type { BlueprintNode, Building, BuildingIndex, Direction } from '../core/types';
import type { AssetStore } from './assets';

/** One edge's worth of visible ports: which side, which layer, and where along the side. */
export interface PortGroup {
  edge: number;
  pipe: boolean;
  input: boolean;
  positions: number[];
}

/**
 * Groups a node's *visible* ports by the footprint edge they sit on.
 *
 * Ports on the same edge with the same kind and direction collapse into one sprite stamp, which is
 * what lets a run of two adjacent ports use the "2-wide" original sprite instead of two stamps.
 */
export function portGroups(building: Building, node: BlueprintNode): PortGroup[] {
  const groups = new Map<string, PortGroup>();
  for (const port of building.ports) {
    if (node.closedPorts?.includes(port.id)) continue;
    if (node.formulaMode === 'normal' && port.pipe) continue;
    const key = `${port.edge}:${port.pipe}:${port.input}`;
    if (!groups.has(key)) {
      groups.set(key, { edge: port.edge, pipe: port.pipe, input: port.input, positions: [] });
    }
    groups.get(key)!.positions.push(port.along);
  }
  const ordered = [...groups.values()].map(group => {
    const copy: PortGroup = {
      edge: group.edge,
      pipe: group.pipe,
      input: group.input,
      positions: group.positions.toSorted((a, b) => a - b),
    };
    return copy;
  });
  return ordered.toSorted(
    (a, b) => a.edge - b.edge || Number(a.pipe) - Number(b.pipe) || Number(b.input) - Number(a.input),
  );
}

/** The pre-composed face key for a node, honouring the item-interface mode. */
export function bodyKey(node: BlueprintNode, buildings: BuildingIndex): string {
  const building = buildings[node.templateId]!;
  const faces = node.formulaMode === 'normal' ? building.normalFaces : building.faces;
  return faces[node.direction ?? 0]!;
}

/** A body may be a decoded image or a canvas composed on the fly. Both are drawable. */
export type DrawableBody = HTMLCanvasElement | HTMLImageElement | ImageBitmap;

/**
 * The drawable body for a node.
 *
 * Returns the shared pre-composed face unless the node hides individual ports, in which case a
 * cached composition is built from the bare (port-free) face plus the visible port stubs and edge
 * decoration.
 */
export function nodeBody(
  node: BlueprintNode,
  buildings: BuildingIndex,
  assets: AssetStore,
  sprites: Record<string, string>,
): DrawableBody | null {
  const building = buildings[node.templateId]!;
  const direction = (node.direction ?? 0) as Direction;

  if (!node.closedPorts?.length || !building.editablePorts) return assets.get(bodyKey(node, buildings));

  const cacheKey = `${node.templateId}/${direction}/${node.formulaMode}/${node.closedPorts.toSorted().join(',')}`;
  const cached = assets.bodyCache(cacheKey);
  if (cached) return cached;

  const groups = portGroups(building, node);
  const present = new Set(groups.map(group => group.edge));
  const source = !present.has(1) && !present.has(3) ? building.waistFaces : building.bareFaces;
  const base = assets.get(source?.[direction]);
  const decoration = assets.get(building.edgeDecoration);
  if (!base || !decoration) return null;

  const out = document.createElement('canvas');
  out.width = base.width;
  out.height = base.height;
  const c = out.getContext('2d')!;
  c.drawImage(base, 0, 0);

  // Work in unrotated device-local space: the face artwork is drawn pre-rotated, so the decoration
  // and port stubs are placed relative to the device's own footprint.
  c.translate(out.width / 2, out.height / 2);
  c.rotate((direction * Math.PI) / 2);
  c.translate(-building.w * 64, -building.d * 64);

  function edge(image: CanvasImageSource, face: number, along: number, width: number, height: number) {
    c.save();
    if (face === 0) c.translate(Math.round(along - width / 2), 0);
    if (face === 1) {
      c.translate(building.w * 128, Math.round(building.d * 128 - along - width / 2));
      c.rotate(Math.PI / 2);
    }
    if (face === 2) {
      c.translate(Math.round(along + width / 2), building.d * 128);
      c.rotate(Math.PI);
    }
    if (face === 3) {
      c.translate(0, Math.round(building.d * 128 - along + width / 2));
      c.rotate(-Math.PI / 2);
    }
    c.drawImage(image, 0, 0, width, height);
    c.restore();
  }

  for (const group of groups) {
    const positions = group.positions;
    const count = positions.length;
    const prefix = (group.pipe ? 'pipe_' : '') + (group.input ? 'port_in_' : 'port_out_');
    // A contiguous run can use the original N-wide sprite; otherwise stamp each port individually.
    const grouped = count === positions.at(-1)! - positions[0]! + 1 && sprites[prefix + count];
    const image = assets.get(grouped ? sprites[prefix + count] : sprites[`${prefix}1`]);
    if (!image) return null;
    if (grouped) {
      edge(image, group.edge, (positions[0]! + positions.at(-1)! + 1) * 64, image.width, image.height);
    } else {
      for (const position of positions) edge(image, group.edge, (position + 0.5) * 128, image.width, image.height);
    }
  }

  for (const face of [0, 2]) {
    if (!present.has(face)) edge(decoration, face, building.w * 64, decoration.width, decoration.height);
  }

  assets.cacheBody(cacheKey, out);
  return out;
}
