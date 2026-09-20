/**
 * Loads the bundled HarmonyOS Sans SC chunks and waits for them to be usable.
 *
 * The chunks are static files served next to their `result.css`, which has its `src:local(...)`
 * fallback stripped during staging. Waiting matters: measuring text or painting an export before the
 * font is ready silently changes both the live preview and the exported PNGs.
 *
 * The stylesheet is 383 `unicode-range` subsets, so `document.fonts.load` resolves with only the
 * subsets that cover the sample text. An empty result means the stylesheet or the chunks failed to
 * load, which is the only condition worth failing on — individual face `status` values are not
 * meaningful for subsets that were never requested.
 */
const FAMILY = 'HarmonyOS Sans SC';
const WEIGHTS = [400, 500, 600, 700];
const SAMPLE = '蓝图预览设备ABC0123';
const HREF = 'assets/fonts/HarmonyOS_Sans_SC/result.css';

let pending: Promise<void> | null = null;

/** Resolves once the family is usable; idempotent so repeated calls share one load. */
export function loadFonts(base: string): Promise<void> {
  pending ??= load(base);
  return pending;
}

async function load(base: string): Promise<void> {
  if (!document.querySelector('link[data-endfield-font]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${base}${HREF}`;
    link.dataset.endfieldFont = 'true';
    document.head.append(link);
    await new Promise<void>((resolve, reject) => {
      link.addEventListener('load', () => resolve());
      link.addEventListener('error', () => reject(Error(`字体样式表加载失败：${link.href}`)));
    });
  }

  const results = await Promise.all(WEIGHTS.map(weight => document.fonts.load(`${weight} 24px "${FAMILY}"`, SAMPLE)));
  const count = results.reduce((sum, faces) => sum + faces.length, 0);
  if (!count) throw Error('内嵌字体未加载，请重新打开页面');
}

export const FONT_FAMILY = FAMILY;
