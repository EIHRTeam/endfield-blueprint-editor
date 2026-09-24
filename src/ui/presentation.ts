/**
 * Presentation dialog wiring.
 *
 * The transcription home of the original's `editor_presentation.js` script-init section
 * (lines 255-313), which ran once at load: it created `#btnGamePreview`'s sibling button, filled
 * `#presentationColors` and `#tagSuggestions`, and registered every control in the dialog.
 *
 * The heavy painters stay where they already are — `src/render/paintScene.ts` for the canvas and
 * `src/ui/presentationPaint.ts` for the sheet — so this module only owns the controls.
 */
import { clone, validate } from '../core';
import type { Layout, PresentationDetails } from '../core/types';
import type { Editor } from './editor';
import {
  exportPreviewSheet,
  connectionOptions,
  metrics as presentationMetrics,
  viewportTransform as presentationTransform,
} from './presentationPaint';
import type { PreviewExportOptions } from './presentationPaint';

/** `colors` of the original, in insertion order (editor_presentation.js:5-6). */
export const COVER_COLORS: Array<{ id: string; name: string; color: string }> = [
  { id: 'blue', name: '蓝色', color: '#64d0fe' },
  { id: 'cyan', name: '青色', color: '#4fecce' },
  { id: 'yellow', name: '黄色', color: '#fbfd20' },
  { id: 'green', name: '绿色', color: '#d0f170' },
  { id: 'purple', name: '紫色', color: '#d3bafe' },
  { id: 'orange', name: '橙色', color: '#fea760' },
  { id: 'gray', name: '灰色', color: '#d9d9d9' },
];

const el = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

/** Clamps a percentage viewport value. */
const clamp = (value: number) => Math.max(0, Math.min(100, value));

/**
 * `base` of the original (editor_presentation.js:8): the presentation defaults.
 */
const BASE_DETAILS: PresentationDetails = {
  creatorId: '',
  tags: [],
  description: '',
  coverId: '',
  coverColor: 'blue',
  showChangeHints: false,
  connectionPair: '',
  viewport: { zoom: 1, x: 0.5, y: 0.5 },
};

/** `details(layout)` of the original: fill every optional field from the defaults. */
export function detailsOf(layout: Layout): PresentationDetails {
  const source = layout.presentation ?? {};
  return {
    creatorId: source.creatorId ?? BASE_DETAILS.creatorId,
    tags: source.tags ? [...source.tags] : [],
    description: source.description ?? '',
    coverId: source.coverId ?? '',
    coverColor: source.coverColor ?? BASE_DETAILS.coverColor,
    showChangeHints: source.showChangeHints ?? BASE_DETAILS.showChangeHints,
    connectionPair: source.connectionPair ?? '',
    viewport: {
      zoom: source.viewport?.zoom ?? 1,
      x: source.viewport?.x ?? 0.5,
      y: source.viewport?.y ?? 0.5,
    },
  };
}

/** Mutable dialog state, mirroring the original's module-level `let`s. */
export interface PresentationState {
  draft: Layout | null;
  revision: number;
  coverLimit: number;
  renderTimer: ReturnType<typeof setTimeout> | undefined;
  pan: {
    q: { x: number; y: number };
    start: { x: number; y: number };
    overflowX: number;
    overflowY: number;
    axis: 'x' | 'y' | null;
  } | null;
}

export function createPresentationState(): PresentationState {
  return { draft: null, revision: 0, coverLimit: 60, renderTimer: undefined, pan: null };
}

/**
 * The original's script-init block, in order.
 *
 * Called once after the shell is mounted, so the elements it binds exist.
 */
