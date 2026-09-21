/**
 * The React entry point of the editor.
 *
 * The shell's markup is rendered by React; everything inside it is filled by `src/ui/dom.ts`, which is
 * the transcription of the original's `changed()` fan-out. This component's whole job is to create the
 * controller, hand it the canvas, wire the listeners, and keep the imperative view in step with React's
 * renders — which is why it holds almost no logic of its own.
 */
import { useEffect, useRef, useState } from 'react';
import type { BakePayload } from '../core/types';
import type { AssetStore } from '../render/assets';
import { Editor } from './editor';
import { syncAll } from './dom';
import { publishApi } from './api';
import { createPresentationState, initPresentation } from './presentation';
import { Shell } from './shell';
import { wireEditor } from './wiring';

export interface EditorViewProps {
  payload: BakePayload;
  assets: AssetStore;
  licence: string;
  /** Message the status bar should show once the editor is interactive. */
  startupMessage: string;
  startupError?: boolean;
}

export function EditorView({ payload, assets, licence, startupMessage, startupError }: EditorViewProps) {
  const [search, setSearch] = useState('');
  const [, bump] = useState(0);
  const rerender = () => bump(value => value + 1);

  const [editor] = useState(
    () =>
      new Editor({
        payload,
        assets,
        onRevision: rerender,
        status: {
          // The footer's status and save text are written by the editor, exactly as the original wrote them.
          setStatus: (text, error) => {
            const node = document.getElementById('status');
            if (!node) return;
            node.textContent = text;
            node.classList.toggle('error', error);
          },
          setSaveStatus: text => {
            const node = document.getElementById('saveStatus');
            if (node) node.textContent = text;
          },
        },
      }),
  );

  const [presentation] = useState(createPresentationState);
  const wired = useRef(false);

  useEffect(() => {
    if (wired.current) return;
    wired.current = true;
    const canvas = document.getElementById('cv') as HTMLCanvasElement | null;
    const wrap = document.getElementById('wrap') as HTMLElement | null;
    if (!canvas || !wrap) return;
    editor.canvas = canvas;
    editor.ctx = canvas.getContext('2d');
    editor.wrap = wrap;

    const base = import.meta.env.BASE_URL;
    const teardownEditor = wireEditor(editor, base, {
      rerender,
      setSearch,
      setLibrarySearch: () => {},
      setCoverSearch: () => {},
      setCoverScope: () => {},
      setFilters: () => {},
    });
    // The original's presentation script ran its init block at load: the settings button, the colour
    // buttons and the tag suggestions all come from there, not from the template.
    const teardownPresentation = initPresentation(editor, presentation, base);
    // The original published this at the end of its script; the same names are kept so embedders and the
    // original's browser tests keep working.
    const teardownApi = publishApi(editor, presentation, base);

    // The original's boot tail: initial paint sizing, first flush, then the loading overlay.
    editor.resize();
    editor.fit();
    syncAll(editor, '');
    editor.message(startupMessage, startupError ?? false);
    editor.requestDraw();

    return () => {
      teardownEditor();
      teardownPresentation();
      teardownApi();
    };
    // Boot runs once; the editor is stable for the life of the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `changed()` re-renders React, and the flush is re-run so the imperative view always matches.
  useEffect(() => {
    if (!editor.canvas) return;
    syncAll(editor, search);
  });

  return <Shell licence={licence} loadingHidden />;
}
