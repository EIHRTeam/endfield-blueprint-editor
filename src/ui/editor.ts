/**
 * Editor state and control logic.
 *
 * This is the transcription home of `editor_app.js`. Every module-level `let` of the original becomes a
 * field, and every function becomes a method of the same name, with the same body — the original's
 * logic is imperative and canvas-driven, so keeping its shape is what makes the port checkable against
 * the original line by line.
 *
 * React's only involvement is that a revision counter is bumped whenever something visible changes,
 * which re-renders the markup. No state is duplicated: React reads these fields, it does not own them.
 */
import {
  History,
  bounds,
  clone,
  connectedRoute,
  dims,
  footprint,
  hit,
  placementError,
  removeNode,
  undergroundPeer,
  validate,
} from '../core';
import type {
  BlueprintNode,
  Building,
  BuildingIndex,
  Conveyor,
  Direction,
  Layout,
  PortKind,
  Product,
  WorldPort,
} from '../core/types';
import { loadFonts } from '../app/fonts';
import type { AssetStore } from '../render/assets';
import { drawNode, drawSlicedSprite, paintScene } from '../render/paintScene';
import type { BakePayload } from '../core/types';

/** The empty document the original starts from. */
export const EMPTY_LAYOUT: Layout = {
  schemaVersion: 2,
  name: '未命名蓝图',
  size: { x: 50, z: 50 },
  nodes: [],
  conveyors: [],
};

/** `localStorage` key, unchanged from the original. */
export const STORAGE_KEY = 'endfield.blueprint.editor.v2';

export type Tool = 'select' | 'place' | 'item' | 'fluid' | 'erase' | 'icon';

interface GesturePan {
  type: 'pan';
  x: number;
  y: number;
  ox: number;
  oy: number;
}
interface GestureMove {
  type: 'move';
  index: number;
  start: { x: number; z: number; gx: number; gz: number };
  original: BlueprintNode;
  preview: BlueprintNode;
  moved: boolean;
}
interface GestureRoute {
  type: 'route';
  start: { x: number; z: number; gx: number; gz: number };
  kind: PortKind;
  path: Conveyor[];
  startPort: WorldPort | null;
  endPort: WorldPort | null;
  error: string;
}
export type Gesture = GesturePan | GestureMove | GestureRoute;

export interface View {
  s: number;
  ox: number;
  oy: number;
}

export interface CellPoint {
  x: number;
  z: number;
  gx: number;
  gz: number;
}

/**
 * Callbacks the UI layer provides so the editor can flush its state into the DOM.
 *
 * The original called `$('productScope').value = …` directly. React owns those elements now, so the
 * editor announces *what* changed and the bound component writes it.
 */
export interface StatusSink {
  /** `message(text, error)` of the original. */
  setStatus: (text: string, error: boolean) => void;
  setSaveStatus: (text: string) => void;
}

export interface EditorOptions {
  payload: BakePayload;
  assets: AssetStore;
  /** Notifies React that visible state changed, so the markup can re-render. */
  onRevision: () => void;
  status: StatusSink;
}

export class Editor {
  readonly payload: BakePayload;
  readonly assets: AssetStore;
  readonly buildings: BuildingIndex;
  readonly history = new History();
  readonly images = new Map<string, { image: HTMLImageElement; loaded: boolean; ready: Promise<HTMLImageElement> }>();

  /** `data` of the original. */
  data: Layout = clone(EMPTY_LAYOUT);
  selected = -1;
  chosen: string | null = null;
  tool: Tool = 'select';
  rotation: Direction = 0;
  hover: CellPoint | null = null;
  gesture: Gesture | null = null;
  space = false;
  showGrid = true;
  showPorts = false;
  showHints = true;
  activePair: string | null = null;
  inspectorNode: string | null = null;
  previewRevision = 0;
  productLimit = 80;
  iconBrush: string | null = null;
  view: View = { s: 30, ox: 35, oy: 55 };
  saveTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  needsSave = false;
  frame = 0;
  restoreError = '';

  /** Set once the shell is mounted; the editor needs the canvas and its container. */
  canvas: HTMLCanvasElement | null = null;
  ctx: CanvasRenderingContext2D | null = null;
  wrap: HTMLElement | null = null;

  private readonly onRevision: () => void;
  private readonly status: StatusSink;

