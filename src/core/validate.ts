/**
 * Blueprint document validation and normalization.
 *
 * This is the single gate for every document that enters the editor: localStorage restore, JSON
 * import and the bundled examples. It is deliberately permissive about unknown fields (they are
 * preserved so a newer document round-trips) and strict about anything the editor relies on.
 *
 * Ported from the previous `editor_core.js` with byte-identical error strings: they are shown to the
 * user verbatim and are asserted by the regression suite.
 */
import { beltKey, clone, placementError } from './geometry';
import { undergroundRole } from './underground';
import type { BlueprintNode, BuildingIndex, Conveyor, Direction, Layout, PresentationDetails } from './types';

const ENVIRONMENT_EFFECTS: ReadonlySet<string> = new Set(['', 'acid', 'humidity', 'inactive', 'stable', 'xiranite']);
const ITEM_STATUSES: ReadonlySet<string> = new Set(['normal', 'locked', 'limited', 'expired']);
const COVER_COLORS: ReadonlySet<string> = new Set(['blue', 'cyan', 'yellow', 'green', 'purple', 'orange', 'gray']);
const LINE_KINDS: ReadonlySet<string> = new Set(['item', 'fluid']);

/** Maximum number of devices in one blueprint. */
export const MAX_NODES = 160;
/** Maximum blueprint edge length, in cells. */
export const MAX_SIZE = 50;

/**
 * Validates a raw document and returns a normalized deep copy.
 *
 * The input is never mutated. Unknown fields survive the round trip.
 *
 * @throws Error with a user-facing Chinese message when the document is unusable.
 */
export function validate(input: unknown, buildings: BuildingIndex): Layout {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('蓝图必须是 JSON 对象');
  const source = input as Record<string, unknown>;
  if (source.schemaVersion != null && source.schemaVersion !== 2) throw Error('不支持此蓝图文件版本');

  const data = clone(source) as unknown as Layout;

  if (data.name == null) data.name = '未命名蓝图';
  if (typeof data.name !== 'string' || data.name.length > 120) throw Error('蓝图名称格式不正确');

  if (data.presentation != null) validatePresentation(data.presentation);

  if (data.size === undefined) data.size = { x: 50, z: 50 };
  if (!data.size || typeof data.size !== 'object' || Array.isArray(data.size)) throw Error('蓝图尺寸格式不正确');
  for (const axis of ['x', 'z'] as const) {
    const value = (data.size as unknown as Record<string, unknown>)[axis];
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_SIZE) {
      throw Error('蓝图宽、高必须为 1–50 格');
    }
  }

  if (data.nodes === undefined) data.nodes = [];
  if (data.conveyors === undefined) data.conveyors = [];
  if (!Array.isArray(data.nodes) || !Array.isArray(data.conveyors)) throw Error('nodes / conveyors 必须为数组');
  if (data.nodes.length > MAX_NODES) throw Error('设备数量不能超过 160');
  if (data.conveyors.length > data.size.x * data.size.z * 2) throw Error('线路数量超过网格容量');

  data.nodes.forEach((node, i) => validateNode(data, buildings, node, i));
  validatePairs(data.nodes);
  // Occupied cells grow as conveyors are validated, so a duplicate is reported on the later cell.
  const occupied = new Set<string>();
  data.conveyors.forEach((belt, i) => validateConveyor(data, belt, i, occupied));

  data.schemaVersion = 2;
  return data;
}

function validatePresentation(presentation: unknown): void {
  const p = presentation as Partial<PresentationDetails>;
  if (typeof p !== 'object' || p === null || Array.isArray(p)) throw Error('蓝图详情格式不正确');

  for (const [field, limit] of [
    ['creatorId', 40],
    ['description', 400],
    ['coverId', 160],
  ] as const) {
    const value = (p as Record<string, unknown>)[field];
    if (value != null && (typeof value !== 'string' || value.length > limit))
      throw Error('蓝图详情文字过长或格式不正确');
  }
  if (
    p.tags != null &&
    (!Array.isArray(p.tags) ||
      p.tags.length > 6 ||
      p.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 16))
  ) {
    throw Error('最多 6 个标签，每个标签 1–16 个字符');
  }
  if (p.coverColor != null && !COVER_COLORS.has(p.coverColor)) throw Error('未知的封面底色');
  if (p.showChangeHints != null && typeof p.showChangeHints !== 'boolean') throw Error('图标角标开关无效');
  if (p.connectionPair != null && (typeof p.connectionPair !== 'string' || p.connectionPair.length > 120)) {
    throw Error('暗管连接示意标记无效');
  }
  if (p.viewport != null) {
    const v = p.viewport;
    if (
      typeof v !== 'object' ||
      v === null ||
      Array.isArray(v) ||
      !Number.isFinite(v.zoom) ||
      v.zoom < 1 ||
      v.zoom > 4 ||
      !Number.isFinite(v.x) ||
      v.x < 0 ||
      v.x > 1 ||
      !Number.isFinite(v.y) ||
      v.y < 0 ||
      v.y > 1
    ) {
      throw Error('预览取景参数无效');
    }
  }
}

