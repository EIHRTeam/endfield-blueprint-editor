/**
 * The full game-style blueprint preview sheet.
 *
 * This reproduces the original detail panel: topographic header strips, the clipped layout viewport
 * with its masks and scrollbars, and the fixed right-hand metadata panel with the auto-generated
 * inventory. The same painter is used for the live preview and the exported PNG, so the two always
 * agree.
 *
 * Ported from the previous `editor_presentation.js` with identical geometry and colours.
 */
import { bounds, buildingCells, clone, key as cellKey, undergroundPeer, undergroundRole, validate } from '../core';
import type { Layout, PresentationDetails, PresentationPayload, Product } from '../core/types';
import { paintScene } from '../render/paintScene';
import type { Editor } from './editor';
import { detailsOf } from './presentation';

export interface PresentationMetrics {
  details: PresentationDetails;
  items: InventoryItem[];
  nameLines: string[];
  description: string[];
  tags: Array<{ value: string; x: number; y: number; width: number }>;
  creatorY: number;
  descY: number;
  listY: number;
  height: number;
}

export interface InventoryItem {
  id: string;
  name: string;
  palette: string;
  rarityColor: string;
  count: number;
}

export interface ViewportTransform {
  bounds: ReturnType<typeof bounds>;
  area: { x: number; y: number; w: number; h: number };
  s: number;
  gridW: number;
  gridH: number;
  overflowX: number;
  overflowY: number;
  ox: number;
  oy: number;
}

/** Widths the detail sheet is authored at; anything else would mis-scale the layout. */
const PREVIEW_WIDTHS = new Set([1920, 2560, 3840]);

const PANEL_X = 1908;
const PANEL_W = 608;

function paintContext(editor: Editor, buildings: Parameters<typeof paintScene>[2]['buildings']) {
  return {
    assets: editor.assets,
    buildings,
    products: editor.payload.products,
    sprites: editor.payload.sprites,
    spriteBorders: editor.payload.spriteBorders,
    statusLayers: editor.payload.statusLayers,
  };
}

function buildingIndex(editor: Editor) {
  const index: { [id: string]: Parameters<typeof paintScene>[2]['buildings'][string] } = {};
  for (const building of editor.payload.buildings) index[building.id] = building;
  return index;
}

/**
 * Groups the layout's devices into the four-column inventory.
 *
 * Follows `BlueprintContent._RefreshDeviceCells` and `UIConst.COMMON_ITEM_SORT_KEYS`: the sort ids
 * come from the item table, and logistics nodes are listed without a count.
 */
export function inventory(editor: Editor, layout: Layout): InventoryItem[] {
  const groups = new Map<string, InventoryItem>();
  for (const node of layout.nodes) {
    const building = editor.payload.buildings.find(entry => entry.id === node.templateId);
    if (!building) continue;
    const id = building.itemId || building.id;
    if (!groups.has(id)) {
      groups.set(id, { ...building, id, palette: building.palette, rarityColor: building.rarityColor, count: 0 });
    }
    if (!building.logistic) groups.get(id)!.count++;
  }
  const occupied = buildingCells(layout, buildingIndex(editor));
  for (const [kind, item] of Object.entries(editor.payload.lineItems)) {
    if (layout.conveyors.some(belt => belt.kind === kind && !occupied.has(cellKey(belt.x, belt.z)))) {
      groups.set(item.id, { ...item, count: 0 });
    }
  }
  return [...groups.values()].toSorted((a, b) => {
    const a1 = (a as unknown as { sortId1?: number }).sortId1 ?? 0;
    const b1 = (b as unknown as { sortId1?: number }).sortId1 ?? 0;
    const a2 = (a as unknown as { sortId2?: number }).sortId2 ?? 0;
    const b2 = (b as unknown as { sortId2?: number }).sortId2 ?? 0;
    return b1 - a1 || b2 - a2 || a.id.localeCompare(b.id);
  });
}

/** Greedy character wrapping, matching the original Canvas measurement. */
function textLines(context: CanvasRenderingContext2D, value: string, width: number, font: string): string[] {
  context.font = font;
  const lines: string[] = [];
  for (const paragraph of String(value).split('\n')) {
    let line = '';
    for (const character of paragraph) {
      if (line && context.measureText(line + character).width > width) {
        lines.push(line);
        line = '';
      }
      line += character;
    }
    lines.push(line);
  }
  return lines;
}

