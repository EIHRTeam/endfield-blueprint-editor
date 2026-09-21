/**
 * Event wiring.
 *
 * A transcription of the listener registrations at the bottom of the original's `editor_app.js`: the
 * same targets, the same event names, the same handler bodies. Handlers are registered through
 * `addEventListener` on the real elements instead of as JSX props because several need pointer capture,
 * `{ passive: false }`, or the element reference itself — and because keeping them here makes the port
 * directly comparable with the original.
 *
 * Returns a teardown that removes every listener, so a remount cannot double-bind.
 */
import { mergeRoutes, pairUnderground } from '../core';
import type { Direction, Layout } from '../core/types';
import { paintScene } from '../render/paintScene';
import type { Editor, Tool } from './editor';
import { chooseProduct, openProductLibrary, refreshInspector, refreshProductOptions, refreshToolButtons } from './dom';

type Listener = [EventTarget, string, EventListener, AddEventListenerOptions?];

/** `$` of the original. */
const el = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

export interface WiringHooks {
  /** Re-renders the shell after a change React has to see (search term, filter values). */
  rerender: () => void;
  /** `#search` input. */
  setSearch: (value: string) => void;
  /** `#productSearch`, `#coverSearch` inputs. */
  setLibrarySearch: (value: string) => void;
  setCoverSearch: (value: string) => void;
  setCoverScope: (value: string) => void;
  /** `#productScope`, `#productAvailability`. */
  setFilters: (next: { scope: string; availability: string }) => void;
}

