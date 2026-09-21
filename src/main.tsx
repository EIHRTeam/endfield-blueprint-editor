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
    void (async () => {
      try {
        const booted = await boot(progress => {
          // The original's single static line is the only boot surface; progress replaces its text.
          const loading = loadingElement();
          if (loading && progress.message) loading.textContent = progress.message;
        });
        if (!cancelled) setResult(booted);
      } catch (error) {
        if (cancelled) return;
        const text = error instanceof Error ? error.message : String(error);
        const loading = loadingElement();
        if (loading) loading.textContent = text;
        setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
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

  if (failed || !result) return null;

  const message = startupMessage(result);
  return (
    <EditorView
      payload={result.payload}
      assets={result.assets}
      licence={result.licence}
      startupMessage={message.text}
      startupError={message.error}
    />
  );
}

createRoot(document.body).render(<Root />);