export function metrics(editor: Editor, layout: Layout): PresentationMetrics {
  const context = document.createElement('canvas').getContext('2d')!;
  const details = detailsOf(layout);
  const nameLines = textLines(context, layout.name, 336, `500 34px "${'HarmonyOS Sans SC'}",sans-serif`);
  const description = details.description
    ? textLines(context, details.description, 532, `24px "${'HarmonyOS Sans SC'}",sans-serif`)
    : [];
  const tags: PresentationMetrics['tags'] = [];
  const start = 1942;
  let x = start;
  let y = Math.max(409, 218 + nameLines.length * 43 + 102);
  const creatorY = y - 35;
  context.font = `25px "${'HarmonyOS Sans SC'}",sans-serif`;
  for (const value of details.tags) {
    const width = Math.min(532, context.measureText(value).width + 50);
    if (x + width > 2486) {
      x = start;
      y += 40;
    }
    tags.push({ value, x, y, width });
    x += width + 6;
  }
  const descY = y + 50;
  const listY = Math.max(506, description.length ? descY + description.length * 34 + 55 : y + 97);
  const items = inventory(editor, layout);
  const height = Math.max(1440, listY + Math.ceil(items.length / 4) * 143 + 100);
  return { details, items, nameLines, description, tags, creatorY, descY, listY, height };
}

/**
 * Maps the layout into the clipped preview area.
 *
 * The grid always fits the viewport at zoom 1; the metadata column width is independent of the grid
 * size, exactly as in the original panel.
 */
export function viewportTransform(editor: Editor, layout: Layout, m: PresentationMetrics): ViewportTransform {
  const b = bounds(layout, buildingIndex(editor), 0);
  const gridW = b.x1 - b.x0;
  const gridH = b.z1 - b.z0;
  const area = { x: 48, y: 194, w: 1800, h: m.height - 312 };
  const v = m.details.viewport;
  const s = Math.min(116, 1744 / gridW, area.h / gridH) * v.zoom;
  const overflowX = Math.max(0, gridW * s - area.w);
  const overflowY = Math.max(0, gridH * s - area.h);
  return {
    bounds: b,
    area,
    s,
    gridW,
    gridH,
    overflowX,
    overflowY,
    ox: area.x + Math.max(0, (area.w - gridW * s) / 2) - overflowX * v.x - b.x0 * s,
    oy: area.y + Math.max(0, (area.h - gridH * s) / 2) - overflowY * v.y - b.z0 * s,
  };
}

function stamp(
  c: CanvasRenderingContext2D,
  editor: Editor,
  assetKey: string,
  x: number,
  y: number,
  width: number,
  height: number,
  alpha = 1,
  contain = false,
): void {
  const image = editor.assets.get(assetKey);
  if (!image) return;
  c.save();
  c.globalAlpha *= alpha;
  if (contain) {
    const scale = Math.min(width / image.width, height / image.height);
    c.drawImage(
      image,
      x + (width - image.width * scale) / 2,
      y + (height - image.height * scale) / 2,
      image.width * scale,
      image.height * scale,
    );
  } else {
    c.drawImage(image, x, y, width, height);
  }
  c.restore();
}

function roundRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill: string,
): void {
  c.fillStyle = fill;
  c.beginPath();
  c.roundRect(x, y, w, h, r);
  c.fill();
}

function label(
  c: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  color: string,
  weight = '',
): void {
  c.font = `${weight ? `${weight} ` : ''}${size}px "${'HarmonyOS Sans SC'}",sans-serif`;
  c.fillStyle = color;
  c.textBaseline = 'top';
  c.textAlign = 'left';
  c.fillText(text, x, y);
}