export function initPresentation(editor: Editor, state: PresentationState, base: string): () => void {
  const dialog = el<HTMLDialogElement>('presentationDialog');
  if (!dialog) return () => {};
  const listeners: Array<[EventTarget, string, EventListener, AddEventListenerOptions?]> = [];
  const on = (target: EventTarget, type: string, handler: EventListener, options?: AddEventListenerOptions) => {
    target.addEventListener(type, handler, options);
    listeners.push([target, type, handler, options]);
  };
  const bind = (id: string, type: string, handler: () => void) => {
    const node = el(id);
    if (node) on(node, type, handler as EventListener);
  };

  // The settings button is prepended into #summary by the original; it is created here for the same
  // reason it was created there — so the shell markup matches the template byte for byte.
  let settings = document.getElementById('btnPresentationDetails') as HTMLButtonElement | null;
  if (!settings) {
    settings = document.createElement('button');
    settings.textContent = '蓝图详情 · 编辑 / 预览';
    settings.id = 'btnPresentationDetails';
    document.getElementById('summary')?.prepend(settings);
  }
  const openDialog = () => {
    void open(editor, state, base);
  };
  settings.addEventListener('click', openDialog);
  listeners.push([settings, 'click', openDialog]);
  bind('btnGamePreview', 'click', openDialog);

  // `#presentationColors` (editor_presentation.js:295-298)
  const colors = el('presentationColors');
  if (colors && !colors.childElementCount) {
    for (const entry of COVER_COLORS) {
      const button = document.createElement('button');
      button.dataset.coverColor = entry.id;
      button.title = entry.name;
      button.setAttribute('aria-label', entry.name);
      button.style.setProperty('--color', entry.color);
      button.addEventListener('click', () => {
        if (!state.draft) return;
        state.draft.presentation = { ...detailsOf(state.draft), coverColor: entry.id as never };
        scheduleRender(editor, state, base);
      });
      colors.append(button);
    }
  }

  // `#tagSuggestions` (editor_presentation.js:299-306)
  const tagHost = el('tagSuggestions');
  if (tagHost && !tagHost.childElementCount) {
    const preferred = ['装备', '武陵', '四号谷地'];
    const native = editor.payload.presentation.tags;
    const suggestions = [...new Set([...preferred.filter(tag => native.includes(tag)), ...native])].slice(0, 12);
    for (const name of suggestions) {
      const button = document.createElement('button');
      button.textContent = name;
      button.addEventListener('click', () => {
        const input = el<HTMLInputElement>('presentationTags');
        if (!input) return;
        const tags = input.value
          .split(/[,，、\n]/)
          .map(tag => tag.trim())
          .filter(Boolean);
        if (tags.includes(name)) tags.splice(tags.indexOf(name), 1);
        else tags.push(name);
        input.value = tags.join('，');
        scheduleRender(editor, state, base);
      });
      tagHost.append(button);
    }
  }

  // Text and range inputs re-render the preview on input (editor_presentation.js:258-261)
  for (const id of [
    'presentationName',
    'presentationCreator',
    'presentationTags',
    'presentationDescription',
    'presentationZoom',
    'presentationPanX',
    'presentationPanY',
    'presentationChangeHints',
    'presentationConnectionPair',
    'presentationSizing',
    'presentationCell',
    'presentationMargin',
  ]) {
    bind(id, 'change', () => scheduleRender(editor, state, base));
    bind(id, 'input', () => scheduleRender(editor, state, base));
  }

  bind('btnResetViewport', 'click', () => {
    setValue('presentationZoom', '100');
    setValue('presentationPanX', '50');
    setValue('presentationPanY', '50');
    scheduleRender(editor, state, base);
  });

  // Cover picker (editor_presentation.js:292-294)
  bind('btnChooseCover', 'click', () => {
    const picker = el('coverPicker');
    if (!picker) return;
    picker.hidden = !picker.hidden;
    if (!picker.hidden) {
      renderCovers(editor, state, base);
      el<HTMLInputElement>('coverSearch')?.focus();
    }
  });
  bind('coverSearch', 'input', () => {
    state.coverLimit = 60;
    renderCovers(editor, state, base);
  });
  bind('coverScope', 'change', () => {
    state.coverLimit = 60;
    renderCovers(editor, state, base);
  });
  bind('btnMoreCovers', 'click', () => {
    state.coverLimit += 60;
    renderCovers(editor, state, base);
  });

  bind('btnApplyPresentation', 'click', () => {
    if (apply(editor, state)) dialog.close();
  });
  bind('btnCancelPresentation', 'click', () => dialog.close());
  on(dialog, 'keydown', ((event: KeyboardEvent) => {
    if (event.code === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dialog.close();
    }
    if ((event.ctrlKey || event.metaKey) && event.code === 'KeyS') {
      event.preventDefault();
      if (apply(editor, state)) el('btnJson')?.click();
    }
  }) as EventListener);
  on(dialog, 'close', () => {
    state.revision += 1;
    clearTimeout(state.renderTimer);
    state.draft = null;
    state.pan = null;
  });

  bind('btnExportPresentation', 'click', () => void exportSheet(editor, state, base));

  // Canvas pan and wheel (editor_presentation.js:263-291)
  const canvas = el<HTMLCanvasElement>('presentationCanvas');
  if (canvas) {
    on(canvas, 'pointerdown', ((event: PointerEvent) => {
      if (event.button !== 0 || !state.draft || exportOptions().fitToContent) return;
      const box = canvas.getBoundingClientRect();
      const scale = 2560 / box.width;
      const q = { x: (event.clientX - box.left) * scale, y: (event.clientY - box.top) * scale };
      if (q.x > 1900 || q.y < 116) return;
      const layout = readForm(editor, state);
      const m = presentationMetrics(editor, layout);
      const t = presentationTransform(editor, layout, m);
      state.pan = {
        q,
        start: { x: layout.presentation!.viewport!.x!, y: layout.presentation!.viewport!.y! },
        overflowX: t.overflowX,
        overflowY: t.overflowY,
        axis: q.y > m.height - 100 ? 'x' : q.x > 1876 ? 'y' : null,
      };
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = 'grabbing';
      event.preventDefault();
    }) as EventListener);
    on(canvas, 'pointermove', ((event: PointerEvent) => {
      const pan = state.pan;
      if (!pan) return;
      const box = canvas.getBoundingClientRect();
      const scale = 2560 / box.width;
      const q = { x: (event.clientX - box.left) * scale, y: (event.clientY - box.top) * scale };
      if (pan.overflowX && pan.axis !== 'y') {
        setValue(
          'presentationPanX',
          String(clamp((pan.axis === 'x' ? (q.x - 65) / 1770 : pan.start.x - (q.x - pan.q.x) / pan.overflowX) * 100)),
        );
      }
      if (pan.overflowY && pan.axis !== 'x') {
        const height = presentationMetrics(editor, readForm(editor, state)).height;
        setValue(
          'presentationPanY',
          String(
            clamp(
              (pan.axis === 'y' ? (q.y - 149) / (height - 250) : pan.start.y - (q.y - pan.q.y) / pan.overflowY) * 100,
            ),
          ),
        );
      }
      scheduleRender(editor, state, base);
    }) as EventListener);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      on(canvas, type, () => {
        state.pan = null;
        canvas.style.cursor = '';
      });
    }
    on(
      canvas,
      'wheel',
      ((event: WheelEvent) => {
        if (!state.draft || exportOptions().fitToContent) return;
        const box = canvas.getBoundingClientRect();
        const scale = 2560 / box.width;
        const q = { x: (event.clientX - box.left) * scale, y: (event.clientY - box.top) * scale };
        if (q.x > 1900 || q.y < 116) return;
        event.preventDefault();
        const zoom = Number(el<HTMLInputElement>('presentationZoom')!.value);
        setValue('presentationZoom', String(Math.max(100, Math.min(400, zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1)))));
        scheduleRender(editor, state, base);
      }) as EventListener,
      { passive: false },
    );
  }

  return () => {
    for (const [target, type, handler, options] of listeners) target.removeEventListener(type, handler, options);
  };
}

