/* Complete game-style presentation. The same canvas is previewed and exported. */
(function () {
  'use strict';
  const native = PAYLOAD.presentation, dialog = $('presentationDialog');
  const colors = {blue: ['蓝色', '#64d0fe'], cyan: ['青色', '#4fecce'], yellow: ['黄色', '#fbfd20'],
    green: ['绿色', '#d0f170'], purple: ['紫色', '#d3bafe'], orange: ['橙色', '#fea760'], gray: ['灰色', '#d9d9d9']};
  let draft = null, revision = 0, coverLimit = 60, renderTimer = 0;
  const base = {creatorId: '', tags: [], description: '', coverId: '', coverColor: 'blue', showChangeHints: false, connectionPair: '', viewport: {zoom: 1, x: .5, y: .5}};
  const details = layout => ({...layout.presentation, ...Object.fromEntries(Object.entries(base).map(([k, value]) => [k, layout.presentation?.[k] ?? value]))});
  const coverFor = id => Object.hasOwn(native.covers, id) ? native.covers[id] : native.covers[''];
  function inventory(layout) {
    const groups = new Map();
    for (const n of layout.nodes) {
      const b = buildings[n.templateId], id = b.itemId || b.id;
      if (!groups.has(id)) groups.set(id, {...b, id, count: 0});
      if (!b.logistic) groups.get(id).count++;
    }
    const occupied = C.buildingCells(layout, buildings);
    for (const [kind, item] of Object.entries(PAYLOAD.lineItems)) {
      if (layout.conveyors.some(c => c.kind === kind && !occupied.has(C.key(c.x, c.z)))) groups.set(item.id, {...item, count: 0});
    }
    // BlueprintContent._RefreshDeviceCells / UIConst.COMMON_ITEM_SORT_KEYS.
    // Utils.genSortFunction defaults to descending when isIncremental is omitted.
    return [...groups.values()].sort((a, b) => b.sortId1 - a.sortId1 || b.sortId2 - a.sortId2 || b.id.localeCompare(a.id));
  }
  function textLines(c, value, width, font) {
    c.font = font;
    const lines = [];
    for (const paragraph of String(value).split('\n')) {
      let line = '';
      for (const char of paragraph) {
        if (line && c.measureText(line + char).width > width) { lines.push(line); line = ''; }
        line += char;
      }
      lines.push(line);
    }
    return lines;
  }
  function metrics(layout) {
    const c = document.createElement('canvas').getContext('2d'), p = details(layout);
    const nameLines = textLines(c, layout.name, 336, '500 34px "HarmonyOS Sans SC",sans-serif');
    const description = p.description ? textLines(c, p.description, 532, '24px "HarmonyOS Sans SC",sans-serif') : [];
    const tags = [], start = 1942; let x = start, y = Math.max(409, 218 + nameLines.length * 43 + 102);
    const creatorY = y - 35;
    c.font = '25px "HarmonyOS Sans SC",sans-serif';
    for (const value of p.tags) {
      const width = Math.min(532, c.measureText(value).width + 50);
      if (x + width > 2486) { x = start; y += 40; }
      tags.push({value, x, y, width}); x += width + 6;
    }
    const descY = y + 50, listY = Math.max(506, description.length ? descY + description.length * 34 + 55 : y + 97);
    const items = inventory(layout), height = Math.max(1440, listY + Math.ceil(items.length / 4) * 143 + 100);
    return {p, items, nameLines, description, tags, tagY: 409, creatorY, descY, listY, height};
  }
  function viewportTransform(layout, m = metrics(layout)) {
    const b = C.bounds(layout, buildings, 0), gridW = b.x1 - b.x0, gridH = b.z1 - b.z0;
    const area = {x: 48, y: 194, w: 1800, h: m.height - 312};
    const v = m.p.viewport, s = Math.min(116, 1744 / gridW, area.h / gridH) * v.zoom;
    const overflowX = Math.max(0, gridW * s - area.w), overflowY = Math.max(0, gridH * s - area.h);
    return {b, area, s, gridW, gridH, overflowX, overflowY,
      ox: area.x + Math.max(0, (area.w - gridW * s) / 2) - overflowX * v.x - b.x0 * s,
      oy: area.y + Math.max(0, (area.h - gridH * s) / 2) - overflowY * v.y - b.z0 * s};
  }
  function stamp(c, key, x, y, width, height, alpha = 1, contain = false) {
    const im = asset(key); if (!im) return;
    c.save(); c.globalAlpha *= alpha;
    if (contain) { const s = Math.min(width / im.width, height / im.height);
      c.drawImage(im, x + (width - im.width * s) / 2, y + (height - im.height * s) / 2, im.width * s, im.height * s); }
    else c.drawImage(im, x, y, width, height);
    c.restore();
  }
  function roundRect(c, x, y, w, h, r, fill) { c.fillStyle = fill; c.beginPath(); c.roundRect(x, y, w, h, r); c.fill(); }
  function label(c, text, x, y, size, color, weight = '') {
    c.font = `${weight ? weight + ' ' : ''}${size}px "HarmonyOS Sans SC",sans-serif`; c.fillStyle = color;
    c.textBaseline = 'top'; c.textAlign = 'left'; c.fillText(text, x, y);
  }
  function drawCard(c, item, x, y) {
    const w = 130, h = 130;
    c.save(); c.shadowColor = '#0003'; c.shadowBlur = 5; c.shadowOffsetY = 3;
    roundRect(c, x, y, w, h, 3, '#222325'); c.restore();
    c.save(); c.beginPath(); c.roundRect(x, y, w, h, 3); c.clip();
    stamp(c, native.sprites.bg_item_small_black, x - 2, y - 2, w + 4, h + 4);
    stamp(c, native.rarityLayers[item.rarityColor], x, y + 76, w, 54);
    c.fillStyle = item.rarityColor || '#999'; c.fillRect(x, y + h - 6, w, 6);
    stamp(c, native.covers[item.id]?.asset || item.palette, x + 2, y + 1, 126, 119, 1, true);
    stamp(c, native.sprites.deco_item_dot, x + 5, y + 5, 36, 5, .55);
    if (item.count) {
      c.shadowColor = '#000'; c.shadowBlur = 4; c.font = '32px "HarmonyOS Sans SC",sans-serif';
      c.fillStyle = '#f4f4f4'; c.textAlign = 'center'; c.textBaseline = 'bottom'; c.fillText(item.count, x + w / 2, y + h - 5);
    }
    c.restore();
  }
  function paintPresentation(c, layout, m) {
    const {p, height: H} = m, panelX = 1908, panelW = 608;
    c.fillStyle = '#e6e6e6'; c.fillRect(0, 0, 2560, H);
    // Top navigation, original topographic strips and original close icon.
    c.fillStyle = '#ededed'; c.fillRect(0, 0, 2560, 116);
    stamp(c, native.sprites.deco_fac_blueprint_6, 0, 0, 970, 145, .6);
    stamp(c, native.sprites.deco_fac_blueprint_5, 1350, 0, 1120, 124, .6);
    stamp(c, native.sprites.deco_fac_blueprint_24, 65, 2, 216, 108, .22);
    stamp(c, native.sprites.deco_assembly07_new, 67, 28, 82, 15);
    stamp(c, native.sprites.deco_fac_blueprint_28, 1914, 34, 356, 60);
    label(c, '// 蓝图预览', 67, 48, 28, '#161616', '600');
    stamp(c, native.sprites.close_btn_bg_shadeless, 2430, 26, 64, 64);
    // Entire layout fits the left viewport; the metadata width is independent of grid size.
    const {gridW, gridH, s, ox, oy, area, overflowX, overflowY} = viewportTransform(layout, m);
    c.save(); c.beginPath(); c.rect(0, 117, 1884, H - 175); c.clip();
    paintScene(c, layout, {s, ox, oy}, {grid: true, gridRect: {x: 0, y: 117, w: 1884, h: H - 175},
      hints: true, changeHints: p.showChangeHints, activePair: p.connectionPair || null}); c.restore();
    label(c, '蓝图预览', 85, 142, 27, '#8d8d8d'); c.fillStyle = '#9d9d9d'; c.fillRect(68, 142, 8, 26);
    c.fillStyle = '#444';
    if (overflowY) {
      const track = H - 250, thumb = Math.max(70, track * area.h / (area.h + overflowY));
      c.fillRect(1885, 149 + (track - thumb) * p.viewport.y, 8, thumb);
    }
    // Soft masks inside the drawing viewport, never over the detail panel.
    for (const [x0, x1] of [[0, 44], [1884, 1840]]) {
      const edge = c.createLinearGradient(x0, 0, x1, 0); edge.addColorStop(0, '#e6e6e6'); edge.addColorStop(1, '#e6e6e600');
      c.fillStyle = edge; c.fillRect(Math.min(x0, x1), 172, Math.abs(x1 - x0), H - 265);
    }
    const fade = c.createLinearGradient(0, H - 150, 0, H);
    fade.addColorStop(0, '#e6e6e600'); fade.addColorStop(1, '#d4d4d4'); c.fillStyle = fade; c.fillRect(0, H - 150, 1908, 150);
    if (overflowX) {
      const track = 1770, thumb = Math.max(90, track * area.w / (area.w + overflowX));
      c.fillStyle = '#444'; c.fillRect(65 + (track - thumb) * p.viewport.x, H - 85, thumb, 8);
    }
    for (const x of [49, 1870]) for (const y of [176, H - 81]) { c.fillStyle = '#999'; c.fillRect(x, y, 8, 8); }
    // Fixed detail panel: neutral vertical wash, grid texture and lens watermark.
    stamp(c, native.sprites.deco_fac_blueprint_light, panelX, 116, panelW, H - 116);
    c.save(); c.beginPath(); c.rect(panelX, 116, panelW, 368); c.clip();
    for (let x = panelX; x < panelX + panelW; x += 28) stamp(c, native.sprites.deco_fac_blueprint_30, x, 116, 28, 368);
    c.restore();
    c.save(); c.beginPath(); c.rect(panelX, 116, panelW, 260); c.clip();
    c.strokeStyle = '#20202516'; c.lineWidth = 1; c.beginPath();
    for (let x = panelX; x < 2516; x += 14) { c.moveTo(x, 116); c.lineTo(x, 376); }
    for (let y = 116; y < 376; y += 14) { c.moveTo(panelX, y); c.lineTo(2516, y); } c.stroke();
    stamp(c, native.sprites.icon_fac_blueprint_save_big, 2290, 116, 226, 226);
    c.restore();
    let stripY = 116;
    for (const [color, height] of [['#fff100', 123], ['#f955ff', 63], ['#00d2ff', 64]]) { c.fillStyle = color; c.fillRect(panelX, stripY, 7, height); stripY += height; }
    label(c, '蓝图详情', 1930, 142, 28, '#b8b8bc');
    stamp(c, native.sprites['icon_fac_blueprint_bg_' + p.coverColor], 1908, 125, 240, 240, 1, true);
    const cover = coverFor(p.coverId);
    // BlueprintIcon prefab: 256-square paper, centered 156-square item with x offset 5.
    const iconSize = 240 * 156 / 256 * (p.coverId.startsWith('[gas]') ? .7 : 1);
    stamp(c, cover.asset, 2033 - iconSize / 2, 245 - iconSize / 2, iconSize, iconSize, 1, true);
    m.nameLines.forEach((line, i) => label(c, line, 2122, 224 + i * 43, 34, '#f5f5f3', '500'));
    c.font = '500 34px "HarmonyOS Sans SC",sans-serif';
    for (const [bx, by, direction] of [[2117, 231, -1], [2128 + c.measureText(m.nameLines.at(-1)).width, 231 + (m.nameLines.length - 1) * 43, 1]]) {
      c.strokeStyle = '#bdbdbd'; c.lineWidth = 2; c.beginPath(); c.moveTo(bx, by); c.lineTo(bx + direction * 6, by); c.lineTo(bx + direction * 6, by + 23); c.lineTo(bx, by + 23); c.stroke();
    }
    const sizeY = 235 + m.nameLines.length * 43;
    stamp(c, native.sprites.deco_fac_blueprint_size, 2110, sizeY + 1, 25, 25, .5);
    label(c, '蓝图尺寸', 2142, sizeY, 24, '#b8b8bc');
    label(c, `${gridW}×${gridH}`, 2110, sizeY + 28, 34, '#f3f3f3');
    label(c, `创作者ID.${p.creatorId || '—'}`, 1940, m.creatorY, 24, '#444448');
    stamp(c, native.sprites.bg_fac_blueprint_more, 2446, m.creatorY - 10, 45, 45);
    label(c, '···', 2454, m.creatorY - 2, 24, '#888');
    for (const tag of m.tags) { roundRect(c, tag.x, tag.y, tag.width, 33, 17, '#e5e5e5');
      label(c, tag.value, tag.x + 25, tag.y + 1, 25, '#444448'); }
    if (!m.tags.length) {
      const y = m.creatorY + 35; c.strokeStyle = '#ffffff25'; c.lineWidth = 3; c.beginPath(); c.roundRect(1942, y, 104, 29, 15); c.stroke();
      c.strokeStyle = '#ffffff55'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(1986, y + 6); c.lineTo(2003, y + 23); c.stroke();
    }
    m.description.forEach((line, i) => label(c, line, 1940, m.descY + i * 34, 24, '#4e4e52'));
    label(c, '设备一览', 1940, m.listY - 38, 29, '#515154');
    m.items.forEach((item, i) => drawCard(c, item, 1940 + (i % 4) * 142, m.listY + Math.floor(i / 4) * 143));
    if (!m.items.length) label(c, '放置设备后自动生成', 1940, m.listY + 8, 24, '#777');
    c.fillStyle = '#27282a'; c.fillRect(2516, 116, 44, H - 116);
    for (let y = 195; y < H; y += 425) stamp(c, native.sprites.deco_fac_blueprint_29, 2527, y, 24, 425);
    stamp(c, native.sprites.deco_fac_blueprint_25, 0, 0, 2560, H, .5);
  }
  async function exportPreview(layout = data, width = 2560) {
    layout = C.validate(layout, buildings);
    if (![1920, 2560, 3840].includes(width)) throw Error('请选择有效的完整预览分辨率');
    await fontReady;
    const m = metrics(layout), keys = new Set(Object.values(native.sprites));
    m.items.forEach(i => { keys.add(native.covers[i.id]?.asset || i.palette); keys.add(native.rarityLayers[i.rarityColor]); }); keys.add(coverFor(m.p.coverId).asset);
    await Promise.all([prepareScene(layout), ...[...keys].map(assetReady)]);
    const out = document.createElement('canvas'); out.width = width; out.height = Math.round(m.height * width / 2560);
    const c = out.getContext('2d'); c.scale(width / 2560, width / 2560); paintPresentation(c, layout, m);
    return out;
  }
  function readForm() {
    draft.name = $('presentationName').value.trim() || '未命名蓝图';
    draft.presentation.creatorId = $('presentationCreator').value.trim();
    draft.presentation.description = $('presentationDescription').value.trim();
    draft.presentation.tags = [...new Set($('presentationTags').value.split(/[,，、\n]/).map(s => s.trim()).filter(Boolean))];
    draft.presentation.viewport = {zoom: Number($('presentationZoom').value) / 100,
      x: Number($('presentationPanX').value) / 100, y: Number($('presentationPanY').value) / 100};
    draft.presentation.showChangeHints = $('presentationChangeHints').checked;
    draft.presentation.connectionPair = $('presentationConnectionPair').value;
    return C.validate(draft, buildings);
  }
  async function render() {
    const rev = ++revision;
    try {
      const layout = readForm(); $('presentationError').textContent = '';
      const out = await exportPreview(layout, 1920);
      if (rev !== revision || !dialog.open) return;
      const cv = $('presentationCanvas'); cv.width = out.width; cv.height = out.height; cv.getContext('2d').drawImage(out, 0, 0);
      const b = C.bounds(layout, buildings, 0), count = inventory(layout).length;
      $('presentationAuto').textContent = `尺寸 ${b.x1 - b.x0}×${b.z1 - b.z0} · ${count} 类设备 / 线路`;
      const p = details(layout), cover = coverFor(p.coverId);
      $('presentationZoomLabel').textContent = `${Math.round(p.viewport.zoom * 100)}%`;
      $('presentationCoverThumb').src = PAYLOAD.assets[cover.asset];
      $('presentationCoverName').textContent = cover.name;
      document.querySelectorAll('[data-cover-color]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.coverColor === p.coverColor)));
      $('presentationMessage').textContent = out.height > 1080 ? '设备或文字较多，预览已自动加高，完整保留全部内容。' : '修改会实时预览；应用后随蓝图 JSON 和本机草稿保存。';
      cv.dataset.revision = String(rev);
    } catch (e) { if (rev === revision) $('presentationError').textContent = e.message; }
  }
  function scheduleRender() { ++revision; clearTimeout(renderTimer); renderTimer = setTimeout(render, 100); }
  function renderCovers() {
    const terms = $('coverSearch').value.toLowerCase().trim().split(/\s+/).filter(Boolean), scope = $('coverScope').value;
    const matches = Object.entries(native.covers).filter(([id, row]) => (scope === 'all' || row.kind === scope) && terms.every(t => `${id} ${row.name}`.toLowerCase().includes(t)));
    const list = $('coverResults'); list.replaceChildren();
    for (const [id, row] of matches.slice(0, coverLimit)) {
      const button = document.createElement('button'); button.className = 'cover-choice'; button.dataset.cover = id;
      button.title = row.name + (id ? ' · ' + id : ''); button.setAttribute('aria-pressed', String(id === draft.presentation.coverId));
      const im = document.createElement('img'); im.src = PAYLOAD.assets[row.asset]; im.alt = ''; im.loading = 'lazy';
      const name = document.createElement('span'); name.textContent = row.name; button.append(im, name); list.append(button);
      button.onclick = () => { draft.presentation.coverId = id; $('coverPicker').hidden = true; scheduleRender(); };
    }
    if (!matches.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = '没有匹配的封面图标'; list.append(empty); }
    $('btnMoreCovers').hidden = matches.length <= coverLimit;
  }
  function open() {
    commitName(); draft = C.clone(data); draft.presentation = details(draft);
    $('presentationName').value = draft.name; $('presentationCreator').value = draft.presentation.creatorId;
    $('presentationTags').value = draft.presentation.tags.join('，'); $('presentationDescription').value = draft.presentation.description;
    $('presentationZoom').value = draft.presentation.viewport.zoom * 100;
    $('presentationPanX').value = draft.presentation.viewport.x * 100; $('presentationPanY').value = draft.presentation.viewport.y * 100;
    $('presentationChangeHints').checked = draft.presentation.showChangeHints;
    const connections = $('presentationConnectionPair'); connections.replaceChildren(new Option('不显示连接光带', ''));
    for (const n of draft.nodes) if (C.undergroundRole(n) === 'in') {
      const peer = C.undergroundPeer(draft.nodes, n); if (!peer) continue;
      connections.add(new Option(`入口 (${n.position.x}, ${n.position.z}) → 出口 (${peer.position.x}, ${peer.position.z})`, n.undergroundPair));
    }
    connections.disabled = connections.options.length === 1;
    if (draft.presentation.connectionPair && ![...connections.options].some(o => o.value === draft.presentation.connectionPair)) {
      const stale = new Option('原连接已移除', draft.presentation.connectionPair); stale.disabled = true; connections.add(stale);
    }
    connections.value = draft.presentation.connectionPair;
    $('coverPicker').hidden = true; $('coverSearch').value = ''; $('coverScope').value = 'all'; coverLimit = 60;
    $('presentationError').textContent = ''; dialog.showModal(); render();
  }
  function apply(close = true) {
    try {
      const next = readForm();
      transact(d => { d.name = next.name; d.presentation = C.clone(next.presentation); }, '蓝图详情已保存');
      saveNow(); if (close) dialog.close(); return true;
    } catch (error) { $('presentationError').textContent = error.message; return false; }
  }
  $('btnGamePreview').onclick = open;
  const settingsButton = document.createElement('button'); settingsButton.textContent = '蓝图详情 · 编辑 / 预览'; settingsButton.id = 'btnPresentationDetails'; settingsButton.onclick = open;
  $('summary').prepend(settingsButton);
  for (const id of ['presentationName', 'presentationCreator', 'presentationTags', 'presentationDescription']) $(id).oninput = scheduleRender;
  for (const id of ['presentationZoom', 'presentationPanX', 'presentationPanY']) $(id).oninput = scheduleRender;
  $('presentationChangeHints').onchange = scheduleRender;
  $('presentationConnectionPair').onchange = scheduleRender;
  $('btnResetViewport').onclick = () => { $('presentationZoom').value = 100; $('presentationPanX').value = $('presentationPanY').value = 50; scheduleRender(); };
  const cv = $('presentationCanvas'); let pan = null;
  const pointer = e => { const box = cv.getBoundingClientRect(), k = 2560 / box.width; return {x: (e.clientX - box.left) * k, y: (e.clientY - box.top) * k}; };
  cv.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !draft) return;
    const q = pointer(e); if (q.x > 1900 || q.y < 116) return;
    const layout = readForm(), m = metrics(layout), t = viewportTransform(layout, m);
    pan = {q, t, start: {...layout.presentation.viewport}, axis: q.y > m.height - 100 ? 'x' : q.x > 1876 ? 'y' : null};
    cv.setPointerCapture(e.pointerId); cv.style.cursor = 'grabbing'; e.preventDefault();
  });
  cv.addEventListener('pointermove', e => {
    if (!pan) return;
    const q = pointer(e), {t, start, axis} = pan;
    const clamp = v => Math.max(0, Math.min(100, v));
    if (t.overflowX && axis !== 'y') $('presentationPanX').value = clamp((axis === 'x' ? (q.x - 65) / 1770 : start.x - (q.x - pan.q.x) / t.overflowX) * 100);
    if (t.overflowY && axis !== 'x') $('presentationPanY').value = clamp((axis === 'y' ? (q.y - 149) / (metrics(draft).height - 250) : start.y - (q.y - pan.q.y) / t.overflowY) * 100);
    scheduleRender();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) cv.addEventListener(type, () => { pan = null; cv.style.cursor = ''; });
  cv.addEventListener('wheel', e => {
    if (!draft) return;
    const q = pointer(e); if (q.x > 1900 || q.y < 116) return;
    e.preventDefault(); const previous = viewportTransform(readForm());
    const gx = (q.x - previous.ox) / previous.s, gz = (q.y - previous.oy) / previous.s;
    $('presentationZoom').value = Math.max(100, Math.min(400, Number($('presentationZoom').value) * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    const next = viewportTransform(readForm());
    if (next.overflowX) $('presentationPanX').value = Math.max(0, Math.min(100, (next.area.x + (gx - next.b.x0) * next.s - q.x) / next.overflowX * 100));
    if (next.overflowY) $('presentationPanY').value = Math.max(0, Math.min(100, (next.area.y + (gz - next.b.z0) * next.s - q.y) / next.overflowY * 100));
    scheduleRender();
  }, {passive: false});
  $('btnChooseCover').onclick = () => { $('coverPicker').hidden = !$('coverPicker').hidden; if (!$('coverPicker').hidden) { renderCovers(); $('coverSearch').focus(); } };
  $('coverSearch').oninput = $('coverScope').onchange = () => { coverLimit = 60; renderCovers(); };
  $('btnMoreCovers').onclick = () => { coverLimit += 60; renderCovers(); };
  for (const [id, [name, color]] of Object.entries(colors)) {
    const button = document.createElement('button'); button.dataset.coverColor = id; button.title = name; button.setAttribute('aria-label', name);
    button.style.setProperty('--color', color); button.onclick = () => { draft.presentation.coverColor = id; scheduleRender(); }; $('presentationColors').append(button);
  }
  const preferredTags = ['装备', '武陵', '四号谷地'];
  const suggestions = [...new Set([...preferredTags.filter(t => native.tags.includes(t)), ...native.tags])].slice(0, 12);
  for (const name of suggestions) {
    const button = document.createElement('button'); button.textContent = name;
    button.onclick = () => { const tags = $('presentationTags').value.split(/[,，、\n]/).map(t => t.trim()).filter(Boolean);
      if (tags.includes(name)) tags.splice(tags.indexOf(name), 1); else tags.push(name);
      $('presentationTags').value = tags.join('，'); scheduleRender(); }; $('tagSuggestions').append(button);
  }
  $('btnApplyPresentation').onclick = () => apply();
  $('btnCancelPresentation').onclick = () => dialog.close();
  dialog.addEventListener('keydown', e => {
    if (e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); dialog.close(); }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') { e.preventDefault(); if (apply(false)) downloadJson(); }
  });
  dialog.addEventListener('close', () => { ++revision; clearTimeout(renderTimer); draft = null; pan = null; });
  $('btnExportPresentation').onclick = async () => {
    if (!apply(false)) return;
    const button = $('btnExportPresentation'); button.disabled = true; $('presentationError').textContent = '';
    try {
      const out = await exportPreview(data, Number($('presentationResolution').value));
      const blob = await new Promise(resolve => out.toBlob(resolve, 'image/png')); if (!blob) throw Error('PNG 编码失败');
      download(blob, filename('_蓝图预览.png')); $('presentationMessage').textContent = `完整预览已导出：${out.width}×${out.height}，详情也已保存。`;
    } catch (error) { $('presentationError').textContent = error.message; } finally { button.disabled = false; }
  };
  window.BlueprintPresentation = {open, exportPreview, inventory, metrics, viewportTransform, refresh: () => { if (dialog.open && draft) scheduleRender(); }};
  window.BlueprintEditor.exportPreview = exportPreview;
})();