function drawCard(
  c: CanvasRenderingContext2D,
  editor: Editor,
  native: PresentationPayload,
  item: InventoryItem,
  x: number,
  y: number,
): void {
  const w = 130;
  const h = 130;
  c.save();
  c.shadowColor = '#0003';
  c.shadowBlur = 5;
  c.shadowOffsetY = 3;
  roundRect(c, x, y, w, h, 3, '#222325');
  c.restore();
  c.save();
  c.beginPath();
  c.roundRect(x, y, w, h, 3);
  c.clip();
  stamp(c, editor, native.sprites.bg_item_small_black, x - 2, y - 2, w + 4, h + 4);
  stamp(c, editor, native.rarityLayers[item.rarityColor]!, x, y + 76, w, 54);
  c.fillStyle = item.rarityColor || '#999';
  c.fillRect(x, y + h - 6, w, 6);
  stamp(c, editor, native.covers[item.id]?.asset || item.palette, x + 2, y + 1, 126, 119, 1, true);
  stamp(c, editor, native.sprites.deco_item_dot, x + 5, y + 5, 36, 5, 0.55);
  if (item.count) {
    c.shadowColor = '#000';
    c.shadowBlur = 4;
    c.font = `32px "${'HarmonyOS Sans SC'}",sans-serif`;
    c.fillStyle = '#f4f4f4';
    c.textAlign = 'center';
    c.textBaseline = 'bottom';
    c.fillText(String(item.count), x + w / 2, y + h - 5);
  }
  c.restore();
}