function setValue(id: string, value: string): void {
  const node = el(id) as HTMLInputElement | null;
  if (node && node.value !== value) node.value = value;
}

/** `readForm()` of the original (editor_presentation.js:184-194). */
export function readForm(editor: Editor, state: PresentationState): Layout {
  const draft = clone(state.draft!);
  draft.name = el<HTMLInputElement>('presentationName')!.value.trim() || '未命名蓝图';
  const details = detailsOf(draft);
  details.creatorId = el<HTMLInputElement>('presentationCreator')!.value.trim();
  details.description = el<HTMLInputElement>('presentationDescription')!.value.trim();
  details.tags = [
    ...new Set(
      el<HTMLInputElement>('presentationTags')!
        .value.split(/[,，、\n]/)
        .map(tag => tag.trim())
        .filter(Boolean),
    ),
  ];
  details.viewport = {
    zoom: Number(el<HTMLInputElement>('presentationZoom')!.value) / 100,
    x: Number(el<HTMLInputElement>('presentationPanX')!.value) / 100,
    y: Number(el<HTMLInputElement>('presentationPanY')!.value) / 100,
  };
  details.showChangeHints = el<HTMLInputElement>('presentationChangeHints')!.checked;
  details.connectionPair = el<HTMLSelectElement>('presentationConnectionPair')!.value;
  draft.presentation = details;
  return validate(draft, editor.buildings);
}