  constructor(options: EditorOptions) {
    this.payload = options.payload;
    this.assets = options.assets;
    this.onRevision = options.onRevision;
    this.status = options.status;
    this.buildings = Object.fromEntries(options.payload.buildings.map(building => [building.id, building]));

    // `editor_app.js:24` — restore the draft, remembering a failure rather than throwing.
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) this.data = validate(JSON.parse(saved), this.buildings);
    } catch (error) {
      this.restoreError = `草稿未恢复：${(error as Error).message}。原记录保留，修改后才会覆盖。`;
    }
  }

  /**
   * Object URL of the selected device's preview image.
   *
   * The original painted an offscreen canvas and assigned `toDataURL()` to `#selectedPreview.src`
   * (`editor_app.js:364`), guarded by `previewRevision` so a stale paint could not overwrite a newer
   * selection. The same guard is kept, but the result is an object URL instead of a data URL so the
   * encoded image is not re-parsed on every render.
   */
  previewUrl = '';

  /** `refreshInspector()`'s preview half, guarded exactly like the original. */
  async refreshPreview(base: string): Promise<void> {
    const node = this.data.nodes[this.selected];
    if (!node) {
      this.previewUrl = '';
      return;
    }
    const revision = ++this.previewRevision;
    const snapshot = clone(node);
    await this.prepareScene({ ...this.data, nodes: [snapshot] }, base);
    if (revision !== this.previewRevision) return;

    const extent = dims(this.buildings[snapshot.templateId]!, snapshot.direction ?? 0);
    const scale = Math.min(64, 176 / extent.w, 126 / extent.d);
    const preview = document.createElement('canvas');
    preview.width = Math.ceil(extent.w * scale + 12);
    preview.height = Math.ceil(extent.d * scale + 12);
    paintScene(
      preview.getContext('2d')!,
      { ...this.data, nodes: this.data.nodes.map(candidate => (candidate === node ? snapshot : candidate)) },
      this.paintContext(),
      { s: scale, ox: 6 - snapshot.position.x * scale, oy: 6 - snapshot.position.z * scale },
      { hints: this.showHints },
    );

    const blob = await new Promise<Blob | null>(resolve => preview.toBlob(resolve, 'image/png'));
    if (revision !== this.previewRevision || !blob) return;
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = URL.createObjectURL(blob);
    this.onRevision();
  }

  /** The product record for an icon id; gas ids are lower-cased, as in the original. */
  productInfo(id: string | null | undefined): Product | undefined {
    const key = id?.startsWith('[gas]') ? id.toLowerCase() : id;
    return key ? this.payload.products[key] : undefined;
  }

  message(text: string, error = false): void {
    this.status.setStatus(text, error);
  }

  scheduleSave(): void {
    this.needsSave = true;
    this.status.setSaveStatus('保存中…');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 300);
  }

  saveNow(): void {
    clearTimeout(this.saveTimer);
    if (!this.needsSave) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
      this.needsSave = false;
      this.status.setSaveStatus('已保存到本机');
    } catch {
      this.status.setSaveStatus('自动保存不可用，请保存 JSON');
    }
  }

  /** `changed(text)` of the original: one place that flushes every derived view. */
  changed(text?: string): void {
    if (this.selected >= this.data.nodes.length) this.selected = -1;
    // Invalidates any in-flight preview paint, mirroring `previewRevision++` in `refreshInspector`.
    this.previewRevision += 1;
    this.onRevision();
    this.scheduleSave();
    if (text) this.message(text);
  }

  transact(operation: (draft: Layout) => void, text?: string): boolean {
    const next = clone(this.data);
    try {
      operation(next);
      const valid = validate(next, this.buildings);
      if (this.history.commit(this.data, valid)) {
        this.data = valid;
        this.changed(text);
        return true;
      }
    } catch (error) {
      this.message((error as Error).message, true);
    }
    return false;
  }

  undo(): void {
    if (!this.history.past.length) return;
    this.data = this.history.undo(this.data);
    this.selected = -1;
    this.gesture = null;
    this.changed('已撤销');
  }

  redo(): void {
    if (!this.history.future.length) return;
    this.data = this.history.redo(this.data);
    this.selected = -1;
    this.gesture = null;
    this.changed('已重做');
  }

  selectTool(value: Tool): void {
    this.tool = value;
    this.gesture = null;
    if (value !== 'select') this.selected = -1;
    this.onRevision();
  }

  updateSelected(operation: (node: BlueprintNode) => void): void {
    if (this.selected >= 0) this.transact(draft => operation(draft.nodes[this.selected]!), '设备属性已更新');
  }

  deleteSelected(): void {
    if (this.selected < 0) return;
    const index = this.selected;
    this.selected = -1;
    this.transact(draft => removeNode(draft.nodes, index), '已删除设备，可撤销');
  }

  eraseAt(point: { x: number; z: number }): void {
    const index = hit(this.data.nodes, this.buildings, point.x, point.z);
    if (index >= 0) {
      this.selected = -1;
      this.transact(draft => removeNode(draft.nodes, index), '已删除设备，可撤销');
    } else {
      this.transact(draft => {
        draft.conveyors = draft.conveyors.filter(belt => belt.x !== point.x || belt.z !== point.z);
      }, '已删除该格线路，可撤销');
    }
  }

  rotate(): void {
    if (this.gesture?.type === 'move') {
      // The drag preview owns all pending edits. Commit position and direction together on pointerup;
      // Escape/cancel leaves the original document and history untouched.
      this.gesture.preview.direction = ((this.gesture.preview.direction + 1) % 4) as Direction;
      this.gesture.moved = true;
      this.message(`移动中的设备已旋转至 ${this.gesture.preview.direction * 90}°，松手放置`);
      this.requestDraw();
      return;
    }
    if (this.selected >= 0 && this.tool === 'select') {
      this.transact(draft => {
        const node = draft.nodes[this.selected]!;
        node.direction = ((node.direction + 1) % 4) as Direction;
      }, '设备已旋转');
      return;
    }
    this.rotation = ((this.rotation + 1) % 4) as Direction;
    this.message(
      this.tool === 'item' || this.tool === 'fluid'
        ? `单格线路朝向：${['右', '下', '左', '上'][this.rotation]}`
        : `放置朝向：${this.rotation * 90}°`,
    );
    this.onRevision();
    this.requestDraw();
  }

  toggleConnection(): void {
    const node = this.data.nodes[this.selected];
    if (!node || !undergroundPeer(this.data.nodes, node)) return;
    this.activePair = this.activePair === node.undergroundPair ? null : (node.undergroundPair ?? null);
    this.onRevision();
    this.requestDraw();
  }

  // ---------------------------------------------------------------- canvas plumbing

  /** `requestDraw()` — the original coalesced paints into one animation frame. */
  requestDraw(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  resize(): void {
    if (!this.canvas || !this.wrap) return;
    const ratio = devicePixelRatio || 1;
    this.canvas.width = Math.round(this.wrap.clientWidth * ratio);
    this.canvas.height = Math.round(this.wrap.clientHeight * ratio);
    this.requestDraw();
  }

  fit(): void {
    if (!this.wrap) return;
    const b = bounds(this.data, this.buildings, 1);
    const w = b.x1 - b.x0;
    const h = b.z1 - b.z0;
    this.view.s = Math.min(
      96,
      Math.max(6, Math.min((this.wrap.clientWidth - 70) / w, (this.wrap.clientHeight - 100) / h)),
    );
    this.view.ox = (this.wrap.clientWidth - w * this.view.s) / 2 - b.x0 * this.view.s;
    this.view.oy = 30 + (this.wrap.clientHeight - h * this.view.s) / 2 - b.z0 * this.view.s;
    this.requestDraw();
  }

  pointer(event: { clientX: number; clientY: number }): CellPoint {
    const rect = this.canvas!.getBoundingClientRect();
    const gx = (event.clientX - rect.left - this.view.ox) / this.view.s;
    const gz = (event.clientY - rect.top - this.view.oy) / this.view.s;
    return { x: Math.floor(gx), z: Math.floor(gz), gx, gz };
  }

  inside(point: { x: number; z: number }): boolean {
    return point.x >= 0 && point.z >= 0 && point.x < this.data.size.x && point.z < this.data.size.z;
  }

  updateRoute(end: CellPoint, verticalFirst: boolean): void {
    const gesture = this.gesture;
    if (gesture?.type !== 'route') return;
    try {
      const result = connectedRoute(
        this.data,
        this.buildings,
        gesture.start,
        end,
        gesture.kind,
        verticalFirst,
        this.rotation,
      );
      gesture.path = result.path;
      gesture.startPort = result.start.port ?? null;
      gesture.endPort = result.end.port ?? null;
      gesture.error = '';
    } catch (error) {
      gesture.path = [];
      gesture.startPort = null;
      gesture.endPort = null;
      gesture.error = (error as Error).message;
    }
  }

  /** Helpers the painter needs; kept here so `paintScene` stays framework-free. */
  private paintContext() {
    return {
      assets: this.assets,
      buildings: this.buildings,
      products: this.payload.products,
      sprites: this.payload.sprites,
      spriteBorders: this.payload.spriteBorders,
      statusLayers: this.payload.statusLayers,
    };
  }

  /** `draw()` of the original. */
  draw(): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;

    const ratio = devicePixelRatio || 1;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio);
    ctx.fillStyle = '#e6e6e6';
    ctx.fillRect(0, 0, canvas.width / ratio, canvas.height / ratio);

    paintScene(ctx, this.data, this.paintContext(), this.view, {
      grid: this.showGrid,
      ports: this.showPorts,
      hints: this.showHints,
      hintScale: 0.5,
      activePair: this.activePair,
      dimIndex: this.gesture?.type === 'move' && this.gesture.moved ? this.gesture.index : -1,
    });

    ctx.strokeStyle = '#b5bdc2';
    ctx.lineWidth = 1;
    ctx.strokeRect(this.view.ox, this.view.oy, this.data.size.x * this.view.s, this.data.size.z * this.view.s);

    if (this.hover && !this.gesture && this.tool === 'select') {
      const index = hit(this.data.nodes, this.buildings, this.hover.x, this.hover.z);
      const f =
        index >= 0
          ? footprint(this.data.nodes[index]!, this.buildings)
          : this.data.conveyors.some(belt => belt.x === this.hover!.x && belt.z === this.hover!.z)
            ? { x0: this.hover.x, z0: this.hover.z, w: 1, d: 1, x1: 0, z1: 0 }
            : null;
      if (f) {
        const pad = (22 / 128) * this.view.s;
        drawSlicedSprite(
          ctx,
          this.assets.get(this.payload.sprites.hover_frame),
          this.payload.spriteBorders.hover_frame,
          this.view.ox + f.x0 * this.view.s - pad,
          this.view.oy + f.z0 * this.view.s - pad,
          f.w * this.view.s + pad * 2,
          f.d * this.view.s + pad * 2,
          this.view.s / 128,
        );
      }
    }

    if (this.selected >= 0 && this.data.nodes[this.selected]) {
      const f = footprint(this.data.nodes[this.selected]!, this.buildings);
      drawSlicedSprite(
        ctx,
        this.assets.get(this.payload.sprites.selection_frame),
        this.payload.spriteBorders.selection_frame,
        this.view.ox + f.x0 * this.view.s,
        this.view.oy + f.z0 * this.view.s,
        f.w * this.view.s,
        f.d * this.view.s,
        this.view.s / 128,
      );
    }

    let ghost: BlueprintNode | null = null;
    let ignore = -1;
    if (this.gesture?.type === 'move' && this.gesture.moved) {
      ghost = this.gesture.preview;
      ignore = this.gesture.index;
    } else if (this.tool === 'place' && this.chosen && this.hover && !this.gesture) {
      ghost = {
        templateId: this.chosen,
        position: { x: this.hover.x, z: this.hover.z },
        direction: this.rotation,
      };
    }
    if (ghost) {
      const error = placementError(this.data, this.buildings, ghost, ignore);
      ctx.save();
      ctx.globalAlpha = 0.6;
      drawNode(ctx, ghost, this.paintContext(), this.view);
      ctx.restore();
      this.rectOutline(ctx, ghost, error ? '#d36159' : '#4aaccb', Boolean(error));
    }

    if (this.gesture?.type === 'route') {
      ctx.save();
      ctx.globalAlpha = 0.8;
      paintScene(ctx, { ...this.data, conveyors: this.gesture.path }, this.paintContext(), this.view, {
        linesOnly: true,
      });
      ctx.restore();
      for (const endpoint of [this.gesture.startPort, this.gesture.endPort]) {
        if (!endpoint) continue;
        ctx.strokeStyle = '#1887a6';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(
          this.view.ox + endpoint.edgeX * this.view.s,
          this.view.oy + endpoint.edgeZ * this.view.s,
          Math.max(5, this.view.s * 0.17),
          0,
          Math.PI * 2,
        );
        ctx.stroke();
      }
      if (this.gesture.error && this.hover) {
        ctx.strokeStyle = '#c94848';
        ctx.lineWidth = 2;
        ctx.strokeRect(
          this.view.ox + this.hover.x * this.view.s,
          this.view.oy + this.hover.z * this.view.s,
          this.view.s,
          this.view.s,
        );
      }
    }
  }

  /** `C.hit` against the current document. */
  indexAt(x: number, z: number): number {
    return hit(this.data.nodes, this.buildings, x, z);
  }

  /** `C.footprint` against the current document. */
  footprintOf(node: BlueprintNode) {
    return footprint(node, this.buildings);
  }

  /** `C.bounds` against the current document. */
  boundsOf(layout: Layout, margin: number) {
    return bounds(layout, this.buildings, margin);
  }

  /** The painter context, for callers outside the class (PNG export, presentation). */
  paintContextPublic() {
    return this.paintContext();
  }

  /** `importLayout(input)` of the original's file handler, including its missing-icon notice. */
  importLayout(input: unknown): void {
    const next = validate(input, this.buildings);
    this.selected = -1;
    this.gesture = null;
    this.activePair = null;
    if (this.history.commit(this.data, next)) {
      this.data = next;
      this.changed(`已导入 ${next.nodes.length} 个设备 / ${next.conveyors.length} 段线路`);
    }
    this.selectTool('select');
    this.fit();
    const missing = this.data.nodes.filter(
      node => node.productIcon && !this.productInfo(node.productIcon)?.badge,
    ).length;
    if (missing) this.message(`导入完成；${missing} 个产物缺图，ID 已保留`, true);
  }

  /** `rectOutline()` of the original. */
  rectOutline(
    ctx: CanvasRenderingContext2D,
    node: { position: { x: number; z: number }; direction?: Direction; templateId: string },
    color: string,
    fill = false,
  ): void {
    const f = footprint(node, this.buildings);
    const x = this.view.ox + f.x0 * this.view.s;
    const y = this.view.oy + f.z0 * this.view.s;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    if (fill) {
      ctx.fillStyle = color;
      ctx.globalAlpha *= 0.16;
      ctx.fillRect(x, y, f.w * this.view.s, f.d * this.view.s);
      ctx.globalAlpha /= 0.16;
    }
    ctx.strokeRect(x + 1, y + 1, f.w * this.view.s - 2, f.d * this.view.s - 2);
  }

  // ---------------------------------------------------------------- re-exports for the painter

  /** The `asset()` loader of the original, backed by the shared asset store. */
  asset(key: string | null | undefined) {
    return this.assets.get(key);
  }

  assetReady(key: string | null | undefined): Promise<unknown> {
    return this.assets.load(key).catch(() => undefined);
  }

  /** `prepareScene(layout)` of the original — every asset the scene can draw, then the font. */
  async prepareScene(layout: Layout, base: string): Promise<void> {
    const keys = new Set<string>(Object.values(this.payload.sprites));
    for (const node of layout.nodes) {
      const building = this.buildings[node.templateId]!;
      keys.add(this.bodyKey(node));
      keys.add(node.productIcon ? (this.productInfo(node.productIcon)?.badge ?? '') : (building.symbol ?? ''));
      keys.add(building.connectionFrames?.[node.direction ?? 0] ?? '');
      keys.add(building.activeConnectionFrames?.[node.direction ?? 0] ?? '');
      if (node.closedPorts?.length) {
        keys.add(building.bareFaces?.[node.direction ?? 0] ?? '');
        keys.add(building.waistFaces?.[node.direction ?? 0] ?? '');
        keys.add(building.edgeDecoration ?? '');
      }
    }
    await Promise.all([...keys].filter(Boolean).map(key => this.assetReady(key)));
    await loadFonts(base);
  }

  bodyKey(node: BlueprintNode): string {
    const building = this.buildings[node.templateId]!;
    const faces = node.formulaMode === 'normal' ? building.normalFaces : building.faces;
    return faces[node.direction ?? 0]!;
  }

  dims(building: Building, direction: Direction) {
    return dims(building, direction);
  }
}