/** Paints the whole preview sheet at its native 2560-pixel width. */
export function paintPresentation(
  c: CanvasRenderingContext2D,
  editor: Editor,
  layout: Layout,
  m: PresentationMetrics,
): void {
  const native = editor.payload.presentation;
  const { details: p, height: H } = m;
  const buildings = buildingIndex(editor);
  c.fillStyle = '#e6e6e6';
  c.fillRect(0, 0, 2560, H);

  // Top navigation, original topographic strips and original close icon.
  c.fillStyle = '#ededed';
  c.fillRect(0, 0, 2560, 116);
  stamp(c, editor, native.sprites.deco_fac_blueprint_6!, 0, 0, 970, 145, 0.6);
  stamp(c, editor, native.sprites.deco_fac_blueprint_5!, 1350, 0, 1120, 124, 0.6);
  stamp(c, editor, native.sprites.deco_fac_blueprint_24!, 65, 2, 216, 108, 0.22);
  stamp(c, editor, native.sprites.deco_assembly07_new!, 67, 28, 82, 15);
  stamp(c, editor, native.sprites.deco_fac_blueprint_28!, 1914, 34, 356, 60);
  label(c, '// 蓝图预览', 67, 48, 28, '#161616', '600');
  stamp(c, editor, native.sprites.close_btn_bg_shadeless!, 2430, 26, 64, 64);

  const t = viewportTransform(editor, layout, m);
  c.save();
  c.beginPath();
  c.rect(0, 117, 1884, H - 175);
  c.clip();
  paintScene(
    c,
    layout,
    paintContext(editor, buildings),
    { s: t.s, ox: t.ox, oy: t.oy },
    {
      grid: true,
      gridRect: { x: 0, y: 117, w: 1884, h: H - 175 },
      hints: true,
      changeHints: p.showChangeHints,
      activePair: p.connectionPair || null,
    },
  );
  c.restore();

  label(c, '蓝图预览', 85, 142, 27, '#8d8d8d');
  c.fillStyle = '#9d9d9d';
  c.fillRect(68, 142, 8, 26);
  c.fillStyle = '#444';
  if (t.overflowY) {
    const track = H - 250;
    const thumb = Math.max(70, (track * t.area.h) / (t.area.h + t.overflowY));
    c.fillRect(1885, 149 + (track - thumb) * p.viewport.y, 8, thumb);
  }

  // Soft masks inside the drawing viewport, never over the detail panel.
  for (const [x0, x1] of [
    [0, 44],
    [1884, 1840],
  ]) {
    const edge = c.createLinearGradient(x0, 0, x1, 0);
    edge.addColorStop(0, '#e6e6e6');
    edge.addColorStop(1, '#e6e6e600');
    c.fillStyle = edge;
    c.fillRect(Math.min(x0, x1), 172, Math.abs(x1 - x0), H - 265);
  }
  const fade = c.createLinearGradient(0, H - 150, 0, H);
  fade.addColorStop(0, '#e6e6e600');
  fade.addColorStop(1, '#d4d4d4');
  c.fillStyle = fade;
  c.fillRect(0, H - 150, 1908, 150);
  if (t.overflowX) {
    const track = 1770;
    const thumb = Math.max(90, (track * t.area.w) / (t.area.w + t.overflowX));
    c.fillStyle = '#444';
    c.fillRect(65 + (track - thumb) * p.viewport.x, H - 85, thumb, 8);
  }
  for (const x of [49, 1870]) {
    for (const y of [176, H - 81]) {
      c.fillStyle = '#999';
      c.fillRect(x, y, 8, 8);
    }
  }

  // Fixed detail panel: neutral vertical wash, grid texture and the lens watermark.
  stamp(c, editor, native.sprites.deco_fac_blueprint_light!, PANEL_X, 116, PANEL_W, H - 116);
  c.save();
  c.beginPath();
  c.rect(PANEL_X, 116, PANEL_W, 368);
  c.clip();
  for (let x = PANEL_X; x < PANEL_X + PANEL_W; x += 28)
    stamp(c, editor, native.sprites.deco_fac_blueprint_30!, x, 116, 28, 368);
  c.restore();
  c.save();
  c.beginPath();
  c.rect(PANEL_X, 116, PANEL_W, 260);
  c.clip();
  c.strokeStyle = '#20202516';
  c.lineWidth = 1;
  c.beginPath();
  for (let x = PANEL_X; x < 2516; x += 14) {
    c.moveTo(x, 116);
    c.lineTo(x, 376);
  }
  for (let y = 116; y < 376; y += 14) {
    c.moveTo(PANEL_X, y);
    c.lineTo(2516, y);
  }
  c.stroke();
  stamp(c, editor, native.sprites.icon_fac_blueprint_save_big!, 2290, 116, 226, 226);
  c.restore();
  let stripY = 116;
  for (const [color, height] of [
    ['#fff100', 123],
    ['#f955ff', 63],
    ['#00d2ff', 64],
  ] as const) {
    c.fillStyle = color;
    c.fillRect(PANEL_X, stripY, 7, height);
    stripY += height;
  }
  label(c, '蓝图详情', 1930, 142, 28, '#b8b8bc');
  stamp(c, editor, native.sprites[`icon_fac_blueprint_bg_${p.coverColor}`]!, 1908, 125, 240, 240, 1, true);

  const cover = native.covers[p.coverId] ?? native.covers['']!;
  // BlueprintIcon prefab: 256-square paper, centered 156-square item with an x offset of 5.
  const iconSize = ((240 * 156) / 256) * (p.coverId.startsWith('[gas]') ? 0.7 : 1);
  stamp(c, editor, cover.asset, 2033 - iconSize / 2, 245 - iconSize / 2, iconSize, iconSize, 1, true);
  m.nameLines.forEach((line, i) => label(c, line, 2122, 224 + i * 43, 34, '#f5f5f3', '500'));
  c.font = `500 34px "${'HarmonyOS Sans SC'}",sans-serif`;
  const lastLine = m.nameLines.at(-1) ?? '';
  for (const [bx, by, direction] of [
    [2117, 231, -1],
    [2128 + c.measureText(lastLine).width, 231 + (m.nameLines.length - 1) * 43, 1],
  ] as const) {
    c.strokeStyle = '#bdbdbd';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(bx, by);
    c.lineTo(bx + direction * 6, by);
    c.lineTo(bx + direction * 6, by + 23);
    c.lineTo(bx, by + 23);
    c.stroke();
  }
  const sizeY = 235 + m.nameLines.length * 43;
  stamp(c, editor, native.sprites.deco_fac_blueprint_size!, 2110, sizeY + 1, 25, 25, 0.5);
  label(c, '蓝图尺寸', 2142, sizeY, 24, '#b8b8bc');
  label(c, `${t.gridW}×${t.gridH}`, 2110, sizeY + 28, 34, '#f3f3f3');
  label(c, `创作者ID.${p.creatorId || '—'}`, 1940, m.creatorY, 24, '#444448');
  stamp(c, editor, native.sprites.bg_fac_blueprint_more!, 2446, m.creatorY - 10, 45, 45);
  label(c, '···', 2454, m.creatorY - 2, 24, '#888');
  for (const tag of m.tags) {
    roundRect(c, tag.x, tag.y, tag.width, 33, 17, '#e5e5e5');
    label(c, tag.value, tag.x + 25, tag.y + 1, 25, '#444448');
  }
  if (!m.tags.length) {
    const y = m.creatorY + 35;
    c.strokeStyle = '#ffffff25';
    c.lineWidth = 3;
    c.beginPath();
    c.roundRect(1942, y, 104, 29, 15);
    c.stroke();
    c.strokeStyle = '#ffffff55';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(1986, y + 6);
    c.lineTo(2003, y + 23);
    c.stroke();
  }
  m.description.forEach((line, i) => label(c, line, 1940, m.descY + i * 34, 24, '#4e4e52'));
  label(c, '设备一览', 1940, m.listY - 38, 29, '#515154');
  m.items.forEach((item, i) =>
    drawCard(c, editor, native, item, 1940 + (i % 4) * 142, m.listY + Math.floor(i / 4) * 143),
  );
  if (!m.items.length) label(c, '放置设备后自动生成', 1940, m.listY + 8, 24, '#777');
  c.fillStyle = '#27282a';
  c.fillRect(2516, 116, 44, H - 116);
  for (let y = 195; y < H; y += 425) stamp(c, editor, native.sprites.deco_fac_blueprint_29!, 2527, y, 24, 425);
  stamp(c, editor, native.sprites.deco_fac_blueprint_25!, 0, 0, 2560, H, 0.5);
}

