/* Browser UI. Preview and PNG export deliberately share paintScene(). */
'use strict';
const C = BlueprintCore;
const $ = id => document.getElementById(id);
const buildings = Object.fromEntries(PAYLOAD.buildings.map(b => [b.id, b]));
const productKey = id => id?.startsWith('[gas]') ? id.toLowerCase() : id;
const productInfo = id => PAYLOAD.products[productKey(id)];
const EMPTY = {schemaVersion: 2, name: '未命名蓝图', size: {x: 50, z: 50}, nodes: [], conveyors: []};
const STORAGE = 'endfield.blueprint.editor.v2';
const FONT_FAMILY = 'HarmonyOS Sans SC';
// Explicitly load before measuring text or painting the first export.
const fontReady = Promise.all([400, 500, 600, 700].map(weight => document.fonts.load(`${weight} 24px "${FONT_FAMILY}"`, '蓝图预览设备ABC0123')))
  .then(faces => { if (faces.some(list => !list.length || list.some(face => face.status !== 'loaded'))) throw Error('内嵌字体未加载，请重新打开页面'); });
fontReady.catch(() => {});
const history = new C.History();
let data = C.clone(EMPTY), selected = -1, chosen = null, tool = 'select', rotation = 0;
let hover = null, gesture = null, space = false, showGrid = true, showPorts = false;
let showHints = true, activePair = null, inspectorNode = null, previewRevision = 0;
let productLimit = 80, iconBrush = null;
let view = {s: 30, ox: 35, oy: 55}, saveTimer, needsSave = false, frame = 0;
const canvas = $('cv'), ctx = canvas.getContext('2d'), wrap = $('wrap');
const images = new Map();
let restoreError = '';
try { const saved = localStorage.getItem(STORAGE); if (saved) data = C.validate(JSON.parse(saved), buildings); }
catch (error) { restoreError = '草稿未恢复：' + error.message + '。原记录保留，修改后才会覆盖。'; }

function message(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function requestDraw() { if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw(); }); }
function asset(key) {
  if (!key) return null;
  if (!images.has(key)) {
    const image = new Image();
    const entry = {image, loaded: false};
    entry.ready = new Promise((resolve, reject) => {
      image.onload = () => { entry.loaded = true; requestDraw(); resolve(image); };
      image.onerror = () => { reject(Error('图片加载失败，请重新生成编辑器')); };
    });
    entry.ready.catch(error => message(error.message, true));
    images.set(key, entry);
    image.src = PAYLOAD.assets[key] || '';
  }
  const entry = images.get(key);
  return entry.loaded ? entry.image : null;
}
function assetReady(key) { asset(key); return key ? images.get(key).ready : Promise.resolve(); }
function bodyKey(node) {
  const b = buildings[node.templateId];
  return (node.formulaMode === 'normal' ? b.normalFaces : b.faces)[node.direction || 0];
}
const customBodies = new Map();
function portGroups(n) {
  const groups = new Map();
  for (const p of buildings[n.templateId].ports) {
    if (n.closedPorts?.includes(p.id) || n.formulaMode === 'normal' && p.pipe) continue;
    const key = `${p.edge}:${p.pipe}:${p.input}`;
    if (!groups.has(key)) groups.set(key, {edge: p.edge, pipe: p.pipe, input: p.input, positions: []});
    groups.get(key).positions.push(p.along);
  }
  return [...groups.values()].sort((a, b) => a.edge - b.edge || a.pipe - b.pipe || b.input - a.input);
}
function nodeBody(n) {
  const b = buildings[n.templateId];
  if (!n.closedPorts?.length || !b.editablePorts) return asset(bodyKey(n));
  const key = `${n.templateId}/${n.direction}/${n.formulaMode}/${[...n.closedPorts].sort().join(',')}`;
  if (customBodies.has(key)) return customBodies.get(key);
  const groups = portGroups(n), has = new Set(groups.map(g => g.edge));
  const base = asset((!has.has(1) && !has.has(3) ? b.waistFaces : b.bareFaces)[n.direction]);
  const decoration = asset(b.edgeDecoration);
  if (!base || !decoration) return null;
  const out = document.createElement('canvas'); out.width = base.width; out.height = base.height;
  const c = out.getContext('2d'); c.drawImage(base, 0, 0);
  c.translate(out.width / 2, out.height / 2); c.rotate(n.direction * Math.PI / 2); c.translate(-b.w * 64, -b.d * 64);
  function edge(im, face, along) {
    c.save();
    if (face === 0) c.translate(Math.round(along - im.width / 2), 0);
    if (face === 1) { c.translate(b.w * 128, Math.round(b.d * 128 - along - im.width / 2)); c.rotate(Math.PI / 2); }
    if (face === 2) { c.translate(Math.round(along + im.width / 2), b.d * 128); c.rotate(Math.PI); }
    if (face === 3) { c.translate(0, Math.round(b.d * 128 - along + im.width / 2)); c.rotate(-Math.PI / 2); }
    c.drawImage(im, 0, 0); c.restore();
  }
  for (const g of groups) {
    const positions = g.positions.sort((a, b) => a - b), count = positions.length;
    const prefix = (g.pipe ? 'pipe_' : '') + (g.input ? 'port_in_' : 'port_out_');
    const grouped = count === positions.at(-1) - positions[0] + 1 && PAYLOAD.sprites[prefix + count];
    const im = asset(grouped || PAYLOAD.sprites[prefix + '1']); if (!im) return null;
    if (grouped) edge(im, g.edge, (positions[0] + positions.at(-1) + 1) * 64);
    else for (const p of positions) edge(im, g.edge, (p + .5) * 128);
  }
  for (const face of [0, 2]) if (!has.has(face)) edge(decoration, face, b.w * 64);
  if (customBodies.size >= 128) customBodies.delete(customBodies.keys().next().value);
  customBodies.set(key, out); return out;
}
async function prepareScene(layout) {
  const keys = new Set(Object.values(PAYLOAD.sprites));
  for (const n of layout.nodes) {
    keys.add(bodyKey(n)); keys.add(n.productIcon ? productInfo(n.productIcon)?.badge : buildings[n.templateId].symbol);
    keys.add(buildings[n.templateId].connectionFrames?.[n.direction || 0]);
    keys.add(buildings[n.templateId].activeConnectionFrames?.[n.direction || 0]);
    if (n.closedPorts?.length) {
      const b = buildings[n.templateId];
      keys.add(b.bareFaces?.[n.direction]); keys.add(b.waistFaces?.[n.direction]); keys.add(b.edgeDecoration);
    }
  }
  await Promise.all([...keys].filter(Boolean).map(assetReady));
  await fontReady;
}
function saveNow() {
  clearTimeout(saveTimer);
  if (!needsSave) return;
  try { localStorage.setItem(STORAGE, JSON.stringify(data)); needsSave = false; $('saveStatus').textContent = '已保存到本机'; }
  catch { $('saveStatus').textContent = '自动保存不可用，请保存 JSON'; }
}
function scheduleSave() { needsSave = true; $('saveStatus').textContent = '保存中…'; clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 300); }
function changed(text) {
  if (selected >= data.nodes.length) selected = -1;
  $('bpName').value = data.name;
  refreshInspector(); refreshSummary(); refreshHistory(); requestDraw(); scheduleSave();
  window.BlueprintPresentation?.refresh();
  if (text) message(text);
}
function transact(operation, text) {
  const next = C.clone(data);
  try {
    operation(next);
    const valid = C.validate(next, buildings);
    if (history.commit(data, valid)) { data = valid; changed(text); return true; }
  } catch (error) { message(error.message, true); refreshInspector(); }
  return false;
}
function refreshHistory() { $('btnUndo').disabled = !history.past.length; $('btnRedo').disabled = !history.future.length; }
function undo() { if (!history.past.length) return; data = history.undo(data); selected = -1; gesture = null; changed('已撤销'); }
function redo() { if (!history.future.length) return; data = history.redo(data); selected = -1; gesture = null; changed('已重做'); }

