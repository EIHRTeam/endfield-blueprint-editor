/**
 * Editor DOM synchronisation.
 *
 * This is the transcription of the original's `changed()` fan-out: `refreshInspector`,
 * `refreshSummary`, `refreshHistory`, `buildList` and `message` all wrote into the DOM by id, and this
 * module does the same with the same values.
 *
 * React owns the shell's static markup; the values inside it are written here rather than threaded
 * through props. That keeps the original's imperative flow intact — one function that flushes every
 * derived value — instead of spreading it across dozens of controlled props, which is where a migration
 * like this normally starts inventing UI.
 */
import { buildingCells, undergroundPeer, undergroundRole } from '../core';
import type { BlueprintNode, Product } from '../core/types';
import type { Editor } from './editor';

/** `$` of the original. */
const el = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

function setText(id: string, value: string): void {
  const node = el(id);
  if (node) node.textContent = value;
}

function setValue(id: string, value: string): void {
  const node = el(id) as HTMLInputElement | HTMLSelectElement | null;
  if (node && node.value !== value) node.value = value;
}

function setHidden(id: string, hidden: boolean): void {
  const node = el(id) as (HTMLElement & { hidden: boolean }) | null;
  if (node) node.hidden = hidden;
}

function setDisabled(id: string, disabled: boolean): void {
  const node = el(id) as HTMLButtonElement | HTMLSelectElement | null;
  if (node) node.disabled = disabled;
}

const PORT_DIRECTION_LABELS = ['右', '下', '左', '上'];

/** `refreshHistory()` of the original. */
export function refreshHistory(editor: Editor): void {
  setDisabled('btnUndo', !editor.history.past.length);
  setDisabled('btnRedo', !editor.history.future.length);
}

/** `refreshSummary()` of the original, which builds `#summaryList` and writes `#nodeCount`. */
export function refreshSummary(editor: Editor): void {
  const list = el('summaryList');
  if (!list) return;
  setText('nodeCount', `${editor.data.nodes.length} / 160`);
  list.replaceChildren();

  const counts = new Map<string, { buildingId: string; indices: number[] }>();
  for (const [index, node] of editor.data.nodes.entries()) {
    const building = editor.buildings[node.templateId]!;
    const key = building.itemId || building.id;
    if (!counts.has(key)) counts.set(key, { buildingId: building.id, indices: [] });
    counts.get(key)!.indices.push(index);
  }

  const card = (itemId: string, palette: string, rarityColor: string, count: number, title: string) => {
    const row = document.createElement('button');
    row.className = 'summary-card';
    row.dataset.item = itemId;
    row.style.setProperty('--rarity', rarityColor || '#9b9b9b');
    row.title = title;
    row.setAttribute('aria-label', title);
    const image = document.createElement('img');
    image.src = editor.assets.urlsFor(palette);
    image.alt = '';
    const quantity = document.createElement('b');
    quantity.textContent = String(count);
    row.append(image, quantity);
    list.append(row);
    return row;
  };

  for (const [id, group] of counts) {
    const building = editor.buildings[group.buildingId]!;
    const row = card(
      id,
      building.palette,
      building.rarityColor,
      group.indices.length,
      `${building.name} × ${group.indices.length} · 点击定位`,
    );
    row.onclick = () => {
      const next = group.indices[(group.indices.indexOf(editor.selected) + 1) % group.indices.length]!;
      editor.selectTool('select');
      editor.selected = next;
      const f = editor.footprintOf(editor.data.nodes[next]!);
      const cx = editor.view.ox + (f.x0 + f.w / 2) * editor.view.s;
      const cy = editor.view.oy + (f.z0 + f.d / 2) * editor.view.s;
      const wrap = editor.wrap!;
      if (cx < 20 || cx > wrap.clientWidth - 20 || cy < 70 || cy > wrap.clientHeight - 20) {
        editor.view.ox = wrap.clientWidth / 2 - (f.x0 + f.w / 2) * editor.view.s;
        editor.view.oy = wrap.clientHeight / 2 - (f.z0 + f.d / 2) * editor.view.s;
      }
      refreshInspector(editor);
      editor.requestDraw();
      editor.message(
        `已定位 ${building.name} (${editor.data.nodes[next]!.position.x}, ${editor.data.nodes[next]!.position.z})`,
      );
    };
  }

  const occupied = buildingCells(editor.data, editor.buildings);
  for (const [kind, item] of Object.entries(editor.payload.lineItems)) {
    const count = editor.data.conveyors.filter(
      belt => belt.kind === kind && !occupied.has(`${belt.x},${belt.z}`),
    ).length;
    if (!count) continue;
    const row = card(item.id, item.palette, item.rarityColor, count, `${item.name} · ${count} 格 · 点击继续铺设`);
    row.onclick = () => editor.selectTool(kind as never);
  }
}