/** `open()` of the original (editor_presentation.js:228-247). */
export async function open(editor: Editor, state: PresentationState, base: string): Promise<void> {
  const dialog = el<HTMLDialogElement>('presentationDialog');
  const draft = clone(editor.data);
  // `detailsOf` fills every optional presentation field, so the local view is fully populated.
  const details: PresentationDetails = detailsOf(draft);
  draft.presentation = details;
  state.draft = draft;

  setValue('presentationName', draft.name);
  setValue('presentationCreator', details.creatorId);
  setValue('presentationTags', details.tags.join('，'));
  setValue('presentationDescription', details.description);
  setValue('presentationZoom', String(details.viewport.zoom * 100));
  setValue('presentationPanX', String(details.viewport.x * 100));
  setValue('presentationPanY', String(details.viewport.y * 100));
  const hints = el<HTMLInputElement>('presentationChangeHints');
  if (hints) hints.checked = details.showChangeHints;

  const connections = el<HTMLSelectElement>('presentationConnectionPair');
  if (connections) {
    connections.replaceChildren(new Option('不显示连接光带', ''));
    for (const option of connectionOptions(editor, draft)) connections.add(new Option(option.text, option.value));
    connections.disabled = connections.options.length === 1;
    if (details.connectionPair && ![...connections.options].some(option => option.value === details.connectionPair)) {
      const stale = new Option('原连接已移除', details.connectionPair);
      stale.disabled = true;
      connections.add(stale);
    }
    connections.value = details.connectionPair;
  }

  const picker = el('coverPicker');
  if (picker) picker.hidden = true;
  setValue('coverSearch', '');
  setValue('coverScope', 'all');
  state.coverLimit = 60;
  const error = el('presentationError');
  if (error) error.textContent = '';
  dialog?.showModal();
  await render(editor, state, base);
}

/** Export settings stay local to the dialog instead of changing the saved blueprint. */
function exportOptions(): PreviewExportOptions {
  return {
    fitToContent: el<HTMLSelectElement>('presentationSizing')?.value === 'content',
    cell: Number(el<HTMLInputElement>('presentationCell')?.value ?? 64),
    margin: Number(el<HTMLInputElement>('presentationMargin')?.value ?? 1),
  };
}

function refreshExportControls(content: boolean): void {
  for (const id of [
    'presentationResolution',
    'presentationZoom',
    'presentationPanX',
    'presentationPanY',
    'btnResetViewport',
  ]) {
    const control = el<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(id);
    if (control) control.disabled = content;
  }
  for (const id of ['presentationCell', 'presentationMargin']) {
    const control = el<HTMLInputElement>(id);
    if (control) control.disabled = !content;
  }
}

/** `render()` of the original (editor_presentation.js:195-212). */
export async function render(editor: Editor, state: PresentationState, base: string): Promise<void> {
  const dialog = el<HTMLDialogElement>('presentationDialog');
  const revision = ++state.revision;
  try {
    const layout = readForm(editor, state);
    const error = el('presentationError');
    if (error) error.textContent = '';
    const options = exportOptions();
    refreshExportControls(Boolean(options.fitToContent));
    const out = await exportPreviewSheet(editor, layout, 1920, base, options);
    if (revision !== state.revision || !dialog?.open) return;
    const canvas = el<HTMLCanvasElement>('presentationCanvas');
    if (canvas) {
      canvas.width = out.width;
      canvas.height = out.height;
      canvas.getContext('2d')!.drawImage(out, 0, 0);
    }
    const b = editor.boundsOf(layout, 0);
    const details = detailsOf(layout);
    const cover = coverFor(editor, details.coverId);
    const auto = el('presentationAuto');
    if (auto) {
      auto.textContent = `尺寸 ${b.x1 - b.x0}×${b.z1 - b.z0} · ${inventoryCount(editor, layout)} 类设备 / 线路`;
    }
    const zoomLabel = el('presentationZoomLabel');
    if (zoomLabel) zoomLabel.textContent = `${Math.round(details.viewport.zoom * 100)}%`;
    const thumb = el<HTMLImageElement>('presentationCoverThumb');
    if (thumb) thumb.src = editor.assets.urlsFor(cover.asset);
    const coverName = el('presentationCoverName');
    if (coverName) coverName.textContent = cover.name;
    for (const button of document.querySelectorAll<HTMLElement>('[data-cover-color]')) {
      button.setAttribute('aria-pressed', String(button.dataset.coverColor === details.coverColor));
    }
    const message = el('presentationMessage');
    if (message) {
      message.textContent = options.fitToContent
        ? `按内容导出：${out.width}×${out.height} px，每格 ${options.cell} px。应用后保存蓝图详情。`
        : out.height > 1080
          ? '设备或文字较多，预览已自动加高，完整保留全部内容。'
          : '修改会实时预览；应用后随蓝图 JSON 和本机草稿保存。';
    }
    if (canvas) canvas.dataset.revision = String(revision);
  } catch (thrown) {
    if (revision === state.revision) {
      const error = el('presentationError');
      if (error) error.textContent = (thrown as Error).message;
    }
  }
}