function rectOutline(c, n, s, ox, oy, color, fill = false) {
  const f = C.footprint(n, buildings), x = ox + f.x * s, y = oy + f.z * s;
  c.strokeStyle = color; c.lineWidth = 2;
  if (fill) { c.fillStyle = color; c.globalAlpha *= .16; c.fillRect(x, y, f.w * s, f.d * s); c.globalAlpha /= .16; }
  c.strokeRect(x + 1, y + 1, f.w * s - 2, f.d * s - 2);
}
function drawNode(c, n, s, ox, oy, ports = false) {
  const b = buildings[n.templateId], f = C.footprint(n, buildings);
  const x = ox + f.x * s, y = oy + f.z * s, w = f.w * s, h = f.d * s;
  const body = nodeBody(n); if (body) c.drawImage(body, x, y, w, h);
  const iconKey = n.productIcon ? productInfo(n.productIcon)?.badge : b.symbol;
  const icon = asset(iconKey || (n.productIcon ? PAYLOAD.sprites.badge_bg : null)), side = (n.productIcon ? 120 : 126) / 128 * s;
  if (icon) c.drawImage(icon, x + (w - side) / 2, y + (h - side) / 2, side, side);
  if (n.productIcon && !iconKey) {
    c.save(); c.fillStyle = '#ffffff'; c.font = `${Math.max(9, s * .55)}px "HarmonyOS Sans SC",sans-serif`;
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('?', x + w / 2, y + h / 2); c.restore();
  }
  if (n.productIcon) for (const layer of PAYLOAD.statusLayers[n.itemStatus] || []) {
    let im = asset(layer.asset); if (!im) continue;
    if (layer.theme) im = coloredStatus(im, n.itemStatusColor || '#00ffff');
    c.drawImage(im, x + w / 2 + layer.x / 128 * s, y + h / 2 + layer.y / 128 * s, layer.w / 128 * s, layer.h / 128 * s);
  }
  const env = asset(PAYLOAD.sprites['env_effect_' + n.environmentEffect]);
  if (env) c.drawImage(env, x + w / 2 - 145 / 128 * s, y + h / 2 - (75.4 + 35) / 128 * s, 290 / 128 * s, 70 / 128 * s);
  if (ports && s >= 16) {
    for (const port of b.ports) {
      if (n.formulaMode === 'normal' && port.pipe || n.closedPorts?.includes(port.id)) continue;
      let px = port.x, pz = port.z, dir = port.dir, W = b.w, D = b.d;
      for (let turn = 0; turn < n.direction; turn++) { [px, pz] = [D - 1 - pz, px]; [W, D] = [D, W]; dir = (dir + 1) % 4; }
      const mx = x + (px + .5 + C.DV[dir][0] * .36) * s, my = y + (pz + .5 + C.DV[dir][1] * .36) * s;
      const r = Math.max(3, s * .11);
      c.fillStyle = port.pipe ? (port.input ? '#3574cd' : '#27a6b6') : (port.input ? '#ce635b' : '#52a361');
      c.beginPath(); if (port.pipe) c.arc(mx, my, r, 0, Math.PI * 2); else c.rect(mx - r, my - r, r * 2, r * 2); c.fill();
      if (s >= 36) { c.fillStyle = '#fff'; c.font = `${Math.max(9, s * .19)}px "HarmonyOS Sans SC",sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(port.n, mx, my); }
    }
  }
}
const statusColors = new Map();
function coloredStatus(image, color) {
  if (!statusColors.has(color)) {
    const out = document.createElement('canvas'); out.width = image.width; out.height = image.height;
    const c = out.getContext('2d'); c.drawImage(image, 0, 0); c.globalCompositeOperation = 'source-in'; c.fillStyle = color; c.fillRect(0, 0, out.width, out.height);
    if (statusColors.size >= 64) statusColors.delete(statusColors.keys().next().value);
    statusColors.set(color, out);
  }
  return statusColors.get(color);
}
function drawSlicedSprite(c, name, x, y, w, h, scale) {
  const im = asset(PAYLOAD.sprites[name]); if (!im || w <= 0 || h <= 0) return;
  const [left, bottom, right, top] = PAYLOAD.spriteBorders[name];
  const kx = Math.min(scale, w / Math.max(1, left + right)), ky = Math.min(scale, h / Math.max(1, top + bottom));
  const sx = [0, left, im.width - right, im.width], sy = [0, top, im.height - bottom, im.height];
  const dx = [x, x + left * kx, x + w - right * kx, x + w], dy = [y, y + top * ky, y + h - bottom * ky, y + h];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++)
    if (sx[col + 1] > sx[col] && sy[row + 1] > sy[row] && dx[col + 1] > dx[col] && dy[row + 1] > dy[row])
      c.drawImage(im, sx[col], sy[row], sx[col + 1] - sx[col], sy[row + 1] - sy[row], dx[col], dy[row], dx[col + 1] - dx[col], dy[row + 1] - dy[row]);
}
function drawNativeGrid(c, transform, rect) {
  const im = asset(PAYLOAD.sprites.grid); if (!im) return;
  const {s, ox, oy} = transform, pattern = c.createPattern(im, 'repeat');
  pattern.setTransform(new DOMMatrix([s / 128, 0, 0, s / 128, ox, oy]));
  c.save(); c.fillStyle = pattern; c.fillRect(rect.x, rect.y, rect.w, rect.h); c.restore();
}
function paintScene(c, layout, transform, options = {}) {
  const {s, ox, oy} = transform;
  if (options.grid) {
    const b = options.bounds || {x0: 0, z0: 0, x1: layout.size.x, z1: layout.size.z};
    drawNativeGrid(c, transform, options.gridRect || {x: ox + b.x0 * s, y: oy + b.z0 * s, w: (b.x1 - b.x0) * s + 1, h: (b.z1 - b.z0) * s + 1});
  }
  const occupied = C.buildingCells(layout, buildings);
  const lines = C.conveyorSprites(layout.conveyors.filter(b => !occupied.has(C.key(b.x, b.z))));
  function layer(kind) {
    for (const b of lines) if (b.kind === kind) {
      const image = asset(PAYLOAD.sprites[b.sprite]); if (!image) continue;
      c.save(); c.translate(ox + (b.x + .5) * s, oy + (b.z + .5) * s); c.rotate(b.angle * Math.PI / 180);
      c.drawImage(image, -s / 2, -s / 2, s, s); c.restore();
    }
    // A small original-sprite extension closes the padding between the grid boundary
    // and the visible port. It never exposes a whole belt tile inside a device.
    const lookup = new Map(lines.filter(b => b.kind === kind).map(b => [C.key(b.x, b.z), b]));
    for (const n of layout.nodes) {
      if (buildings[n.templateId].logistic) continue;
      for (const p of C.worldPorts(n, buildings)) {
        if (p.pipe !== (kind === 'fluid')) continue;
        const line = lookup.get(C.key(p.outX, p.outZ));
        if (!line || line.dir !== (p.dir + 2) % 4 && (line.fromDir ?? line.dir) !== p.dir) continue;
        const image = asset(PAYLOAD.sprites[kind === 'fluid' ? 'icon_pipe_grid' : 'icon_belt_grid']); if (!image) continue;
        const depth = (p.inset ?? .12) * s, edgeX = ox + p.edgeX * s, edgeY = oy + p.edgeZ * s;
        c.save(); c.beginPath();
        if (p.dir === 0) c.rect(edgeX - depth, edgeY - s / 2, depth, s);
        if (p.dir === 2) c.rect(edgeX, edgeY - s / 2, depth, s);
        if (p.dir === 1) c.rect(edgeX - s / 2, edgeY - depth, s, depth);
        if (p.dir === 3) c.rect(edgeX - s / 2, edgeY, s, depth);
        c.clip(); c.translate(ox + (p.x + .5) * s, oy + (p.z + .5) * s);
        c.rotate(p.dir * Math.PI / 2); c.drawImage(image, -s / 2, -s / 2, s, s); c.restore();
      }
    }
  }
  layer('item');
  if (!options.linesOnly) for (const [index, n] of layout.nodes.entries()) {
    c.save(); if (options.dimIndex === index) c.globalAlpha *= .25;
    drawNode(c, n, s, ox, oy, options.ports); c.restore();
  }
  layer('fluid');
  if (options.hints) {
    // Unity counter-scales these UI controls on screen. Exports use the 128 px source unit.
    const q = options.hintScale ?? s / 128;
    for (const n of layout.nodes) {
      const b = buildings[n.templateId], f = C.footprint(n, buildings);
      const cx = ox + (f.x + f.w / 2) * s, cy = oy + (f.z + f.d / 2) * s;
      const peer = C.undergroundPeer(layout.nodes, n);
      function stamp(key, x, y, w, h) { const img = asset(key); if (img) c.drawImage(img, x, y, w, h); }
      if (b.canModify && options.changeHints !== false) stamp(PAYLOAD.sprites.change_hint, cx + 67.5 / 128 * s - 44 * q, cy - 67.5 / 128 * s, 44 * q, 44 * q);
      if (!b.underground) continue;
      if (peer) {
        const pinned = options.activePair === n.undergroundPair;
        stamp((pinned ? b.activeConnectionFrames : b.connectionFrames)[n.direction], ox + f.x * s + s / 64, oy + f.z * s + s / 64, f.w * s - s / 32, f.d * s - s / 32);
        stamp(PAYLOAD.sprites[pinned ? 'udpipe_hide' : 'udpipe_show'], cx - 2 * q, cy - 40.5 * q, 44 * q, 44 * q);
      } else stamp(PAYLOAD.sprites.udpipe_disconnected, cx - 74 * q, cy + 21 * q, 148 * q, 42 * q);
    }
    if (options.activePair) {
      const pair = layout.nodes.filter(n => n.undergroundPair === options.activePair);
      if (pair.length === 2) {
        const from = pair.find(n => C.undergroundRole(n) === 'in'), to = pair.find(n => C.undergroundRole(n) === 'out');
        const center = n => { const f = C.footprint(n, buildings); return {x: ox + (f.x + f.w / 2) * s, y: oy + (f.z + f.d / 2) * s}; };
        if (from && to) {
          const a = center(from), b = center(to), dx = b.x - a.x, dy = b.y - a.y;
          c.save(); c.translate(a.x, a.y); c.rotate(Math.atan2(dy, dx));
          drawSlicedSprite(c, 'udpipe_line', 0, -s / 2, Math.hypot(dx, dy), s, s / 128); c.restore();
        }
      }
    }
  }
}
function draw() {
  const ratio = devicePixelRatio || 1;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio);
  ctx.fillStyle = '#e6e6e6'; ctx.fillRect(0, 0, canvas.width / ratio, canvas.height / ratio);
  paintScene(ctx, data, view, {grid: showGrid, ports: showPorts, hints: showHints, hintScale: .5, activePair,
    dimIndex: gesture?.type === 'move' && gesture.moved ? gesture.index : -1});
  ctx.strokeStyle = '#b5bdc2'; ctx.lineWidth = 1; ctx.strokeRect(view.ox, view.oy, data.size.x * view.s, data.size.z * view.s);
  if (hover && !gesture && tool === 'select') {
    const index = C.hit(data.nodes, buildings, hover.x, hover.z);
    const f = index >= 0 ? C.footprint(data.nodes[index], buildings)
      : data.conveyors.some(b => b.x === hover.x && b.z === hover.z) ? {x: hover.x, z: hover.z, w: 1, d: 1} : null;
    if (f) {
      const pad = 22 / 128 * view.s;
      drawSlicedSprite(ctx, 'hover_frame', view.ox + f.x * view.s - pad, view.oy + f.z * view.s - pad, f.w * view.s + pad * 2, f.d * view.s + pad * 2, view.s / 128);
    }
  }
  if (selected >= 0 && data.nodes[selected]) {
    const f = C.footprint(data.nodes[selected], buildings);
    drawSlicedSprite(ctx, 'selection_frame', view.ox + f.x * view.s, view.oy + f.z * view.s, f.w * view.s, f.d * view.s, view.s / 128);
  }
  let ghost, ignore = -1;
  if (gesture?.type === 'move' && gesture.moved) { ghost = gesture.preview; ignore = gesture.index; }
  else if (tool === 'place' && chosen && hover && !gesture) ghost = {templateId: chosen, position: {x: hover.x, z: hover.z}, direction: rotation};
  if (ghost) {
    const error = C.placementError(data, buildings, ghost, ignore);
    ctx.save(); ctx.globalAlpha = .6; drawNode(ctx, ghost, view.s, view.ox, view.oy); ctx.restore();
    rectOutline(ctx, ghost, view.s, view.ox, view.oy, error ? '#d36159' : '#4aaccb', Boolean(error));
  }
  if (gesture?.type === 'route') {
    ctx.save(); ctx.globalAlpha = .8;
    paintScene(ctx, {...data, conveyors: gesture.path}, view, {linesOnly: true}); ctx.restore();
    for (const endpoint of [gesture.startPort, gesture.endPort]) if (endpoint) {
      ctx.strokeStyle = '#1887a6'; ctx.lineWidth = 2; ctx.beginPath();
      ctx.arc(view.ox + endpoint.edgeX * view.s, view.oy + endpoint.edgeZ * view.s, Math.max(5, view.s * .17), 0, Math.PI * 2); ctx.stroke();
    }
    if (gesture.error && hover) { ctx.strokeStyle = '#c94848'; ctx.lineWidth = 2;
      ctx.strokeRect(view.ox + hover.x * view.s, view.oy + hover.z * view.s, view.s, view.s); }
  }
  $('zoom').textContent = `${Math.round(view.s / 40 * 100)}% · ${data.size.x}×${data.size.z}`;
}
function resize() {
  const r = devicePixelRatio || 1;
  canvas.width = Math.round(wrap.clientWidth * r); canvas.height = Math.round(wrap.clientHeight * r); requestDraw();
}
function fit() {
  const b = C.bounds(data, buildings, 1), w = b.x1 - b.x0, h = b.z1 - b.z0;
  view.s = Math.min(96, Math.max(6, Math.min((wrap.clientWidth - 70) / w, (wrap.clientHeight - 100) / h)));
  view.ox = (wrap.clientWidth - w * view.s) / 2 - b.x0 * view.s;
  view.oy = 30 + (wrap.clientHeight - h * view.s) / 2 - b.z0 * view.s; requestDraw();
}
function pointer(e) { const r = canvas.getBoundingClientRect(), gx = (e.clientX - r.left - view.ox) / view.s, gz = (e.clientY - r.top - view.oy) / view.s;
  return {x: Math.floor(gx), z: Math.floor(gz), gx, gz}; }
function updateRoute(end, verticalFirst) {
  try { const result = C.connectedRoute(data, buildings, gesture.start, end, gesture.kind, verticalFirst, rotation);
    gesture.path = result.path; gesture.startPort = result.start.port; gesture.endPort = result.end.port; gesture.error = '';
  } catch (error) { gesture.path = []; gesture.startPort = null; gesture.endPort = null; gesture.error = error.message; }
}
function inside(p) { return p.x >= 0 && p.z >= 0 && p.x < data.size.x && p.z < data.size.z; }
function selectTool(value) {
  tool = value; gesture = null;
  if (value !== 'select') selected = -1;
  document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  document.querySelectorAll('.building').forEach(b => b.classList.toggle('active', tool === 'place' && b.dataset.id === chosen));
  $('canvasHint').textContent = ({select: '点击选中 · 拖动移动 · R 旋转 · Delete 删除', place: '点击放置 · R 旋转 · Esc 返回选择', item: '沿拖动方向铺设传送带 · 端点吸附接口 · Shift 切换转弯顺序', fluid: '拖动铺设流体管 · 端点吸附流体口 · 可与传送带分层交叉', erase: '点击删除设备或当前格线路 · 可撤销', icon: `图标画笔：${productInfo(iconBrush)?.name || '设备符号'} · 点击设备标注 · Esc 退出`})[tool];
  refreshInspector(); requestDraw();
}
function buildList() {
  const term = $('search').value.trim().toLowerCase(), list = $('buildingList'); list.replaceChildren();
  let count = 0;
  for (const b of PAYLOAD.buildings) {
    if (term && !`${b.name} ${b.id}`.toLowerCase().includes(term)) continue;
    const button = document.createElement('button'); button.className = 'building'; button.dataset.id = b.id;
    button.classList.toggle('active', tool === 'place' && chosen === b.id);
    const image = document.createElement('img'); image.src = PAYLOAD.assets[b.palette]; image.alt = ''; image.loading = 'lazy';
    const text = document.createElement('span'), name = document.createElement('b'), size = document.createElement('small');
    name.textContent = b.name; size.textContent = `${b.w}×${b.d} · ${b.id}`;
    text.append(name, size); button.append(image, text);
    button.onclick = () => { chosen = b.id; selectTool('place'); message(`已选 ${b.name}，点击画布放置`); };
    list.append(button); count++;
  }
  $('buildingCount').textContent = `${count} / ${PAYLOAD.buildings.length} 个设备条目`;
}
function refreshInspector() {
  const n = data.nodes[selected]; $('selectionFields').hidden = !n; $('emptySelection').hidden = Boolean(n);
  if (!n) { inspectorNode = null; previewRevision++; return; }
  const b = buildings[n.templateId], d = C.dims(b, n.direction);
  $('selectedName').textContent = b.name; $('selectedId').textContent = b.id; $('selectedSize').textContent = `占地 ${d.w}×${d.d}` + (b.logistic ? ' · 物流节点' : ` · ${b.ports.length} 个原始端口`);
  $('nodePorts').disabled = b.logistic || !b.ports.some(p => p.pipe);
  // Reuse the scene renderer so the inspector also includes the selected item and hints.
  const revision = ++previewRevision, snapshot = C.clone(n);
  prepareScene({nodes: [snapshot]}).then(() => {
    if (revision !== previewRevision) return;
    const preview = document.createElement('canvas'), s = Math.min(64, 176 / d.w, 126 / d.d);
    preview.width = Math.ceil(d.w * s + 12); preview.height = Math.ceil(d.d * s + 12);
    paintScene(preview.getContext('2d'), {...data, nodes: data.nodes.map(node => node === n ? snapshot : node)},
      {s, ox: 6 - snapshot.position.x * s, oy: 6 - snapshot.position.z * s}, {hints: showHints});
    $('selectedPreview').src = preview.toDataURL();
  }).catch(error => message(error.message, true));
  $('nodeX').value = n.position.x; $('nodeZ').value = n.position.z; $('nodeDirection').value = n.direction;
  $('nodePorts').value = n.formulaMode === 'normal' ? 'normal' : 'all';
  $('nodeEnvironment').value = n.environmentEffect || '';
  $('nodeItemStatus').value = n.itemStatus || 'normal'; $('nodeItemStatus').disabled = !n.productIcon;
  $('nodeItemStatusColor').value = n.itemStatusColor || '#00ffff';
  $('itemStatusColorField').hidden = n.itemStatus !== 'limited' || !n.productIcon;
  const portList = $('portVisibility'); portList.replaceChildren();
  $('portVisibilityFields').hidden = !b.editablePorts || !b.ports.length;
  for (const p of b.ports) {
    if (!b.editablePorts) break;
    const label = document.createElement('label'); label.className = 'check';
    const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.port = p.id;
    input.checked = !n.closedPorts?.includes(p.id); input.disabled = n.formulaMode === 'normal' && p.pipe;
    label.append(input, `${['右', '下', '左', '上'][(p.dir + n.direction) % 4]} · ${p.pipe ? '管道' : '物品'}${p.input ? '入口' : '出口'} ${p.n + 1}`);
    input.onchange = () => updateSelected(node => {
      const closed = new Set(node.closedPorts || []); input.checked ? closed.delete(p.id) : closed.add(p.id);
      if (closed.size) node.closedPorts = [...closed]; else delete node.closedPorts;
    }); portList.append(label);
  }
  inspectorNode = `${selected}:${n.templateId}`;
  $('productLabel').textContent = n.templateId.includes('conditioner') ? '准入物品图标' : n.templateId === 'unloader_1' ? '取货物品图标' : '展示物品';
  $('productHelp').textContent = '图标会随蓝图和 PNG 一起保存。';
  const currentProduct = productInfo(n.productIcon);
  $('selectedProductName').textContent = n.productIcon ? currentProduct?.name || n.productIcon : '设备符号';
  const currentImage = currentProduct?.badge || b.symbol || b.faces[0];
  $('selectedProductImage').src = PAYLOAD.assets[currentImage];
  $('undergroundFields').hidden = !b.underground;
  const peers = $('undergroundPeer'); peers.replaceChildren(new Option('未连接', '-1'));
  if (b.underground) for (const [i, candidate] of data.nodes.entries()) {
    if (!C.undergroundRole(candidate) || C.undergroundRole(candidate) === C.undergroundRole(n)) continue;
    peers.add(new Option(`${buildings[candidate.templateId].name} (${candidate.position.x}, ${candidate.position.z})${candidate.undergroundPair && candidate.undergroundPair !== n.undergroundPair ? ' · 将重新配对' : ''}`, String(i)));
  }
  const peer = C.undergroundPeer(data.nodes, n);
  peers.value = String(peer ? data.nodes.indexOf(peer) : -1);
  $('btnConnection').disabled = !peer;
  $('btnConnection').textContent = peer && activePair === n.undergroundPair ? '收起连接' : '查看连接';
  $('nodeWarning').textContent = n.productIcon && !productInfo(n.productIcon)?.badge ? `未找到 ${n.productIcon} 的图片；导入值会原样保存。` : '';
}
function openProductLibrary() {
  $('productSearch').value = ''; $('productScope').value = 'all'; $('productAvailability').value = 'available'; productLimit = 80;
  const n = data.nodes[selected];
  $('libraryTarget').textContent = n ? `为「${buildings[n.templateId].name}」选择展示物品` : '浏览全部图标，选图后点击画布上的设备标注。';
  $('productScope').querySelector('[value="recommended"]').disabled = !n;
  refreshProductOptions(); $('itemLibrary').showModal(); $('productSearch').focus();
}
function chooseProduct(id) {
  $('itemLibrary').close();
  if (selected >= 0) updateSelected(n => { n.productIcon = id || null; });
  else { iconBrush = id || null; selectTool('icon'); message(`已选择 ${productInfo(id)?.name || '设备符号'}，点击设备标注`); }
}
function refreshProductOptions() {
  const n = data.nodes[selected], b = n && buildings[n.templateId];
  const scope = $('productScope').value, availability = $('productAvailability').value;
  const terms = $('productSearch').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const source = scope === 'recommended' ? (b?.products || []).map(productKey) : Object.keys(PAYLOAD.products);
  const options = [...new Set(source)].filter(id => {
    const p = productInfo(id);
    if (!p || !terms.every(term => `${id} ${p.name}`.toLowerCase().includes(term))) return false;
    if (availability === 'available' && !p.badge || availability === 'missing' && p.badge) return false;
    return !(scope === 'solid' && p.phase !== 1 || scope === 'liquid' && p.phase !== 2 || scope === 'gas' && p.phase !== 4 || scope === 'environment' && !p.gas);
  }).sort((a, b) => productInfo(a).name.localeCompare(productInfo(b).name, 'zh-CN'));
  const results = $('productResults'); results.replaceChildren();
  for (const id of options.slice(0, productLimit)) {
    const p = productInfo(id), button = document.createElement('button'); button.className = 'product-card'; button.dataset.product = id;
    button.classList.toggle('active', productKey(n?.productIcon) === id);
    const reason = p.iconStatus === 'empty_icon_configuration' ? '游戏表未配置图标' : '当前安装资源中无此图标';
    button.title = `${p.name}\n${id}${p.badge ? p.iconStatus === 'same_id_original_sprite' ? '\n使用同名原图（表内未指定）' : '' : '\n' + reason}`;
    if (p.badge) { const img = document.createElement('img'); img.src = PAYLOAD.assets[p.badge]; img.alt = ''; img.loading = 'eager'; button.append(img); }
    else { const placeholder = document.createElement('span'); placeholder.className = 'missing-thumb'; placeholder.textContent = '?'; button.append(placeholder); button.disabled = true; button.classList.add('missing'); }
    const label = document.createElement('span'); label.textContent = p.name; button.append(label);
    if (!p.badge) { const why = document.createElement('small'); why.textContent = reason; button.append(why); }
    button.onclick = () => chooseProduct(id); results.append(button);
  }
  $('productCount').textContent = `找到 ${options.length} 个 · 已显示 ${Math.min(productLimit, options.length)}`;
  $('productEmpty').hidden = options.length !== 0; $('btnMoreProducts').hidden = options.length <= productLimit;
}
function refreshSummary() {
  const counts = new Map();
  for (const [index, n] of data.nodes.entries()) {
    const b = buildings[n.templateId], key = b.itemId || b.id;
    if (!counts.has(key)) counts.set(key, {b, indices: []});
    counts.get(key).indices.push(index);
  }
  $('nodeCount').textContent = `${data.nodes.length} / 160`;
  const list = $('summaryList'); list.replaceChildren();
  function card(id, b, count, title) {
    const row = document.createElement('button'); row.className = 'summary-card'; row.dataset.item = id;
    row.style.setProperty('--rarity', b.rarityColor || '#9b9b9b');
    row.title = title; row.setAttribute('aria-label', title);
    const image = document.createElement('img'); image.src = PAYLOAD.assets[b.palette]; image.alt = '';
    const quantity = document.createElement('b'); quantity.textContent = count; row.append(image, quantity); list.append(row);
    return row;
  }
  for (const [id, {b, indices}] of counts) {
    const row = card(id, b, indices.length, `${b.name} × ${indices.length} · 点击定位`);
    row.onclick = () => {
      const next = indices[(indices.indexOf(selected) + 1) % indices.length]; selectTool('select'); selected = next;
      const f = C.footprint(data.nodes[selected], buildings);
      const cx = view.ox + (f.x + f.w / 2) * view.s, cy = view.oy + (f.z + f.d / 2) * view.s;
      if (cx < 20 || cx > wrap.clientWidth - 20 || cy < 70 || cy > wrap.clientHeight - 20) {
        view.ox = wrap.clientWidth / 2 - (f.x + f.w / 2) * view.s;
        view.oy = wrap.clientHeight / 2 - (f.z + f.d / 2) * view.s;
      }
      refreshInspector(); requestDraw(); message(`已定位 ${b.name} (${data.nodes[selected].position.x}, ${data.nodes[selected].position.z})`);
    };
  }
  const occupied = C.buildingCells(data, buildings);
  for (const [kind, b] of Object.entries(PAYLOAD.lineItems)) {
    const count = data.conveyors.filter(c => c.kind === kind && !occupied.has(`${c.x},${c.z}`)).length;
    if (!count) continue;
    const row = card(b.id, b, count, `${b.name} · ${count} 格 · 点击继续铺设`);
    row.onclick = () => selectTool(kind);
  }
}
function eraseAt(p) {
  const index = C.hit(data.nodes, buildings, p.x, p.z);
  if (index >= 0) { selected = -1; transact(d => C.removeNode(d.nodes, index), '已删除设备，可撤销'); }
  else transact(d => { d.conveyors = d.conveyors.filter(b => b.x !== p.x || b.z !== p.z); }, '已删除该格线路，可撤销');
}
function deleteSelected() {
  if (selected < 0) return;
  const index = selected; selected = -1; transact(d => C.removeNode(d.nodes, index), '已删除设备，可撤销');
}
function rotate() {
  if (gesture?.type === 'move') {
    // The drag preview owns all pending edits. Commit position and direction together
    // on pointerup; Escape/cancel leaves the original document and history untouched.
    gesture.preview.direction = (gesture.preview.direction + 1) % 4;
    gesture.moved = true;
    message(`移动中的设备已旋转至 ${gesture.preview.direction * 90}°，松手放置`);
    requestDraw();
  }
  else if (selected >= 0 && tool === 'select') transact(d => { d.nodes[selected].direction = (d.nodes[selected].direction + 1) % 4; }, '设备已旋转');
  else { rotation = (rotation + 1) % 4; message(tool === 'item' || tool === 'fluid' ? `单格线路朝向：${['右', '下', '左', '上'][rotation]}` : `放置朝向：${rotation * 90}°`); requestDraw(); }
}
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('pointerdown', e => {
  if (e.button > 2) return;
  const p = pointer(e); canvas.focus();
  if (e.button === 2) { if (inside(p)) eraseAt(p); return; }
  canvas.setPointerCapture(e.pointerId);
  if (e.button === 1 || space) { e.preventDefault(); gesture = {type: 'pan', x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy}; return; }
  if (!inside(p)) return;
  const index = C.hit(data.nodes, buildings, p.x, p.z);
  if (tool === 'icon') {
    if (index >= 0) { selected = index; updateSelected(n => { n.productIcon = iconBrush; }); }
    else message('点击设备可标注物品，Esc 退出图标画笔');
    return;
  }
  if (tool === 'erase') { eraseAt(p); return; }
  if (tool === 'item' || tool === 'fluid') { gesture = {type: 'route', start: p, kind: tool, path: []}; updateRoute(p, e.shiftKey); requestDraw(); return; }
  if (index >= 0) {
    selectTool('select'); selected = index;
    if (innerWidth <= 860) document.body.classList.add('inspect-open');
    gesture = {type: 'move', index, start: p, original: C.clone(data.nodes[index]), preview: C.clone(data.nodes[index]), moved: false};
    refreshInspector(); requestDraw(); return;
  }
  if (tool === 'place' && chosen) {
    const n = {templateId: chosen, position: {x: p.x, z: p.z}, direction: rotation, productIcon: null};
    transact(d => d.nodes.push(n), `已放置 ${buildings[chosen].name}`);
  } else { selected = -1; refreshInspector(); requestDraw(); }
});
canvas.addEventListener('pointermove', e => {
  const p = pointer(e); hover = inside(p) ? p : null;
  if (gesture?.type === 'pan') { view.ox = gesture.ox + e.clientX - gesture.x; view.oy = gesture.oy + e.clientY - gesture.y; }
  else if (gesture?.type === 'move') {
    gesture.preview.position = {x: gesture.original.position.x + p.x - gesture.start.x, z: gesture.original.position.z + p.z - gesture.start.z};
    gesture.moved = gesture.moved || p.x !== gesture.start.x || p.z !== gesture.start.z;
  } else if (gesture?.type === 'route') {
    const end = {...p, x: Math.max(0, Math.min(data.size.x - 1, p.x)), z: Math.max(0, Math.min(data.size.z - 1, p.z))};
    updateRoute(end, e.shiftKey);
  }
  requestDraw();
});
canvas.addEventListener('pointerup', e => {
  const current = gesture; gesture = null;
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  if (current?.type === 'move' && current.moved) transact(d => { d.nodes[current.index] = current.preview; }, '设备位置已更新');
  if (current?.type === 'move' && !current.moved && showHints) {
    const n = data.nodes[current.index], b = buildings[n.templateId], f = C.footprint(n, buildings), r = canvas.getBoundingClientRect();
    const cx = view.ox + (f.x + f.w / 2) * view.s, cy = view.oy + (f.z + f.d / 2) * view.s;
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const within = (left, top) => x >= left && x <= left + 22 && y >= top && y <= top + 22;
    if (b.canModify && x > cx + Math.min(4, view.s * .1) && y < cy - Math.min(4, view.s * .1)
        && within(cx + 67.5 / 128 * view.s - 22, cy - 67.5 / 128 * view.s)) openProductLibrary();
    else if (b.underground && within(cx - 1, cy - 20.25)) toggleConnection();
  }
  if (current?.type === 'route') {
    if (current.error) message(current.error, true);
    else transact(d => { d.conveyors = C.mergeRoutes(d.conveyors, current.path); }, `已铺设 ${current.path.length} 格线路${current.startPort || current.endPort ? ' · 已吸附接口' : ''}`);
  }
  requestDraw();
});
canvas.addEventListener('pointercancel', () => { gesture = null; requestDraw(); });
canvas.addEventListener('pointerleave', () => { if (!gesture) { hover = null; requestDraw(); } });
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const next = Math.min(128, Math.max(6, view.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15))), k = next / view.s;
  view.ox = x - (x - view.ox) * k; view.oy = y - (y - view.oy) * k; view.s = next; requestDraw();
}, {passive: false});
window.addEventListener('keydown', e => {
  if ($('presentationDialog')?.open || $('fontLicenseDialog').open) return;
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') { e.preventDefault(); downloadJson(); return; }
  if ($('itemLibrary').open) { if (e.code === 'Escape') { e.preventDefault(); $('itemLibrary').close(); } return; }
  if (e.target.closest('input,select,textarea,[contenteditable="true"]')) return;
  if (e.ctrlKey || e.metaKey) {
    if (e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    if (e.code === 'KeyY') { e.preventDefault(); redo(); }
    if (e.code === 'KeyS') { e.preventDefault(); downloadJson(); }
    return;
  }
  if (e.code === 'Space') { e.preventDefault(); space = true; }
  if (e.repeat) return;
  if (e.code === 'Escape') { gesture = null; selected = -1; selectTool('select'); }
  else if (e.code === 'KeyR') rotate();
  else if (e.code === 'KeyF') fit();
  else if (e.code === 'Delete' || e.code === 'Backspace') { e.preventDefault(); deleteSelected(); }
  else if (['KeyV', 'KeyP', 'KeyB', 'KeyL', 'KeyE'].includes(e.code)) selectTool({KeyV: 'select', KeyP: 'place', KeyB: 'item', KeyL: 'fluid', KeyE: 'erase'}[e.code]);
});
window.addEventListener('keyup', e => { if (e.code === 'Space') space = false; });
window.addEventListener('blur', () => { space = false; gesture = null; hover = null; requestDraw(); commitName(); saveNow(); });
window.addEventListener('resize', resize);
window.addEventListener('pagehide', () => { commitName(); saveNow(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { commitName(); saveNow(); } });

function updateSelected(operation) { if (selected >= 0) transact(d => operation(d.nodes[selected]), '设备属性已更新'); }
$('nodeX').onchange = () => updateSelected(n => { n.position.x = $('nodeX').valueAsNumber; });
$('nodeZ').onchange = () => updateSelected(n => { n.position.z = $('nodeZ').valueAsNumber; });
$('nodeDirection').onchange = () => updateSelected(n => { n.direction = Number($('nodeDirection').value); });
$('btnItemLibrary').onclick = openProductLibrary;
$('btnChooseProduct').onclick = openProductLibrary;
$('btnCloseLibrary').onclick = () => $('itemLibrary').close();
$('btnClearProduct').onclick = () => chooseProduct('');
$('productSearch').oninput = () => { productLimit = 80; refreshProductOptions(); };
$('productScope').onchange = $('productAvailability').onchange = () => { productLimit = 80; refreshProductOptions(); };
$('btnMoreProducts').onclick = () => { productLimit += 80; refreshProductOptions(); };
$('undergroundPeer').onchange = () => {
  activePair = null;
  transact(d => C.pairUnderground(d.nodes, selected, Number($('undergroundPeer').value)), '暗管配对已更新');
};
function toggleConnection() {
  const n = data.nodes[selected]; if (!n || !C.undergroundPeer(data.nodes, n)) return;
  activePair = activePair === n.undergroundPair ? null : n.undergroundPair;
  refreshInspector(); requestDraw();
}
$('btnConnection').onclick = toggleConnection;
canvas.addEventListener('dblclick', () => {
  const n = data.nodes[selected]; if (!n) return;
  if (buildings[n.templateId].underground) toggleConnection();
  else openProductLibrary();
});
$('nodePorts').onchange = () => updateSelected(n => { if ($('nodePorts').value === 'normal') n.formulaMode = 'normal'; else delete n.formulaMode; });
$('nodeEnvironment').onchange = () => updateSelected(n => { if ($('nodeEnvironment').value) n.environmentEffect = $('nodeEnvironment').value; else delete n.environmentEffect; });
$('nodeItemStatus').onchange = () => updateSelected(n => { if ($('nodeItemStatus').value === 'normal') delete n.itemStatus; else n.itemStatus = $('nodeItemStatus').value; });
$('nodeItemStatusColor').onchange = () => updateSelected(n => { n.itemStatusColor = $('nodeItemStatusColor').value; });
$('btnFontLicense').onclick = () => $('fontLicenseDialog').showModal();
$('btnCloseFontLicense').onclick = () => $('fontLicenseDialog').close();
$('btnResetPorts').onclick = () => updateSelected(n => { delete n.closedPorts; delete n.formulaMode; });
$('bpName').onchange = () => transact(d => { d.name = $('bpName').value.trim() || '未命名蓝图'; }, '名称已更新');
function commitName() { if ($('bpName').value.trim() !== data.name) $('bpName').onchange(); }
function download(blob, filename) {
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function filename(extension) { return (data.name || 'blueprint').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') + extension; }
function downloadJson() { commitName(); download(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}), filename('.json')); message('JSON 已导出'); }
async function exportCanvas(layout = data, cell = Number($('exportScale').value), transparent = $('transparent').checked, hints = showHints) {
  layout = C.clone(layout);
  if (![40, 64, 128].includes(cell)) throw Error('无效的导出分辨率');
  await prepareScene(layout);
  const b = C.bounds(layout, buildings, 1), top = transparent ? 0 : 48;
  const out = document.createElement('canvas'); out.width = (b.x1 - b.x0) * cell; out.height = (b.z1 - b.z0) * cell + top;
  const c = out.getContext('2d');
  if (!transparent) {
    c.fillStyle = '#e6e6e6'; c.fillRect(0, 0, out.width, out.height);
    c.fillStyle = '#454545'; c.font = '20px "HarmonyOS Sans SC",sans-serif'; c.textBaseline = 'middle'; c.fillText(layout.name, 18, 24, out.width - 36);
  }
  // Coordinates are shifted exactly once; rotated dimensions come from Core.bounds.
  paintScene(c, layout, {s: cell, ox: -b.x0 * cell, oy: top - b.z0 * cell}, {grid: !transparent && showGrid, bounds: b, hints, activePair: layout.presentation?.connectionPair || null});
  return out;
}
$('btnPng').onclick = async () => {
  commitName(); $('btnPng').disabled = true; message('正在生成 PNG…');
  try { const out = await exportCanvas(); const blob = await new Promise(resolve => out.toBlob(resolve, 'image/png')); if (!blob) throw Error('PNG 编码失败');
    download(blob, filename('.png')); message(`PNG 已导出：${out.width}×${out.height}`);
  } catch (error) { message(error.message, true); } finally { $('btnPng').disabled = false; }
};
function importLayout(input) {
  const next = C.validate(input, buildings);
  selected = -1; gesture = null; activePair = null;
  if (history.commit(data, next)) { data = next; changed(`已导入 ${data.nodes.length} 个设备 / ${data.conveyors.length} 段线路`); }
  selectTool('select');
  fit();
  const missing = data.nodes.filter(n => n.productIcon && !productInfo(n.productIcon)?.badge).length;
  if (missing) message(`导入完成；${missing} 个产物缺图，ID 已保留`, true);
}
$('fileIn').onchange = async e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  try { if (file.size > 10 * 1024 * 1024) throw Error('JSON 文件过大'); importLayout(JSON.parse(await file.text())); }
  catch (error) { message('导入失败：' + error.message, true); }
};
$('btnImport').onclick = () => $('fileIn').click();
$('btnJson').onclick = downloadJson;
$('btnDemo').onclick = () => { importLayout(PAYLOAD.demo); selectTool('select'); };
$('btnClear').onclick = () => { selected = -1; transact(d => { d.nodes = []; d.conveyors = []; }, '布局已清空，可撤销'); };
$('btnDeleteNode').onclick = deleteSelected;
$('btnUndo').onclick = undo; $('btnRedo').onclick = redo; $('btnFit').onclick = fit;
$('btnGrid').onclick = () => { showGrid = !showGrid; $('btnGrid').textContent = `网格：${showGrid ? '开' : '关'}`; requestDraw(); };
$('btnPorts').onclick = () => { showPorts = !showPorts; $('btnPorts').textContent = `端口标记：${showPorts ? '开' : '关'}`; requestDraw(); };
$('btnHints').onclick = () => { showHints = !showHints; $('btnHints').textContent = `原版提示：${showHints ? '开' : '关'}`; refreshInspector(); requestDraw(); };
$('btnInspector').onclick = () => document.body.classList.toggle('inspect-open');
$('btnCloseInspector').onclick = () => document.body.classList.remove('inspect-open');
$('search').oninput = buildList;
document.querySelectorAll('[data-tool]').forEach(button => { button.onclick = () => selectTool(button.dataset.tool); });
// Small public API supports deterministic offline verification and embedding.
window.BlueprintEditor = {getData: () => C.clone(data), importLayout, exportCanvas, ready: null};
buildList(); refreshInspector(); refreshSummary(); refreshHistory(); $('bpName').value = data.name;
resize(); fit(); selectTool('select');
window.BlueprintEditor.ready = prepareScene(data).then(() => {
  $('loading').hidden = true; requestDraw();
  message(restoreError || (data.nodes.length ? '已恢复本机草稿' : '选择设备或点击“示例”开始编辑'), Boolean(restoreError));
}).catch(error => { $('loading').textContent = error.message; message(error.message, true); });
