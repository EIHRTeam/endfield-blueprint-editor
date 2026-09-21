/**
 * Progress for the sprite bake, rendered into the original's `#loading` line.
 *
 * Baking through Pyodide takes a minute or more, so silence is not an option. It also must not become
 * new UI: `#loading` is a single text node in the original — `#loading{position:absolute;inset:0;…}`
 * covers the canvas, and `tests/dom-parity.test.mjs` asserts it holds no child elements. Progress
 * therefore replaces that one line's text, exactly as the original replaced it when the boot failed
 * (`editor_app.js:688`).
 *
 * Two rules keep it honest:
 *   - updates are throttled, and skip when the text is unchanged, so a 1,152-file fetch does not thrash
 *     layout;
 *   - the elapsed-seconds ticker runs only while a phase has no measurable ratio, and stops the moment
 *     the scene is ready, so nothing is left mutating the DOM behind the user's back.
 */
import type { BakeProgress } from '../bake/protocol';

const el = (): HTMLElement | null => document.getElementById('loading');

/** How often the text may change while work is in flight. */
const THROTTLE_MS = 150;

/** Phases whose length cannot be measured, so elapsed time is shown instead of a percentage. */
const INDETERMINATE = new Set<BakeProgress['phase']>(['pyodide', 'pillow', 'bake']);

/** Labels for phases where the worker's own message is a coarse stage name. */
const PHASE_LABEL: Partial<Record<BakeProgress['phase'], string>> = {
  pyodide: '正在加载 Pyodide 运行时',
  pillow: '正在加载 Pillow（WASM）',
  bake: '正在合成素材',
};

export interface ProgressHandle {
  /** Renders one update from the baking worker. */
  report: (progress: BakeProgress) => void;
  /** Stops all further writes, including the elapsed ticker. */
  stop: () => void;
}

export function createProgress(): ProgressHandle {
  const started = performance.now();
  let latest: BakeProgress | null = null;
  let lastWrite = -Infinity;
  let timer: ReturnType<typeof setInterval> | undefined;
  let done = false;

  const seconds = () => Math.round((performance.now() - started) / 1000);

  /** The line for the current phase, or null when a phase is too coarse for one line to mean much. */
  function line(progress: BakeProgress): string | null {
    const { phase, message, ratio } = progress;
    switch (phase) {
      case 'pyodide':
      case 'pillow':
        return `${PHASE_LABEL[phase]}…（已用时 ${seconds()} 秒）`;
      case 'assets':
        return ratio > 0 && ratio < 1
          ? `${message}（${Math.round(ratio * 100)}%）`
          : `${message}…（已用时 ${seconds()} 秒）`;
      case 'decode':
        return `${message}（${Math.round(ratio * 100)}%）`;
      case 'bake':
        return `${PHASE_LABEL.bake}：${message.replace(/^正在合成：?/, '')}（已用时 ${seconds()} 秒）`;
      case 'done':
        return `${message}，正在准备画布…`;
      default:
        return null;
    }
  }

  function paint(force: boolean): void {
    if (done || !latest) return;
    const target = el();
    if (!target) return;
    const text = line(latest);
    if (!text || text === target.textContent) return;
    const now = performance.now();
    if (!force && now - lastWrite < THROTTLE_MS) return;
    target.textContent = text;
    lastWrite = now;
  }

  function ensureTicker(): void {
    // Only a phase without a measurable ratio needs a clock; determinate phases already move.
    const needsTicker = latest !== null && INDETERMINATE.has(latest.phase);
    if (needsTicker && timer === undefined) {
      timer = setInterval(() => paint(true), 1000);
      return;
    }
    if (!needsTicker && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  return {
    report(progress) {
      if (done) return;
      latest = progress;
      paint(progress.phase === 'done');
      ensureTicker();
    },
    stop() {
      done = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