/**
 * Renders the preview sheet at the requested width (1920 / 2560 / 3840).
 *
 * Validates the layout first: the exporter is a public API and must not accept a broken document.
 */
export async function exportPreviewSheet(
  editor: Editor,
  layout: Layout,
  width: number,
  base: string,
): Promise<HTMLCanvasElement> {
  void base;
  const source = validate(clone(layout), buildingIndex(editor));
  if (!PREVIEW_WIDTHS.has(width)) throw Error('请选择有效的完整预览分辨率');

  const m = metrics(editor, source);
  const buildings = buildingIndex(editor);
  // Preload every asset the sheet can touch, including covers and rarity bars.
  const keys = new Set<string>(Object.values(editor.payload.presentation.sprites));
  for (const item of m.items) {
    keys.add(editor.payload.presentation.covers[item.id]?.asset ?? item.palette);
    keys.add(editor.payload.presentation.rarityLayers[item.rarityColor] ?? '');
  }
  keys.add(
    editor.payload.presentation.covers[m.details.coverId]?.asset ?? editor.payload.presentation.covers['']!.asset,
  );
  await editor.assets.preload([...keys].filter(Boolean));
  await editor.assets.preload(
    source.nodes.flatMap(node => {
      const building = buildings[node.templateId]!;
      const product: Product | undefined = node.productIcon
        ? editor.payload.products[
            node.productIcon.startsWith('[gas]') ? node.productIcon.toLowerCase() : node.productIcon
          ]
        : undefined;
      return [
        node.productIcon ? product?.badge : building.symbol,
        building.connectionFrames?.[node.direction ?? 0],
        building.activeConnectionFrames?.[node.direction ?? 0],
      ].filter((candidate): candidate is string => Boolean(candidate));
    }),
  );

  const out = document.createElement('canvas');
  out.width = width;
  out.height = Math.round((m.height * width) / 2560);
  const c = out.getContext('2d')!;
  c.scale(width / 2560, width / 2560);
  paintPresentation(c, editor, source, m);
  return out;
}

/** All underground connections available for the "show connection" annotation. */
export function connectionOptions(editor: Editor, layout: Layout): Array<{ value: string; text: string }> {
  const options: Array<{ value: string; text: string }> = [];
  for (const node of layout.nodes) {
    if (undergroundRole(node) !== 'in') continue;
    const peer = undergroundPeer(layout.nodes, node);
    if (!peer) continue;
    options.push({
      value: node.undergroundPair!,
      text: `入口 (${node.position.x}, ${node.position.z}) → 出口 (${peer.position.x}, ${peer.position.z})`,
    });
  }
  return options;
}