/**
 * `refreshInspector()` of the original.
 *
 * The `prepareScene(...).then(...)` preview paint is issued here too; it is guarded by a revision
 * counter inside `Editor.refreshPreview`, exactly as the original guarded it with `previewRevision`.
 */
export function refreshInspector(editor: Editor): void {
  const node: BlueprintNode | undefined = editor.data.nodes[editor.selected];
  setHidden('selectionFields', !node);
  setHidden('emptySelection', Boolean(node));

  if (!node) {
    editor.inspectorNode = null;
    editor.previewRevision += 1;
    return;
  }

  const building = editor.buildings[node.templateId]!;
  const extent = editor.dims(building, node.direction ?? 0);
  setText('selectedName', building.name);
  setText('selectedId', building.id);
  setText(
    'selectedSize',
    `占地 ${extent.w}×${extent.d}` + (building.logistic ? ' · 物流节点' : ` · ${building.ports.length} 个原始端口`),
  );
  setDisabled('nodePorts', Boolean(building.logistic) || !building.ports.some(port => port.pipe));

  setValue('nodeX', String(node.position.x));
  setValue('nodeZ', String(node.position.z));
  setValue('nodeDirection', String(node.direction ?? 0));
  setValue('nodePorts', node.formulaMode === 'normal' ? 'normal' : 'all');
  setValue('nodeEnvironment', node.environmentEffect || '');
  setValue('nodeItemStatus', node.itemStatus || 'normal');
  setDisabled('nodeItemStatus', !node.productIcon);
  setValue('nodeItemStatusColor', node.itemStatusColor || '#00ffff');
  setHidden('itemStatusColorField', node.itemStatus !== 'limited' || !node.productIcon);

  const portList = el('portVisibility');
  if (portList) {
    portList.replaceChildren();
    setHidden('portVisibilityFields', !building.editablePorts || !building.ports.length);
    for (const port of building.ports) {
      if (!building.editablePorts) break;
      const label = document.createElement('label');
      label.className = 'check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.port = port.id;
      input.checked = !node.closedPorts?.includes(port.id);
      input.disabled = node.formulaMode === 'normal' && port.pipe;
      label.append(
        input,
        `${PORT_DIRECTION_LABELS[(port.dir + (node.direction ?? 0)) % 4]} · ${port.pipe ? '管道' : '物品'}${
          port.input ? '入口' : '出口'
        } ${port.n + 1}`,
      );
      input.onchange = () =>
        editor.updateSelected(target => {
          const closed = new Set(target.closedPorts ?? []);
          if (input.checked) closed.delete(port.id);
          else closed.add(port.id);
          if (closed.size) target.closedPorts = [...closed];
          else delete target.closedPorts;
        });
      portList.append(label);
    }
  }

  editor.inspectorNode = `${editor.selected}:${node.templateId}`;
  setText(
    'productLabel',
    node.templateId.includes('conditioner')
      ? '准入物品图标'
      : node.templateId === 'unloader_1'
        ? '取货物品图标'
        : '展示物品',
  );
  setText('productHelp', '图标会随蓝图和 PNG 一起保存。');
  const currentProduct = editor.productInfo(node.productIcon);
  setText('selectedProductName', node.productIcon ? currentProduct?.name || node.productIcon : '设备符号');
  const currentImage = currentProduct?.badge || building.symbol || building.faces[0];
  const productImage = el<HTMLImageElement>('selectedProductImage');
  if (productImage) productImage.src = editor.assets.urlsFor(currentImage);
  setHidden('undergroundFields', !building.underground);

  const peers = el<HTMLSelectElement>('undergroundPeer');
  if (peers) {
    peers.replaceChildren(new Option('未连接', '-1'));
    if (building.underground) {
      for (const [index, candidate] of editor.data.nodes.entries()) {
        const role = undergroundRole(candidate);
        if (!role || role === undergroundRole(node)) continue;
        const repairable =
          candidate.undergroundPair && candidate.undergroundPair !== node.undergroundPair ? ' · 将重新配对' : '';
        peers.add(
          new Option(
            `${editor.buildings[candidate.templateId]!.name} (${candidate.position.x}, ${candidate.position.z})${repairable}`,
            String(index),
          ),
        );
      }
    }
    const peer = undergroundPeer(editor.data.nodes, node);
    peers.value = String(peer ? editor.data.nodes.indexOf(peer) : -1);
    setDisabled('btnConnection', !peer);
    setText('btnConnection', peer && editor.activePair === node.undergroundPair ? '收起连接' : '查看连接');
  }

  setText(
    'nodeWarning',
    node.productIcon && !currentProduct?.badge ? `未找到 ${node.productIcon} 的图片；导入值会原样保存。` : '',
  );
  setText('zoom', `${Math.round((editor.view.s / 40) * 100)}% · ${editor.data.size.x}×${editor.data.size.z}`);
}

