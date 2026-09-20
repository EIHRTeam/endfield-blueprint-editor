/**
 * Persistent bake cache.
 *
 * Baking is CPU-heavy and deterministic for a given set of inputs, so the result is stored in
 * IndexedDB under a key that covers every input that can change it. When any input changes the key
 * changes and the editor re-bakes instead of serving stale artwork.
 *
 * Only the encoded image bytes are stored; the payload JSON is stored alongside because it is small
 * and keeps the restore path to a single transaction.
 */
import type { BakedAsset } from '../bake/protocol';

const DB_NAME = 'endfield-blueprint-editor';
const DB_VERSION = 1;
const STORE = 'bakes';

export interface CachedBake {
  key: string;
  payload: string;
  reports: Record<string, string>;
  /** key -> encoded bytes. */
  images: Map<string, { extension: 'png' | 'webp'; bytes: ArrayBuffer }>;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? Error('IndexedDB 不可用'));
  });
}

/** Computes the cache key from the run inputs and the asset manifest. */
export async function bakeCacheKey(parts: {
  pyodideVersion: string;
  pythonDigest: string;
  manifestCount: number;
  manifestBytes: number;
}): Promise<string> {
  const text = [
    'v1',
    import.meta.env.DEV ? 'dev' : 'prod',
    parts.pyodideVersion,
    parts.pythonDigest,
    parts.manifestCount,
    parts.manifestBytes,
  ].join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

export async function readCachedBake(cacheKey: string): Promise<CachedBake | null> {
  try {
    const db = await openDatabase();
    return await new Promise<CachedBake | null>((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(cacheKey);
      request.onsuccess = () => resolve((request.result as CachedBake | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

/** Writes a bake result. Quota or private-mode failures degrade to a cache miss. */
export async function writeCachedBake(entry: CachedBake): Promise<boolean> {
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(entry);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    // Keep only the newest entry: the images dominate the origin's storage budget.
    await new Promise<void>(resolve => {
      const transaction = db.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      const request = store.getAllKeys();
      request.onsuccess = () => {
        for (const existing of request.result) if (existing !== entry.key) store.delete(existing);
        resolve();
      };
      request.onerror = () => resolve();
    });
    return true;
  } catch {
    return false;
  }
}

/** Converts a worker result into a cache entry. */
export function imagesFromAssets(assets: BakedAsset[]): CachedBake['images'] {
  const images = new Map<string, { extension: 'png' | 'webp'; bytes: ArrayBuffer }>();
  for (const asset of assets) images.set(asset.key, { extension: asset.extension, bytes: asset.bytes });
  return images;
}