export function wireEditor(editor: Editor, base: string, hooks: WiringHooks): () => void {
  const canvas = el<HTMLCanvasElement>('cv');
  if (!canvas) return () => {};
  const listeners: Listener[] = [];

  const on = (target: EventTarget, type: string, handler: EventListener, options?: AddEventListenerOptions) => {
    target.addEventListener(type, handler, options);
    listeners.push([target, type, handler, options]);
  };
  const bind = (id: string, type: string, handler: () => void) => {
    const node = el(id);
    if (node) on(node, type, handler as EventListener);
  };

  // ---- canvas gestures (editor_app.js:501-566) ----------------------------------------
  on(canvas, 'contextmenu', event => event.preventDefault());

  on(canvas, 'pointerdown', ((event: PointerEvent) => {
    if (event.button > 2) return;
    const point = editor.pointer(event);
    canvas.focus();
    if (event.button === 2) {
      if (editor.inside(point)) editor.eraseAt(point);
      return;
    }
    canvas.setPointerCapture(event.pointerId);
    if (event.button === 1 || editor.space) {
      event.preventDefault();
      editor.gesture = { type: 'pan', x: event.clientX, y: event.clientY, ox: editor.view.ox, oy: editor.view.oy };
      return;
    }
    if (!editor.inside(point)) return;
    const index = editor.indexAt(point.x, point.z);
    if (editor.tool === 'icon') {
      if (index >= 0) {
        editor.selected = index;
        editor.updateSelected(node => {
          node.productIcon = editor.iconBrush;
        });
      } else {
        editor.message('点击设备可标注物品，Esc 退出图标画笔');
      }
      return;
    }
    if (editor.tool === 'erase') {
      editor.eraseAt(point);
      return;
    }
    if (editor.tool === 'item' || editor.tool === 'fluid') {
      editor.gesture = {
        type: 'route',
        start: point,
        kind: editor.tool,
        path: [],
        startPort: null,
        endPort: null,
        error: '',
      };
      editor.updateRoute(point, event.shiftKey);
      editor.requestDraw();
      return;
    }
    if (index >= 0) {
      editor.selectTool('select');
      editor.selected = index;
      if (innerWidth <= 860) document.body.classList.add('inspect-open');
      const node = editor.data.nodes[index]!;
      editor.gesture = {
        type: 'move',
        index,
        start: point,
        original: structuredClone(node),
        preview: structuredClone(node),
        moved: false,
      };
      refreshInspector(editor);
      editor.requestDraw();
      return;
    }
    if (editor.tool === 'place' && editor.chosen) {
      const node = {
        templateId: editor.chosen,
        position: { x: point.x, z: point.z },
        direction: editor.rotation,
        productIcon: null,
      };
      editor.transact(draft => {
        draft.nodes.push(node);
      }, `已放置 ${editor.buildings[editor.chosen]!.name}`);
      return;
    }
    editor.selected = -1;
    refreshInspector(editor);
    editor.requestDraw();
  }) as EventListener);

  on(canvas, 'pointermove', ((event: PointerEvent) => {
    const point = editor.pointer(event);
    editor.hover = editor.inside(point) ? point : null;
    const gesture = editor.gesture;
    if (gesture?.type === 'pan') {
      editor.view.ox = gesture.ox + event.clientX - gesture.x;
      editor.view.oy = gesture.oy + event.clientY - gesture.y;
    } else if (gesture?.type === 'move') {
      gesture.preview.position = {
        x: gesture.original.position.x + point.x - gesture.start.x,
        z: gesture.original.position.z + point.z - gesture.start.z,
      };
      gesture.moved = gesture.moved || point.x !== gesture.start.x || point.z !== gesture.start.z;
    } else if (gesture?.type === 'route') {
      editor.updateRoute(
        {
          ...point,
          x: Math.max(0, Math.min(editor.data.size.x - 1, point.x)),
          z: Math.max(0, Math.min(editor.data.size.z - 1, point.z)),
        },
        event.shiftKey,
      );
    }
    editor.requestDraw();
  }) as EventListener);

  on(canvas, 'pointerup', ((event: PointerEvent) => {
    const current = editor.gesture;
    editor.gesture = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (current?.type === 'move' && current.moved) {
      editor.transact(draft => {
        draft.nodes[current.index] = current.preview;
      }, '设备位置已更新');
    }
    if (current?.type === 'move' && !current.moved && editor.showHints) {
      hintClick(editor, event, current.index);
    }
    if (current?.type === 'route') {
      if (current.error) editor.message(current.error, true);
      else {
        editor.transact(
          draft => {
            draft.conveyors = mergeRoutes(draft.conveyors, current.path);
          },
          `已铺设 ${current.path.length} 格线路${current.startPort || current.endPort ? ' · 已吸附接口' : ''}`,
        );
      }
    }
    editor.requestDraw();
  }) as EventListener);

  on(canvas, 'pointercancel', () => {
    editor.gesture = null;
    editor.requestDraw();
  });
  on(canvas, 'pointerleave', () => {
    if (!editor.gesture) {
      editor.hover = null;
      editor.requestDraw();
    }
  });
  on(
    canvas,
    'wheel',
    ((event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const next = Math.min(128, Math.max(6, editor.view.s * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
      const k = next / editor.view.s;
      editor.view.ox = x - (x - editor.view.ox) * k;
      editor.view.oy = y - (y - editor.view.oy) * k;
      editor.view.s = next;
      editor.requestDraw();
    }) as EventListener,
    { passive: false },
  );
  on(canvas, 'dblclick', () => {
    const node = editor.data.nodes[editor.selected];
    if (!node) return;
    if (editor.buildings[node.templateId]!.underground) editor.toggleConnection();
    else openProductLibrary(editor);
  });

  // ---- window and document (editor_app.js:567-590) ------------------------------------
  on(window, 'keydown', ((event: KeyboardEvent) => {
    if (el<HTMLDialogElement>('presentationDialog')?.open || el<HTMLDialogElement>('fontLicenseDialog')?.open) return;
    if ((event.ctrlKey || event.metaKey) && event.code === 'KeyS') {
      event.preventDefault();
      downloadJson(editor);
      return;
    }
    if (el<HTMLDialogElement>('itemLibrary')?.open) {
      if (event.code === 'Escape') {
        event.preventDefault();
        el<HTMLDialogElement>('itemLibrary')?.close();
      }
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest('input,select,textarea,[contenteditable="true"]')) return;
    if (event.ctrlKey || event.metaKey) {
      if (event.code === 'KeyZ') {
        event.preventDefault();
        if (event.shiftKey) editor.redo();
        else editor.undo();
      }
      if (event.code === 'KeyY') {
        event.preventDefault();
        editor.redo();
      }
      if (event.code === 'KeyS') {
        event.preventDefault();
        downloadJson(editor);
      }
      return;
    }
    if (event.code === 'Space') {
      event.preventDefault();
      editor.space = true;
    }
    if (event.repeat) return;
    if (event.code === 'Escape') {
      editor.gesture = null;
      editor.selected = -1;
      editor.selectTool('select');
    } else if (event.code === 'KeyR') editor.rotate();
    else if (event.code === 'KeyF') editor.fit();
    else if (event.code === 'Delete' || event.code === 'Backspace') {
      event.preventDefault();
      editor.deleteSelected();
    } else if (['KeyV', 'KeyP', 'KeyB', 'KeyL', 'KeyE'].includes(event.code)) {
      const tools: Record<string, Tool> = { KeyV: 'select', KeyP: 'place', KeyB: 'item', KeyL: 'fluid', KeyE: 'erase' };
      editor.selectTool(tools[event.code]!);
    }
  }) as EventListener);
  on(window, 'keyup', ((event: KeyboardEvent) => {
    if (event.code === 'Space') editor.space = false;
  }) as EventListener);
  on(window, 'blur', () => {
    editor.space = false;
    editor.gesture = null;
    editor.hover = null;
    commitName(editor);
    editor.saveNow();
    editor.requestDraw();
  });
  on(window, 'resize', () => editor.resize());
  on(window, 'pagehide', () => {
    commitName(editor);
    editor.saveNow();
  });
  on(document, 'visibilitychange', () => {
    if (document.hidden) {
      commitName(editor);
      editor.saveNow();
    }
  });

  // ---- inspector controls (editor_app.js:592-626) -------------------------------------
  bind('nodeX', 'change', () =>
    editor.updateSelected(node => {
      node.position.x = Number(el<HTMLInputElement>('nodeX')!.value);
    }),
  );
  bind('nodeZ', 'change', () =>
    editor.updateSelected(node => {
      node.position.z = Number(el<HTMLInputElement>('nodeZ')!.value);
    }),
  );
  bind('nodeDirection', 'change', () =>
    editor.updateSelected(node => {
      node.direction = Number(el<HTMLSelectElement>('nodeDirection')!.value) as Direction;
    }),
  );
  bind('nodePorts', 'change', () =>
    editor.updateSelected(node => {
      if (el<HTMLSelectElement>('nodePorts')!.value === 'normal') node.formulaMode = 'normal';
      else delete node.formulaMode;
    }),
  );
  bind('nodeEnvironment', 'change', () =>
    editor.updateSelected(node => {
      const value = el<HTMLSelectElement>('nodeEnvironment')!.value;
      if (value) node.environmentEffect = value as never;
      else delete node.environmentEffect;
    }),
  );
  bind('nodeItemStatus', 'change', () =>
    editor.updateSelected(node => {
      const value = el<HTMLSelectElement>('nodeItemStatus')!.value;
      if (value === 'normal') delete node.itemStatus;
      else node.itemStatus = value as never;
    }),
  );
  bind('nodeItemStatusColor', 'change', () =>
    editor.updateSelected(node => {
      node.itemStatusColor = el<HTMLInputElement>('nodeItemStatusColor')!.value;
    }),
  );
  bind('btnResetPorts', 'click', () =>
    editor.updateSelected(node => {
      delete node.closedPorts;
      delete node.formulaMode;
    }),
  );
  bind('undergroundPeer', 'change', () => {
    editor.activePair = null;
    const peer = Number(el<HTMLSelectElement>('undergroundPeer')!.value);
    editor.transact(draft => pairUnderground(draft.nodes, editor.selected, peer), '暗管配对已更新');
  });
  bind('btnConnection', 'click', () => editor.toggleConnection());
  bind('btnCloseInspector', 'click', () => document.body.classList.remove('inspect-open'));
  bind('btnInspector', 'click', () => document.body.classList.toggle('inspect-open'));
  bind('btnDeleteNode', 'click', () => editor.deleteSelected());
  bind('btnFit', 'click', () => editor.fit());

  // ---- toolbar (editor_app.js:648-680) ------------------------------------------------
  bind('bpName', 'change', () =>
    editor.transact(draft => {
      draft.name = el<HTMLInputElement>('bpName')!.value.trim() || '未命名蓝图';
    }, '名称已更新'),
  );
  bind('btnUndo', 'click', () => editor.undo());
  bind('btnRedo', 'click', () => editor.redo());
  bind('btnGrid', 'click', () => {
    editor.showGrid = !editor.showGrid;
    el('btnGrid')!.textContent = `网格：${editor.showGrid ? '开' : '关'}`;
    editor.requestDraw();
  });
  bind('btnPorts', 'click', () => {
    editor.showPorts = !editor.showPorts;
    el('btnPorts')!.textContent = `端口标记：${editor.showPorts ? '开' : '关'}`;
    editor.requestDraw();
  });
  bind('btnHints', 'click', () => {
    editor.showHints = !editor.showHints;
    el('btnHints')!.textContent = `原版提示：${editor.showHints ? '开' : '关'}`;
    refreshInspector(editor);
    editor.requestDraw();
  });
  bind('btnClear', 'click', () => {
    editor.selected = -1;
    editor.transact(draft => {
      draft.nodes = [];
      draft.conveyors = [];
    }, '布局已清空，可撤销');
  });
  bind('btnDemo', 'click', () => editor.importLayout(editor.payload.demo));
  bind('btnImport', 'click', () => el<HTMLInputElement>('fileIn')?.click());
  bind('fileIn', 'change', () => void importFile(editor));
  bind('btnJson', 'click', () => downloadJson(editor));
  bind('btnPng', 'click', () => void exportPng(editor, base));
  bind('btnFontLicense', 'click', () => el<HTMLDialogElement>('fontLicenseDialog')?.showModal());
  bind('btnCloseFontLicense', 'click', () => el<HTMLDialogElement>('fontLicenseDialog')?.close());
  bind('btnItemLibrary', 'click', () => openProductLibrary(editor));
  bind('btnChooseProduct', 'click', () => openProductLibrary(editor));
  bind('btnCloseLibrary', 'click', () => el<HTMLDialogElement>('itemLibrary')?.close());
  bind('btnClearProduct', 'click', () => chooseProduct(editor, ''));

  bind('search', 'input', () => hooks.setSearch(el<HTMLInputElement>('search')!.value));
  bind('productSearch', 'input', () => {
    editor.productLimit = 80;
    hooks.setLibrarySearch(el<HTMLInputElement>('productSearch')!.value);
    refreshProductOptions(editor);
  });
  bind('productScope', 'change', () => {
    editor.productLimit = 80;
    hooks.setFilters({
      scope: el<HTMLSelectElement>('productScope')!.value,
      availability: el<HTMLSelectElement>('productAvailability')!.value,
    });
    refreshProductOptions(editor);
  });
  bind('productAvailability', 'change', () => {
    editor.productLimit = 80;
    hooks.setFilters({
      scope: el<HTMLSelectElement>('productScope')!.value,
      availability: el<HTMLSelectElement>('productAvailability')!.value,
    });
    refreshProductOptions(editor);
  });
  bind('btnMoreProducts', 'click', () => {
    editor.productLimit += 80;
    refreshProductOptions(editor);
  });
  bind('coverSearch', 'input', () => hooks.setCoverSearch(el<HTMLInputElement>('coverSearch')!.value));
  bind('coverScope', 'change', () => hooks.setCoverScope(el<HTMLSelectElement>('coverScope')!.value));

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
    const handler: EventListener = () => {
      editor.selectTool(button.dataset.tool as Tool);
      refreshToolButtons(editor);
    };
    button.addEventListener('click', handler);
    listeners.push([button, 'click', handler]);
  }

  return () => {
    for (const [target, type, handler, options] of listeners) target.removeEventListener(type, handler, options);
  };
}

/** `#btnPng` handler of the original (`editor_app.js:648-653`). */
async function exportPng(editor: Editor, base: string): Promise<void> {
  commitName(editor);
  const button = el<HTMLButtonElement>('btnPng');
  if (button) button.disabled = true;
  editor.message('正在生成 PNG…');
  try {
    const out = await exportCanvas(editor, base);
    const blob = await new Promise<Blob | null>(resolve => out.toBlob(resolve, 'image/png'));
    if (!blob) throw Error('PNG 编码失败');
    download(blob, filename(editor, '.png'));
    editor.message(`PNG 已导出：${out.width}×${out.height}`);
  } catch (error) {
    editor.message((error as Error).message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

/** The `showHints` half of the original's `pointerup` handler. */
function hintClick(editor: Editor, event: PointerEvent, index: number): void {
  const node = editor.data.nodes[index];
  const canvas = editor.canvas;
  if (!node || !canvas) return;
  const building = editor.buildings[node.templateId]!;
  const f = editor.footprintOf(node);
  const rect = canvas.getBoundingClientRect();
  const cx = editor.view.ox + (f.x0 + f.w / 2) * editor.view.s;
  const cy = editor.view.oy + (f.z0 + f.d / 2) * editor.view.s;
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const within = (left: number, top: number) => x >= left && x <= left + 22 && y >= top && y <= top + 22;
  if (
    building.canModify &&
    x > cx + Math.min(4, editor.view.s * 0.1) &&
    y < cy - Math.min(4, editor.view.s * 0.1) &&
    within(cx + (67.5 / 128) * editor.view.s - 22, cy - (67.5 / 128) * editor.view.s)
  ) {
    openProductLibrary(editor);
  } else if (building.underground && within(cx - 1, cy - 20.25)) {
    editor.toggleConnection();
  }
}

/** `commitName()` of the original. */
export function commitName(editor: Editor): void {
  const input = el<HTMLInputElement>('bpName');
  if (!input) return;
  if (input.value.trim() !== editor.data.name) {
    editor.transact(draft => {
      draft.name = input.value.trim() || '未命名蓝图';
    }, '名称已更新');
  }
}

/** `filename(extension)` of the original. */
export function filename(editor: Editor, extension: string): string {
  return (editor.data.name || 'blueprint').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') + extension;
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** `downloadJson()` of the original. */
function downloadJson(editor: Editor): void {
  commitName(editor);
  download(new Blob([JSON.stringify(editor.data, null, 2)], { type: 'application/json' }), filename(editor, '.json'));
  editor.message('JSON 已导出');
}

/** `#fileIn` handler of the original. */
async function importFile(editor: Editor): Promise<void> {
  const input = el<HTMLInputElement>('fileIn');
  const file = input?.files?.[0];
  if (input) input.value = '';
  if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) throw Error('JSON 文件过大');
    editor.importLayout(JSON.parse(await file.text()));
  } catch (error) {
    editor.message(`导入失败：${(error as Error).message}`, true);
  }
}

/**
 * `exportCanvas()` of the original (`editor_app.js:633-647`).
 *
 * Exposed because the original exposed it through `window.BlueprintEditor` for embedding and offline
 * verification; `src/ui/api.ts` is its only caller.
 */
export async function exportCanvas(
  editor: Editor,
  base: string,
  layout: Layout = editor.data,
  cell?: number,
  transparent?: boolean,
  hints?: boolean,
): Promise<HTMLCanvasElement> {
  const source = structuredClone(layout);
  const scale = cell ?? Number(el<HTMLSelectElement>('exportScale')?.value ?? 64);
  const clear = transparent ?? el<HTMLInputElement>('transparent')?.checked ?? false;
  const showHints = hints ?? editor.showHints;
  if (![40, 64, 128].includes(scale)) throw Error('无效的导出分辨率');
  await editor.prepareScene(source, base);
  const b = editor.boundsOf(source, 1);
  const top = clear ? 0 : 48;
  const out = document.createElement('canvas');
  out.width = (b.x1 - b.x0) * scale;
  out.height = (b.z1 - b.z0) * scale + top;
  const ctx = out.getContext('2d')!;
  if (!clear) {
    ctx.fillStyle = '#e6e6e6';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.fillStyle = '#454545';
    ctx.font = '20px "HarmonyOS Sans SC",sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(source.name, 18, 24, out.width - 36);
  }
  // Coordinates are shifted exactly once; rotated dimensions come from Core.bounds.
  paintScene(
    ctx,
    source,
    editor.paintContextPublic(),
    { s: scale, ox: -b.x0 * scale, oy: top - b.z0 * scale },
    {
      grid: !clear && editor.showGrid,
      bounds: b,
      hints: showHints,
      activePair: source.presentation?.connectionPair || null,
    },
  );
  return out;
}
