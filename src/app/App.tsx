/**
 * Editor shell.
 *
 * Owns the bootstrap lifecycle: while Pyodide composes the artwork the user sees progress, and any
 * failure is reported with an actionable message instead of a blank page. Once ready, the document is
 * handed to the store and the header / sidebar / canvas / inspector are mounted.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SceneContextProvider } from '../app/SceneContext';
import type { SceneValue, ViewportHandle } from '../app/SceneContext';
import { StoreProvider } from '../app/store';
import { bootstrap } from '../app/bootstrap';
import type { BootstrapResult } from '../app/bootstrap';
import { BakeError, LoadingScreen } from './LoadingScreen';
import { EditorChrome } from './EditorChrome';

const BASE = import.meta.env.BASE_URL;

type Phase =
  | { phase: 'loading'; message: string; ratio: number }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; result: BootstrapResult };

export function App() {
  const [state, setState] = useState<Phase>({ phase: 'loading', message: '正在准备蓝图素材…', ratio: 0 });

  useEffect(() => {
    let cancelled = false;
    bootstrap(BASE, progress => {
      if (cancelled) return;
      setState(previous =>
        previous.phase === 'loading'
          ? { phase: 'loading', message: progress.message, ratio: progress.ratio }
          : previous,
      );
    })
      .then(result => {
        if (!cancelled) setState({ phase: 'ready', result });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ phase: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.phase === 'loading') return <LoadingScreen message={state.message} ratio={state.ratio} />;
  if (state.phase === 'error') return <BakeError message={state.message} />;
  return <ReadyApp result={state.result} />;
}

function ReadyApp({ result }: { result: BootstrapResult }) {
  const [libraryTarget, setLibraryTarget] = useState<number | null>(null);
  const [presentationOpen, setPresentationOpen] = useState(false);

  /**
   * The canvas viewport handle is held in a ref, not state.
   *
   * Storing it in state would make registering the handle re-create the scene context, which re-renders
   * every consumer including the canvas — and the canvas re-registers on each of its own effects. That
   * feedback loop remounted the dialogs continuously, which silently cancelled the preview's debounced
   * render. A ref keeps the handle readable without invalidating any consumer.
   */
  const viewport = useRef<ViewportHandle | null>(null);
  const registerViewport = useCallback((handle: ViewportHandle) => {
    viewport.current = handle;
  }, []);
  /** `openLibrary` accepts a device index, or -1 to mean "no target, use the icon brush". */
  const openLibrary = useCallback((index: number | null) => setLibraryTarget(index ?? -1), []);
  const openPresentation = useCallback(() => setPresentationOpen(true), []);

  const scene = useMemo<SceneValue>(
    () => ({
      assets: result.assets,
      payload: result.payload,
      products: result.payload.products,
      lineItems: result.payload.lineItems,
      sprites: result.payload.sprites,
      spriteBorders: result.payload.spriteBorders,
      statusLayers: result.payload.statusLayers,
      presentation: result.payload.presentation,
      license: result.license,
      base: BASE,
      registerViewport,
      viewport: () => viewport.current,
      openLibrary,
      openPresentation,
    }),
    [result, registerViewport, openLibrary, openPresentation],
  );

  return (
    <StoreProvider payload={result.payload} initial={result.initial} restoreNotice={result.restoreNotice}>
      <SceneContextProvider value={scene}>
        <EditorChrome
          libraryTarget={libraryTarget}
          setLibraryTarget={setLibraryTarget}
          presentationOpen={presentationOpen}
          setPresentationOpen={setPresentationOpen}
        />
      </SceneContextProvider>
    </StoreProvider>
  );
}