function validateNode(data: Layout, buildings: BuildingIndex, node: BlueprintNode, i: number): void {
  if (!node || typeof node.templateId !== 'string' || !Object.hasOwn(buildings, node.templateId)) {
    throw Error(`第 ${i + 1} 个设备 ID 未知：${node?.templateId}`);
  }
  if (!node.position || !Number.isInteger(node.position.x) || !Number.isInteger(node.position.z)) {
    throw Error(`第 ${i + 1} 个设备坐标必须是整数`);
  }
  node.direction = (node.direction ?? 0) as Direction;
  if (!Number.isInteger(node.direction) || node.direction < 0 || node.direction > 3) {
    throw Error(`第 ${i + 1} 个设备朝向必须为 0–3`);
  }
  if (node.productIcon != null && typeof node.productIcon !== 'string') throw Error('产物图标必须是字符串或 null');
  if (node.formulaMode != null && typeof node.formulaMode !== 'string') throw Error('配方模式格式不正确');
  if (node.environmentEffect != null && !ENVIRONMENT_EFFECTS.has(node.environmentEffect)) {
    throw Error('未知的环境生效标记');
  }
  if (node.itemStatus != null && !ITEM_STATUSES.has(node.itemStatus)) throw Error('未知的物品状态标记');
  if (
    node.itemStatusColor != null &&
    (typeof node.itemStatusColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(node.itemStatusColor))
  ) {
    throw Error('物品状态颜色格式不正确');
  }

  const building = buildings[node.templateId]!;
  const ports = building.ports || [];
  if (
    node.closedPorts != null &&
    (!Array.isArray(node.closedPorts) ||
      node.closedPorts.length > ports.length ||
      node.closedPorts.some(id => !ports.some(port => port.id === id)))
  ) {
    throw Error('接口显示标记无效');
  }
  if (node.closedPorts?.length && building.editablePorts === false) throw Error('该设备不支持逐个隐藏接口');

  const error = placementError(data, buildings, node, i);
  if (error) throw Error(`第 ${i + 1} 个设备${error}`);
}

function validatePairs(nodes: BlueprintNode[]): void {
  const pairs = new Map<string, BlueprintNode[]>();
  for (const node of nodes) {
    if (node.undergroundPair == null) continue;
    if (
      !undergroundRole(node) ||
      typeof node.undergroundPair !== 'string' ||
      !node.undergroundPair.length ||
      node.undergroundPair.length > 120
    ) {
      throw Error('暗管配对标记无效');
    }
    if (!pairs.has(node.undergroundPair)) pairs.set(node.undergroundPair, []);
    pairs.get(node.undergroundPair)!.push(node);
  }
  for (const pair of pairs.values()) {
    if (pair.length !== 2 || undergroundRole(pair[0]!) === undergroundRole(pair[1]!)) {
      throw Error('暗管配对必须恰好包含一个入口和一个出口');
    }
  }
}

function validateConveyor(data: Layout, belt: Conveyor, i: number, occupied: Set<string>): void {
  if (
    !belt ||
    !Number.isInteger(belt.x) ||
    !Number.isInteger(belt.z) ||
    belt.x < 0 ||
    belt.z < 0 ||
    belt.x >= data.size.x ||
    belt.z >= data.size.z
  ) {
    throw Error(`第 ${i + 1} 段线路越界或坐标无效`);
  }
  belt.kind = belt.kind || 'item';
  if (!LINE_KINDS.has(belt.kind)) throw Error(`尚无已核实的线路素材：${belt.kind}`);
  for (const field of ['dir', 'fromDir'] as const) {
    if (
      (field === 'dir' || belt[field] != null) &&
      (!Number.isInteger(belt[field]) || (belt[field] as number) < 0 || (belt[field] as number) > 3)
    ) {
      throw Error('线路方向必须为 0–3');
    }
  }
  if (belt.fromDir != null && (belt.fromDir + 2) % 4 === belt.dir) throw Error('单格线路不能原地掉头');

  const cell = beltKey(belt);
  if (occupied.has(cell)) throw Error('同一格有重复的同类线路');
  occupied.add(cell);
}
