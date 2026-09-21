/**
 * Application boot.
 *
 * This is the transcription of the original's bottom-of-file boot sequence
 * (`editor_app.js:683-688`):
 *
 *   buildList(); refreshInspector(); refreshSummary(); refreshHistory();
 *   $('bpName').value = data.name;
 *   resize(); fit(); selectTool('select');
 *   window.BlueprintEditor.ready = prepareScene(data).then(() => { $('loading').hidden = true; ... })
 *
 * The one part that is not a transcription is where the sprite set comes from. The original had it
 * pre-baked into the page at build time; Pillow now runs in the browser through Pyodide, so the boot
 * sequence bakes first and then proceeds unchanged.
 */
import { bakeCacheKey, readCachedBake, writeCachedBake } from './cache';
import { bakeBlueprint } from '../bake/bridge';
import { AssetStore } from '../render/assets';
import type { AssetsManifest, BakeProgress } from '../bake/protocol';
import type { AssetIndex, BakePayload } from '../core/types';

export interface BootResult {
  payload: BakePayload;
  assets: AssetStore;
  licence: string;
  reports: Record<string, string>;
  /** True when the bake was served from IndexedDB rather than recomputed. */
  fromCache: boolean;
  /** Non-fatal draft-restore problem, surfaced by the status bar. */
  restoreNotice: string;
  /** True when the restored draft has devices. */
  restoredDevices: boolean;
}

export type ProgressReporter = (progress: BakeProgress) => void;

const BASE = import.meta.env.BASE_URL;

async function fetchManifest(): Promise<AssetsManifest> {
  const response = await fetch(`${BASE}assets-manifest.json`, { cache: 'no-cache' });
  if (!response.ok) throw Error(`无法读取资源清单（HTTP ${response.status}）`);
  return (await response.json()) as AssetsManifest;
}

/** Hashes the Python sources so editing them invalidates the cache. */
async function digestPython(manifest: AssetsManifest): Promise<string> {
  const modules = manifest.files.filter(file => file.path.endsWith('.py'));
  const parts = await Promise.all(
    modules.map(async file => {
      const response = await fetch(`${BASE}${file.url}`);
      return response.ok ? await response.text() : '';
    }),
  );
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('\u0000')));
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

async function stagedPyodideVersion(): Promise<string> {
  try {
    const response = await fetch(`${BASE}pyodide/vendor-manifest.json`, { cache: 'force-cache' });
    if (response.ok) return ((await response.json()) as { pyodideVersion?: string }).pyodideVersion ?? 'unknown';
  } catch {
    /* falls through to the sentinel */
  }
  return 'unknown';
}

function assetUrl(key: string, extension: string): string {
  return `${BASE}baked/assets/${key}.${extension}`;
}

/** Decodes encoded PNG/WEBP bytes into bitmaps in batches, yielding so progress can paint. */
async function decodeInto(
  images: Map<string, { extension: 'png' | 'webp'; bytes: ArrayBuffer }>,
  assets: AssetStore,
  onProgress: ProgressReporter,
): Promise<void> {
  const entries = [...images.entries()];
  const batchSize = 24;
  for (let i = 0; i < entries.length; i += batchSize) {
    // Batches are sequential on purpose: each decodes in parallel, but the next waits, so progress can
    // paint and peak memory stays bounded instead of holding every decoded bitmap at once.
    // oxlint-disable-next-line no-await-in-loop -- see comment above
    await Promise.all(
      entries.slice(i, i + batchSize).map(async ([key, asset]) => {
        const blob = new Blob([asset.bytes], { type: asset.extension === 'webp' ? 'image/webp' : 'image/png' });
        assets.put(key, await createImageBitmap(blob));
      }),
    );
    onProgress({
      phase: 'decode',
      message: `正在解码图片 ${Math.min(i + batchSize, entries.length)} / ${entries.length}`,
      ratio: Math.min(1, (i + batchSize) / entries.length),
    });
  }
}

/**
 * Bakes (or restores) the sprite set, then hands back everything the editor needs.
 *
 * Progress is reported through `onProgress`; the original showed a single static line while its assets
 * were already embedded, so the messages land in the existing `#loading` element rather than a new
 * progress surface.
 */
export async function boot(onProgress: ProgressReporter): Promise<BootResult> {
  const manifest = await fetchManifest();
  const cacheKey = await bakeCacheKey({
    pyodideVersion: await stagedPyodideVersion(),
    pythonDigest: await digestPython(manifest),
    manifestCount: manifest.count,
    manifestBytes: manifest.bytes,
  });

  const licence = await fetch(`${BASE}assets/fonts/HarmonyOS_Sans_SC/LICENSE.txt`, { cache: 'force-cache' })
    .then(response => (response.ok ? response.text() : ''))
    .catch(() => '');

  const cached = await readCachedBake(cacheKey);
  let payloadJson: string;
  let reports: Record<string, string>;
  let images: Map<string, { extension: 'png' | 'webp'; bytes: ArrayBuffer }>;

  if (cached) {
    onProgress({ phase: 'decode', message: '正在读取本机缓存…', ratio: 0 });
    payloadJson = cached.payload;
    reports = cached.reports;
    images = cached.images;
  } else {
    const result = await bakeBlueprint(BASE, { onProgress });
    payloadJson = result.payload;
    reports = result.reports;
    images = new Map(result.assets.map(asset => [asset.key, { extension: asset.extension, bytes: asset.bytes }]));
    await writeCachedBake({ key: cacheKey, payload: payloadJson, reports, images });
  }

  const payload = JSON.parse(payloadJson) as BakePayload;
  const urls: AssetIndex = {};
  for (const [key, asset] of images) urls[key] = assetUrl(key, asset.extension);

  const assets = new AssetStore(urls);
  await decodeInto(images, assets, onProgress);

  for (const key of Object.values(payload.sprites)) {
    if (!urls[key]) urls[key] = assetUrl(key, 'png');
  }

  return { payload, assets, licence, reports, fromCache: Boolean(cached), restoreNotice: '', restoredDevices: false };
}

/** The message the original's boot tail set, in the same order of precedence. */
export function startupMessage(result: BootResult): { text: string; error: boolean } {
  if (result.restoreNotice) return { text: result.restoreNotice, error: true };
  if (result.restoredDevices) return { text: '已恢复本机草稿', error: false };
  return { text: '选择设备或点击“示例”开始编辑', error: false };
}

export { BASE };
