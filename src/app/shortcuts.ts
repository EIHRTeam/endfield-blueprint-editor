/**
 * Keyboard shortcuts.
 *
 * Bound once at the shell level, and disabled while a dialog or a text field owns the keyboard so
 * typing a blueprint name never deletes the selected device.
 */
import { useEffect } from 'react';
import { useEditorStore } from './store';
import { useScene } from './SceneContext';

export interface ShortcutHandlers {
  openPresentation: () => void;
  closeLibrary: () => void;
  openLibrary: () => void;
}

export function useGlobalShortcuts(handlers: ShortcutHandlers): void {
  const store = useEditorStore();
  const scene = useScene();

  useEffect(() => {
    const isDialogOpen = () => Boolean(document.querySelector('dialog[open], .license-overlay'));
    const isTextField = (target: EventTarget | null) =>
      target instanceof HTMLElement && Boolean(target.closest('input,select,textarea,[contenteditable="true"]'));

    const saveJson = () => document.getElementById('btnJson')?.click();
    const deleteSelected = () => {
      const index = store.selectedIndex;
      if (index < 0) return;
      store.setSelectedIndex(-1);
      store.transact(draft => draft.nodes.splice(index, 1), '已删除设备，可撤销');
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (isDialogOpen()) {
        if (event.code === 'Escape' && !document.querySelector('dialog[open]')) handlers.closeLibrary();
        return;
      }
      if (isTextField(event.target)) return;

      if (event.ctrlKey || event.metaKey) {
        if (event.code === 'KeyZ') {
          event.preventDefault();
          if (event.shiftKey) store.redo();
          else store.undo();
        } else if (event.code === 'KeyY') {
          event.preventDefault();
          store.redo();
        } else if (event.code === 'KeyS') {
          event.preventDefault();
          saveJson();
        }
        return;
      }

      if (event.repeat) return;
      switch (event.code) {
        case 'Escape':
          store.setTool('select');
          break;
        case 'KeyR':
          rotate(store);
          break;
        case 'KeyF':
          scene.viewport()?.fit();
          break;
        case 'Delete':
        case 'Backspace':
          event.preventDefault();
          deleteSelected();
          break;
        case 'KeyV':
          store.setTool('select');
          break;
        case 'KeyP':
          store.setTool('place');
          break;
        case 'KeyB':
          store.setTool('item');
          break;
        case 'KeyL':
          store.setTool('fluid');
          break;
        case 'KeyE':
          store.setTool('erase');
          break;
        case 'KeyI':
          handlers.openLibrary();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [store, scene, handlers]);
}

/** Rotates the selection, or the pending placement direction when nothing is selected. */
function rotate(store: ReturnType<typeof useEditorStore>): void {
  if (store.selectedIndex >= 0 && store.tool === 'select') {
    store.transact(draft => {
      const node = draft.nodes[store.selectedIndex]!;
      node.direction = ((node.direction + 1) % 4) as 0 | 1 | 2 | 3;
    }, '设备已旋转');
    return;
  }
  store.setRotation(((store.rotation + 1) % 4) as 0 | 1 | 2 | 3);
  store.setStatus(
    store.tool === 'item' || store.tool === 'fluid'
      ? `单格线路朝向：${['右', '下', '左', '上'][(store.rotation + 1) % 4]}`
      : `放置朝向：${((store.rotation + 1) % 4) * 90}°`,
  );
}
