/**
 * Data model shared by the editor, the canvas renderer and the Pyodide baking layer.
 *
 * The blueprint document schema is version 2 and unchanged from the previous implementation: the
 * JSON written by "save" stays byte-compatible, so existing drafts and the bundled examples keep
 * working. Everything else here describes the *runtime* payload that the baking worker produces.
 */

/** 0 = native, 1/2/3 = 90/180/270 degrees clockwise. */
export type Direction = 0 | 1 | 2 | 3;

export type PortKind = 'item' | 'fluid';

export type EnvironmentEffect = '' | 'acid' | 'humidity' | 'inactive' | 'stable' | 'xiranite';

export type ItemStatus = 'normal' | 'locked' | 'limited' | 'expired';

export interface Point {
  x: number;
  z: number;
}

export interface Size {
  x: number;
  z: number;
}

/** Rotated device extent, in cells. Deliberately distinct from `Size` (blueprint dimensions). */
export interface Extent {
  w: number;
  d: number;
}

/** A port as baked from the game's prefab transform, in device-local cell space. */
export interface BuildingPort {
  /** Port index inside the device table. */
  n: number;
  input: boolean;
  pipe: boolean;
  /** Device-local cell coordinates, already flipped for PNG space. */
  x: number;
  z: number;
  /** Outward facing direction, 0/1/2/3. */
  dir: Direction;
  /** Footprint edge the port sits on. */
  edge: number;
  /** Offset along that edge. */
  along: number;
  /** Distance from the footprint edge to the visible port, in fractional cells. */
  inset: number;
  /** Stable identifier used by `closedPorts`. */
  id: string;
}

/** A device (or logistics node) as produced by the baking worker. */
export interface Building {
  id: string;
  name: string;
  w: number;
  d: number;
  /** Four directions of the composed body *including* the central symbol. */
  faces: string[];
  /** Four directions of the body without the central symbol (item-interface mode). */
  normalFaces: string[];
  symbol: string | null;
  palette: string;
  itemId: string;
  rarity: number;
  rarityColor: string;
  ports: BuildingPort[];
  products: string[];
  editablePorts?: boolean;
  bareFaces?: string[];
  waistFaces?: string[];
  edgeDecoration?: string | null;
  underground?: boolean;
  canModify?: boolean;
  logistic?: boolean;
  connectionFrames?: string[];
  activeConnectionFrames?: string[];
}

/** A placeable product / environment record used by the icon library. */
export interface Product {
  name: string;
  badge: string | null;
  rarity?: number;
  factory?: boolean;
  phase?: number;
  unloader?: boolean;
  /** `available` | `missing` | `empty_icon_configuration` | `same_id_original_sprite`. */
  iconStatus?: string;
  gas?: boolean;
  contentId?: string;
}

export interface LineItem {
  id: string;
  name: string;
  palette: string;
  rarityColor: string;
}

/** One composited overlay layer of an item-status corner badge. */
export interface StatusLayer {
  asset: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Limited-time tag layers are tinted with the user's chosen colour. */
  theme?: boolean;
}

/** Nine-slice borders, in source pixels, for sprites drawn with `drawSlicedSprite`. */
export type SpriteBorders = Record<string, [number, number, number, number]>;

/** Blueprint detail fields edited in the presentation dialog. */
export interface PresentationDetails {
  creatorId: string;
  tags: string[];
  description: string;
  coverId: string;
  coverColor: CoverColor;
  showChangeHints: boolean;
  connectionPair: string;
  viewport: { zoom: number; x: number; y: number };
}

export type CoverColor = 'blue' | 'cyan' | 'yellow' | 'green' | 'purple' | 'orange' | 'gray';

/** One placed device. Mirrors the on-disk node shape exactly. */
export interface BlueprintNode {
  templateId: string;
  position: Point;
  direction: Direction;
  productIcon?: string | null;
  formulaMode?: string;
  environmentEffect?: EnvironmentEffect;
  itemStatus?: ItemStatus;
  itemStatusColor?: string;
  closedPorts?: string[];
  undergroundPair?: string;
}

/** One belt or pipe cell. */
export interface Conveyor {
  x: number;
  z: number;
  kind: PortKind;
  dir: Direction;
  fromDir?: Direction;
}

/**
 * The blueprint document. `schemaVersion` 2 is the only supported version.
 * Unknown fields are preserved by `validate`, so forward-compatible imports round-trip.
 */
export interface Layout {
  schemaVersion?: number;
  name: string;
  size: Size;
  nodes: BlueprintNode[];
  conveyors: Conveyor[];
  presentation?: Partial<PresentationDetails>;
  [extra: string]: unknown;
}

/** Device lookup by template id, as built from the baking payload. */
export type BuildingIndex = Record<string, Building>;

/** Asset lookup: asset key -> relative URL. Never a data URL. */
export type AssetIndex = Record<string, string>;

/** Everything the editor needs once the baking worker has finished. */
export interface BakePayload {
  buildings: Building[];
  products: Record<string, Product>;
  assets: AssetIndex;
  sprites: Record<string, string>;
  spriteBorders: SpriteBorders;
  lineItems: Record<string, LineItem>;
  statusLayers: Record<string, StatusLayer[]>;
  demo: Layout;
  presentation: PresentationPayload;
}

/** Native presentation artwork and inventory ordering produced by the baking layer. */
export interface PresentationPayload {
  sprites: Record<string, string>;
  covers: Record<string, { asset: string; name: string; kind?: string }>;
  rarityLayers: Record<string, string>;
  tags: string[];
}

/** Per-asset raw RGBA pixel data, transferred from the worker without PNG or base64 encoding. */
export interface BakedImage {
  key: string;
  width: number;
  height: number;
  /** Raw RGBA bytes, `width * height * 4` long. */
  pixels: ArrayBuffer;
}

/** A `conveyorSprites` result: the base conveyor plus the sprite pick and rotation to draw. */
export interface RoutedConveyor extends Conveyor {
  sprite: string;
  angle: number;
}

/** A resolved world-space port, used for routing and for painting the belt/pipe stub. */
export interface WorldPort extends BuildingPort {
  x: number;
  z: number;
  edgeX: number;
  edgeZ: number;
  outX: number;
  outZ: number;
}

export interface Bounds {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** A device's absolute cell rectangle: origin plus rotated extent. */
export interface Footprint extends Bounds {
  w: number;
  d: number;
}

export interface RouteResult {
  path: Conveyor[];
  start: { x: number; z: number; port?: WorldPort };
  end: { x: number; z: number; port?: WorldPort };
}