/** `selectTool()`'s class toggle over `[data-tool]`. */
export function refreshToolButtons(editor: Editor): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
    button.classList.toggle('active', button.dataset.tool === editor.tool);
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('.building')) {
    button.classList.toggle('active', editor.tool === 'place' && button.dataset.id === editor.chosen);
  }
  setText('canvasHint', TOOL_HINTS(editor));
}

/** The `canvasHint` strings of the original, verbatim. */
function TOOL_HINTS(editor: Editor): string {
  const hints: Record<string, string> = {
    select: '点击选中 · 拖动移动 · R 旋转 · Delete 删除',
    place: '点击放置 · R 旋转 · Esc 返回选择',
    item: '沿拖动方向铺设传送带 · 端点吸附接口 · Shift 切换转弯顺序',
    fluid: '拖动铺设流体管 · 端点吸附流体口 · 可与传送带分层交叉',
    erase: '点击删除设备或当前格线路 · 可撤销',
    icon: `图标画笔：${editor.productInfo(editor.iconBrush)?.name || '设备符号'} · 点击设备标注 · Esc 退出`,
  };
  return hints[editor.tool] ?? '';
}

/** `buildList()` of the original. */
export function buildList(editor: Editor, term: string): void {
  const list = el('buildingList');
  if (!list) return;
  const needle = term.trim().toLowerCase();
  list.replaceChildren();
  let count = 0;

  for (const building of editor.payload.buildings) {
    if (needle && !`${building.name} ${building.id}`.toLowerCase().includes(needle)) continue;
    const button = document.createElement('button');
    button.className = 'building';
    button.dataset.id = building.id;
    button.classList.toggle('active', editor.tool === 'place' && editor.chosen === building.id);
    const image = document.createElement('img');
    image.src = editor.assets.urlsFor(building.palette);
    image.alt = '';
    image.loading = 'lazy';
    const text = document.createElement('span');
    const name = document.createElement('b');
    const size = document.createElement('small');
    name.textContent = building.name;
    size.textContent = `${building.w}×${building.d} · ${building.id}`;
    text.append(name, size);
    button.append(image, text);
    button.onclick = () => {
      editor.chosen = building.id;
      editor.selectTool('place');
      editor.message(`已选 ${building.name}，点击画布放置`);
    };
    list.append(button);
    count++;
  }
  setText('buildingCount', `${count} / ${editor.payload.buildings.length} 个设备条目`);
}

