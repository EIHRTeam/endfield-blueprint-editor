/**
 * Application entry point.
 *
 * React mounts directly onto `document.body`, because the original's markup *is* the body: `<header>`,
 * `<main>`, the three dialogs, `<footer>` and the hidden file input are all direct children of the body
 * in the original document. Adding a wrapper element would introduce a node the original does not have.
 *
 * `<StrictMode>` is deliberately absent: it double-invokes effects, which would bake the sprite set twice
 * and write the loading overlay's state twice.
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView } from './ui/editorView';
import { BASE, boot, startupMessage, type BootResult } from './app/boot';
import { loadFonts } from './app/fonts';
import { createProgress } from './app/progress';
// Side-effect import: the application stylesheet is bundled, not imported as a binding.
// oxlint-disable-next-line import/no-unassigned-import -- see comment above
import './styles.css';

/**
 * `#loading` element.
 *
 * The original drove this element directly (`$('loading').textContent = …`, `.hidden = true`), so it stays
 * outside React's render tree and is written from the same places.
 */
const loadingElement = (): HTMLElement | null => document.getElementById('loading');

function Root() {
  const [result, setResult] = useState<BootResult | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Baking takes a minute or more, so the overlay reports where it is. It writes into the original's
    // single text line rather than adding any surface around it.
    const progress = createProgress();
    void (async () => {
      try {
        const booted = await boot(progress.report);
        if (cancelled) return;
        setResult(booted);
      } catch (error) {
        if (cancelled) return;
        const text = error instanceof Error ? error.message : String(error);
        const loading = loadingElement();
        if (loading) loading.textContent = text;
        setFailed(true);
      } finally {
        // Nothing may keep writing to the overlay once the editor owns the page.
        progress.stop();
      }
    })();
    return () => {
      cancelled = true;
      progress.stop();
    };
  }, []);

  // The original's boot tail awaited `prepareScene(data)` and only then hid `#loading`.
  useEffect(() => {
    if (!result) return;
    void (async () => {
      await loadFonts(BASE).catch(() => undefined);
      const loading = loadingElement();
      if (loading) loading.hidden = true;
    })();
  }, [result]);

  if (failed) return null;
  if (!result) return <BootChrome />;

  const message = startupMessage(result);
  return (
    <>
      {/* The editor renders its own shell, including `#loading`, so it replaces BootChrome wholesale. */}
      <EditorView
        payload={result.payload}
        assets={result.assets}
        licence={result.licence}
        startupMessage={message.text}
        startupError={message.error}
      />
    </>
  );
}

/**
 * The page while the sprite set is being baked.
 *
 * The bake runs for a minute or more, and `#loading` is the only thing meant to be on screen while it
 * does — so it has to exist *before* the editor does, or the wait shows a blank page. This renders the
 * original's own loading markup (the `#wrap` section with its canvas and overlay) so the text progressed
 * by `src/app/progress.ts` has somewhere to land, with no element the original does not have.
 *
 * Once boot finishes, `EditorView` replaces this whole tree, which is what hides the overlay.
 */
function BootChrome() {
  return (
    <main>
      <section id="wrap">
        <canvas id="cv" tabIndex={0} aria-label="蓝图编辑画布" />
        <div id="loading">正在准备蓝图素材…</div>
      </section>
    </main>
  );
}

createRoot(document.body).render(<Root />);
