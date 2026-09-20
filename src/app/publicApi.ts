/**
 * Public API surface.
 *
 * The previous single-file editor exposed `window.BlueprintEditor` and `window.BlueprintPresentation`
 * for embedding and for deterministic offline verification. Both names are kept so the existing
 * browser regression suite keeps working; they now delegate to React state.
 */
import { useEffect, useRef } from 'react';
import { clone, validate } from '../core';
import type { Layout } from '../core/types';
import { useEditorStore } from './store';
import { useScene } from './SceneContext';
import { exportCanvas } from './export';

interface PublicEditor {
  getData: () => Layout;
  /** Current canvas viewport, so embedders and tests can convert cells to screen coordinates. */
  getViewport: () => { s: number; ox: number; oy: number } | null;
  /** Canvas element the viewport refers to. */
  canvas: () => HTMLCanvasElement | null;
  importLayout: (input: unknown) => void;
  exportCanvas: (layout?: Layout, cell?: number, transparent?: boolean, hints?: boolean) => Promise<HTMLCanvasElement>;
  exportPreview: (layout?: Layout, width?: number) => Promise<HTMLCanvasElement>;
  ready: Promise<void>;
}

declare global {
  interface Window {
    BlueprintEditor?: PublicEditor;
    BlueprintPresentation?: {
      open: () => void;
      exportPreview: (layout?: Layout, width?: number) => Promise<HTMLCanvasElement>;
      refresh: () => void;
    };
    /** Kept for parity with the previous implementation's browser checks. */
    prepareScene?: (layout: Layout) => Promise<void>;
  }
}

/**
 * Publishes the embedding API and keeps it pointing at the current document.
 *
 * The store is captured in a ref so the API object stays stable while the document changes; the
 * previous implementation bound `getData` to a module-level variable, which this reproduces.
 */
export function usePublicApi(): void {
  const store = useEditorStore();
  const scene = useScene();
  /**
   * Live handles for the embedding API.
   *
   * React hands consumers a new `store` object only when it re-renders, so a caller that reads
   * immediately after `importLayout` would otherwise see a value one commit behind. The document is
   * therefore mirrored into a mutable holder that the API reads, and the holder is resynchronised
   * from the store in an effect rather than during render.
   */
  const holder = useRef({ data: store.data, store, scene });
  useEffect(() => {
    holder.current.store = store;
    holder.current.scene = scene;
    holder.current.data = store.data;
  }, [store, scene]);

  useEffect(() => {
    const api: PublicEditor = {
      getData: () => clone(holder.current.data),
      getViewport: () => holder.current.scene.viewport()?.view() ?? null,
      canvas: () => document.getElementById('cv') as HTMLCanvasElement | null,
      importLayout: input => {
        const { store: current, scene: currentScene } = holder.current;
        try {
          const next = validate(input, current.buildings);
          // `reset` applies the document without touching history, then the before/after pair is
          // committed explicitly. Both steps are required: committing without resetting would leave
          // the live document unchanged, and the import would appear to do nothing until the next
          // undo or redo.
          const before = holder.current.data;
          current.reset(next);
          current.commitExternal(before, next, `已导入 ${next.nodes.length} 个设备 / ${next.conveyors.length} 段线路`);
          // Keep the mirror current so a caller that reads immediately sees the imported document.
          // The effect that resynchronises from the store runs after this, and writes the same value.
          holder.current.data = next;
          currentScene.viewport()?.fit();
          const missing = next.nodes.filter(node => {
            const key = node.productIcon?.startsWith('[gas]') ? node.productIcon.toLowerCase() : node.productIcon;
            return Boolean(key) && !currentScene.products[key!]?.badge;
          }).length;
          if (missing) current.setStatus(`导入完成；${missing} 个产物缺图，ID 已保留`, true);
        } catch (error) {
          current.setStatus(`导入失败：${(error as Error).message}`, true);
          throw error;
        }
      },
      exportCanvas: (layout, cell = 64, transparent = false, hints = true) =>
        exportCanvas(holder.current.scene, layout ?? holder.current.data, { cell, transparent, hints }),
      exportPreview: async (layout, width = 2560) => {
        const module = await import('../features/presentation/export');
        return module.default(holder.current.scene, layout ?? holder.current.data, width);
      },
      ready: Promise.resolve(),
    };

    window.BlueprintEditor = api;
    window.BlueprintPresentation = {
      open: () => holder.current.scene.openPresentation(),
      exportPreview: api.exportPreview,
      refresh: () => {},
    };
    // The old suite awaited `prepareScene(data)` after importing a layout; assets are already
    // decoded by then, so this resolves immediately.
    window.prepareScene = async () => {};
    return () => {
      delete window.BlueprintEditor;
      delete window.BlueprintPresentation;
      delete window.prepareScene;
    };
  }, []);
}
