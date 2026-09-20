/**
 * Application bootstrap.
 *
 * Everything expensive happens here exactly once: the fonts are loaded, the baking worker composes
 * every sprite through Pyodide, and the result is cached so later visits skip both steps.
 *
 * Every image the editor draws is emitted by Python as encoded bytes, so there is exactly one asset
 * source and no dual "static vs baked" load path to keep in sync.
 */
import { validate } from '../core';
import type { AssetIndex, BakePayload, Layout } from '../core/types';
import type { AssetsManifest, BakeProgress } from '../bake/protocol';
import { bakeBlueprint, decodeBatch } from '../bake/bridge';
import { AssetStore } from '../render/assets';
import { bakeCacheKey, readCachedBake, writeCachedBake } from './cache';
import type { CachedBake } from './cache';
import { loadFonts } from './fonts';
import { EMPTY_LAYOUT, STORAGE_KEY } from './store';

export interface BootstrapResult {
  payload: BakePayload;
  assets: AssetStore;
  license: string;
  reports: Record<string, string>;
  /** Restored draft, or the empty document. */
  initial: Layout;
  /** A non-fatal restore problem worth surfacing once the UI is up. */
  restoreNotice: string;
  /** True when the result came from IndexedDB rather than a fresh bake. */
  fromCache: boolean;
}

export type ProgressReporter = (progress: BakeProgress) => void;

async function fetchManifest(base: string): Promise<AssetsManifest> {
  const response = await fetch(`${base}assets-manifest.json`, { cache: 'no-cache' });
  if (!response.ok) throw Error(`无法读取资源清单（HTTP ${response.status}）`);
  return (await response.json()) as AssetsManifest;
}

/** Hashes the Python sources so any edit invalidates the cache. */
async function digestPython(base: string, manifest: AssetsManifest): Promise<string> {
  const modules = manifest.files.filter(file => file.path.endsWith('.py'));
  const parts = await Promise.all(
    modules.map(async file => {
      const response = await fetch(`${base}${file.url}`);
      return response.ok ? await response.text() : '';
    }),
  );
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('\u0000')));
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

async function stagedPyodideVersion(base: string): Promise<string> {
  try {
    const response = await fetch(`${base}pyodide/vendor-manifest.json`, { cache: 'force-cache' });
    if (response.ok) return ((await response.json()) as { pyodideVersion?: string }).pyodideVersion ?? 'unknown';
  } catch {
    /* falls through to the sentinel below */
  }
  return 'unknown';
}

/** URL an asset would have if it were fetched from disk rather than decoded from the worker. */
function assetUrl(base: string, key: string, extension: string): string {
  return `${base}baked/assets/${key}.${extension}`;
}

function restoreDraft(buildings: Record<string, unknown>): { data: Layout; notice: string } {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return { data: EMPTY_LAYOUT, notice: '' };
    return { data: validate(JSON.parse(saved), buildings as never), notice: '' };
  } catch (error) {
    return {
      data: EMPTY_LAYOUT,
      notice: `草稿未恢复：${(error as Error).message}。原记录保留，修改后才会覆盖。`,
    };
  }
}

/**
 * Boots the editor.
 *
 * @param base Vite's `BASE_URL`, used for every runtime resource so sub-path deployments work.
 */
export async function bootstrap(base: string, onProgress: ProgressReporter): Promise<BootstrapResult> {
  onProgress({ phase: 'pyodide', message: '正在加载字体…', ratio: 0 });
  // The licence is a plain static file, so the main thread fetches it directly rather than routing
  // 32 KB of notice text through the Python runtime.
  const [license] = await Promise.all([
    fetch(`${base}assets/fonts/LICENSE-update.txt`, { cache: 'force-cache' })
      .then(response => (response.ok ? response.text() : ''))
      .catch(() => ''),
    loadFonts(base),
  ]);

  const manifest = await fetchManifest(base);
  const cacheKey = await bakeCacheKey({
    pyodideVersion: await stagedPyodideVersion(base),
    pythonDigest: await digestPython(base, manifest),
    manifestCount: manifest.count,
    manifestBytes: manifest.bytes,
  });

  const cached: CachedBake | null = await readCachedBake(cacheKey);
  let payloadJson: string;
  let reports: Record<string, string>;
  let images: Map<string, { extension: 'png' | 'webp'; bytes: ArrayBuffer }>;

  if (cached) {
    onProgress({ phase: 'decode', message: '正在读取本机缓存…', ratio: 0 });
    payloadJson = cached.payload;
    reports = cached.reports;
    images = cached.images;
  } else {
    const result = await bakeBlueprint(base, { onProgress });
    payloadJson = result.payload;
    reports = result.reports;
    images = new Map(result.assets.map(asset => [asset.key, { extension: asset.extension, bytes: asset.bytes }]));
    // Persist for the next visit; a quota failure is not fatal and simply means re-baking.
    await writeCachedBake({ key: cacheKey, payload: payloadJson, reports, images });
  }

  const payload = JSON.parse(payloadJson) as BakePayload;
  const urls: AssetIndex = {};
  for (const [key, asset] of images) urls[key] = assetUrl(base, key, asset.extension);

  const assets = new AssetStore(urls);
  await decodeBatch(
    [...images.entries()],
    (key, bitmap) => assets.put(key, bitmap),
    (done, total) => {
      onProgress({ phase: 'decode', message: `正在解码图片 ${done} / ${total}`, ratio: total ? done / total : 1 });
    },
  );

  // Sprite keys are referenced symbolically by the renderer; make sure each one resolves to a URL.
  for (const key of Object.values(payload.sprites)) {
    if (!urls[key]) urls[key] = assetUrl(base, key, 'png');
  }

  const { data, notice } = restoreDraft(payload.buildings as unknown as Record<string, unknown>);
  return { payload, assets, license, reports, initial: data, restoreNotice: notice, fromCache: Boolean(cached) };
}