/** `scheduleRender()` of the original (editor_presentation.js:213). */
export function scheduleRender(editor: Editor, state: PresentationState, base: string): void {
  state.revision += 1;
  clearTimeout(state.renderTimer);
  state.renderTimer = setTimeout(() => void render(editor, state, base), 100);
}

/** `renderCovers()` of the original (editor_presentation.js:214-227). */
export function renderCovers(editor: Editor, state: PresentationState, base: string): void {
  const list = el('coverResults');
  if (!list || !state.draft) return;
  const terms = (el<HTMLInputElement>('coverSearch')?.value ?? '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  const scope = el<HTMLSelectElement>('coverScope')?.value ?? 'all';
  const current = detailsOf(state.draft).coverId;
  const matches = Object.entries(editor.payload.presentation.covers).filter(
    ([id, row]) =>
      (scope === 'all' || row.kind === scope) && terms.every(term => `${id} ${row.name}`.toLowerCase().includes(term)),
  );

  list.replaceChildren();
  for (const [id, row] of matches.slice(0, state.coverLimit)) {
    const button = document.createElement('button');
    button.className = 'cover-choice';
    button.dataset.cover = id;
    button.title = row.name + (id ? ` · ${id}` : '');
    button.setAttribute('aria-pressed', String(id === current));
    const image = document.createElement('img');
    image.src = editor.assets.urlsFor(row.asset);
    image.alt = '';
    image.loading = 'lazy';
    const name = document.createElement('span');
    name.textContent = row.name;
    button.append(image, name);
    button.onclick = () => {
      state.draft!.presentation = { ...detailsOf(state.draft!), coverId: id };
      const picker = el('coverPicker');
      if (picker) picker.hidden = true;
      scheduleRender(editor, state, base);
    };
    list.append(button);
  }
  if (!matches.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = '没有匹配的封面图标';
    list.append(empty);
  }
  const more = el('btnMoreCovers');
  if (more) more.hidden = matches.length <= state.coverLimit;
}

/** `apply(close)` of the original (editor_presentation.js:248-254). */
export function apply(editor: Editor, state: PresentationState): boolean {
  try {
    const next = readForm(editor, state);
    editor.transact(draft => {
      draft.name = next.name;
      draft.presentation = clone(next.presentation);
    }, '蓝图详情已保存');
    editor.saveNow();
    return true;
  } catch (error) {
    const target = el('presentationError');
    if (target) target.textContent = (error as Error).message;
    return false;
  }
}

/** `#btnExportPresentation` handler (editor_presentation.js:314-322). */
async function exportSheet(editor: Editor, state: PresentationState, base: string): Promise<void> {
  const button = el<HTMLButtonElement>('btnExportPresentation');
  if (button) button.disabled = true;
  try {
    const layout = readForm(editor, state);
    const resolution = Number(el<HTMLSelectElement>('presentationResolution')!.value);
    const out = await exportPreviewSheet(editor, layout, resolution, base, exportOptions());
    const blob = await new Promise<Blob | null>(resolve => out.toBlob(resolve, 'image/png'));
    if (!blob) throw Error('PNG 编码失败');
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${(layout.name || 'blueprint').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}_蓝图预览.png`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const message = el('presentationMessage');
    if (message) message.textContent = `完整预览已导出：${out.width}×${out.height} px。点击“应用并返回画布”保存详情。`;
  } catch (error) {
    const target = el('presentationError');
    if (target) target.textContent = (error as Error).message;
  } finally {
    if (button) button.disabled = false;
  }
}

/** `coverFor(id)` of the original (editor_presentation.js:10). */
export function coverFor(editor: Editor, id: string): { asset: string; name: string; kind?: string } {
  const covers = editor.payload.presentation.covers;
  return Object.hasOwn(covers, id) ? covers[id]! : covers['']!;
}

function inventoryCount(editor: Editor, layout: Layout): number {
  return new Set(
    layout.nodes.map(node => {
      const building = editor.buildings[node.templateId]!;
      return building.itemId || building.id;
    }),
  ).size;
}
