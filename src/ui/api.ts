/**
 * The embedding API, as the original exposed it.
 *
 * `editor_app.js:1368` published `window.BlueprintEditor` and `editor_presentation.js:676` published
 * `window.BlueprintPresentation`, both for embedding and for deterministic offline verification. Keeping
 * the same names and shapes means the original's browser tests and any embedder keep working, which is
 * part of migrating the app rather than replacing it.
 */
import type { Layout } from '../core/types';
import type { Editor } from './editor';
import type { PresentationState } from './presentation';
import { open as openPresentation, scheduleRender } from './presentation';
import { exportPreviewSheet } from './presentationPaint';
import { exportCanvas } from './wiring';

export interface PublicEditor {
  getData: () => Layout;
  importLayout: (input: unknown) => void;
  exportCanvas: (layout?: Layout, cell?: number, transparent?: boolean, hints?: boolean) => Promise<HTMLCanvasElement>;
  /** Attached by the original's presentation script (`editor_presentation.js:686`). */
  exportPreview: (layout?: Layout, width?: number) => Promise<HTMLCanvasElement>;
  /** The live canvas viewport, so embedders and tests can convert cells to screen coordinates. */
  getViewport: () => { s: number; ox: number; oy: number };
  /** The editor canvas element. */
  canvas: () => HTMLCanvasElement | null;
  ready: Promise<void> | null;
}

export interface PublicPresentation {
  open: () => void;
  exportPreview: (layout?: Layout, width?: number) => Promise<HTMLCanvasElement>;
  refresh: () => void;
}

declare global {
  interface Window {
    BlueprintEditor?: PublicEditor;
    BlueprintPresentation?: PublicPresentation;
    /** The original's scene preloader, awaited by its browser tests after an import. */
    prepareScene?: (layout: Layout) => Promise<void>;
  }
}

/**
 * Publishes the embedding API.
 *
 * Returns a teardown so a remount cannot leave a stale API bound to a destroyed editor.
 */
export function publishApi(editor: Editor, state: PresentationState, base: string): () => void {
  const exportPreview = (layout?: Layout, width = 2560) =>
    exportPreviewSheet(editor, layout ?? editor.data, width, base);

  const api: PublicEditor = {
    getData: () => structuredClone(editor.data),
    importLayout: input => {
      editor.importLayout(input);
    },
    exportCanvas: (layout, cell, transparent, hints) =>
      exportCanvas(editor, base, layout ?? editor.data, cell, transparent, hints),
    exportPreview,
    getViewport: () => ({ ...editor.view }),
    canvas: () => editor.canvas,
    ready: null,
  };

  const presentation: PublicPresentation = {
    open: () => void openPresentation(editor, state, base),
    exportPreview,
    refresh: () => {
      // The original refreshed only while its dialog was open, and only when a draft existed.
      const dialog = document.getElementById('presentationDialog') as HTMLDialogElement | null;
      if (dialog?.open && state.draft) scheduleRender(editor, state, base);
    },
  };

  window.BlueprintEditor = api;
  window.BlueprintPresentation = presentation;
  window.prepareScene = layout => editor.prepareScene(layout, base);

  return () => {
    delete window.BlueprintEditor;
    delete window.BlueprintPresentation;
    delete window.prepareScene;
  };
}