/** `refreshProductOptions()` of the original. */
export function refreshProductOptions(editor: Editor): void {
  const node = editor.data.nodes[editor.selected];
  const building = node ? editor.buildings[node.templateId] : undefined;
  const scope = el<HTMLSelectElement>('productScope')?.value ?? 'all';
  const availability = el<HTMLSelectElement>('productAvailability')?.value ?? 'available';
  const terms = (el<HTMLInputElement>('productSearch')?.value ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);

  const source =
    scope === 'recommended'
      ? (building?.products ?? []).map(id => (id.startsWith('[gas]') ? id.toLowerCase() : id))
      : Object.keys(editor.payload.products);

  const options = [...new Set(source)]
    .filter(id => {
      const product = editor.productInfo(id) as Product | undefined;
      if (!product || !terms.every(term => `${id} ${product.name}`.toLowerCase().includes(term))) return false;
      if ((availability === 'available' && !product.badge) || (availability === 'missing' && product.badge))
        return false;
      return !(
        (scope === 'solid' && product.phase !== 1) ||
        (scope === 'liquid' && product.phase !== 2) ||
        (scope === 'gas' && product.phase !== 4) ||
        (scope === 'environment' && !product.gas)
      );
    })
    .sort((a, b) => editor.productInfo(a)!.name.localeCompare(editor.productInfo(b)!.name, 'zh-CN'));

  const results = el('productResults');
  if (results) {
    results.replaceChildren();
    for (const id of options.slice(0, editor.productLimit)) {
      const product = editor.productInfo(id)!;
      const button = document.createElement('button');
      button.className = 'product-card';
      button.dataset.product = id;
      button.classList.toggle('active', productIconKey(node?.productIcon) === id);
      const reason = product.iconStatus === 'empty_icon_configuration' ? '游戏表未配置图标' : '当前安装资源中无此图标';
      button.title = `${product.name}\n${id}${
        product.badge
          ? product.iconStatus === 'same_id_original_sprite'
            ? '\n使用同名原图（表内未指定）'
            : ''
          : `\n${reason}`
      }`;
      if (product.badge) {
        const image = document.createElement('img');
        image.src = editor.assets.urlsFor(product.badge);
        image.alt = '';
        image.loading = 'eager';
        button.append(image);
      } else {
        const placeholder = document.createElement('span');
        placeholder.className = 'missing-thumb';
        placeholder.textContent = '?';
        button.append(placeholder);
        button.disabled = true;
        button.classList.add('missing');
      }
      const label = document.createElement('span');
      label.textContent = product.name;
      button.append(label);
      if (!product.badge) {
        const why = document.createElement('small');
        why.textContent = reason;
        button.append(why);
      }
      button.onclick = () => chooseProduct(editor, id);
      results.append(button);
    }
  }

  setText('productCount', `找到 ${options.length} 个 · 已显示 ${Math.min(editor.productLimit, options.length)}`);
  setHidden('productEmpty', options.length !== 0);
  setHidden('btnMoreProducts', options.length <= editor.productLimit);
}

function productIconKey(id: string | null | undefined): string | null {
  if (!id) return null;
  return id.startsWith('[gas]') ? id.toLowerCase() : id;
}

/**
 * `openProductLibrary()` of the original.
 *
 * The original reset the filter controls and `libraryTarget` here; the controls are part of the shell and
 * are reset through their element values so the DOM ends up in the same state.
 */
export function openProductLibrary(editor: Editor): void {
  setValue('productSearch', '');
  setValue('productScope', 'all');
  setValue('productAvailability', 'available');
  editor.productLimit = 80;
  const node = editor.data.nodes[editor.selected];
  setText(
    'libraryTarget',
    node
      ? `为「${editor.buildings[node.templateId]!.name}」选择展示物品`
      : '浏览全部图标，选图后点击画布上的设备标注。',
  );
  const recommended = el<HTMLSelectElement>('productScope')?.querySelector<HTMLOptionElement>('[value="recommended"]');
  if (recommended) recommended.disabled = !node;
  refreshProductOptions(editor);
  el<HTMLDialogElement>('itemLibrary')?.showModal();
  el<HTMLInputElement>('productSearch')?.focus();
}

/** `chooseProduct(id)` of the original. */
export function chooseProduct(editor: Editor, id: string): void {
  el<HTMLDialogElement>('itemLibrary')?.close();
  if (editor.selected >= 0) {
    editor.updateSelected(node => {
      node.productIcon = id || null;
    });
    return;
  }
  editor.iconBrush = id || null;
  editor.selectTool('icon');
  editor.message(`已选择 ${editor.productInfo(id)?.name || '设备符号'}，点击设备标注`);
}

/**
 * Everything the original's `changed()` flushed, in the same order.
 *
 * Called after every committed change and after the initial load, so the shell never has to thread
 * derived values through props.
 */
export function syncAll(editor: Editor, term: string): void {
  buildList(editor, term);
  refreshInspector(editor);
  refreshSummary(editor);
  refreshHistory(editor);
  refreshToolButtons(editor);
}
