/**
 * Message contract between the editor and the Pyodide baking worker.
 *
 * The worker owns all Python execution. Assets travel one way (bytes into MEMFS) and composited
 * images travel the other way (PNG bytes out of Python, decoded on the main thread), so no base64
 * ever crosses the boundary.
 */

export interface ManifestEntry {
  /** Path inside the repository, kept for traceability and cache hashing. */
  path: string;
  bytes: number;
  /** Absolute path inside Pyodide's virtual filesystem. */
  mount: string;
  /** Deployed path relative to the site base, used for `fetch`. */
  url: string;
}

export interface AssetsManifest {
  root: string;
  count: number;
  bytes: number;
  files: ManifestEntry[];
}

/** A composited image emitted by Python: content-addressed key plus encoded PNG/WEBP bytes. */
export interface BakedAsset {
  key: string;
  extension: 'png' | 'webp';
  bytes: ArrayBuffer;
}

export interface BakeProgress {
  /** Coarse phase used for the progress bar. */
  phase: 'pyodide' | 'pillow' | 'assets' | 'bake' | 'decode' | 'done';
  /** Human-readable status line. */
  message: string;
  /** 0..1 where known. */
  ratio: number;
}

export interface BakeResult {
  /** Serialized editor payload (buildings, products, sprites, presentation, demo). */
  payload: string;
  /** Reports emitted by Python instead of being written to a `reports/` directory. */
  reports: Record<string, string>;
  /** Baked asset bytes, transferred rather than copied. */
  assets: BakedAsset[];
}

export type WorkerRequest = { type: 'bake' };

export type WorkerResponse =
  | { type: 'progress'; progress: BakeProgress }
  | { type: 'done'; result: BakeResult }
  | { type: 'error'; message: string };

/** Number of images decoded per batch before yielding, to keep the main thread responsive. */
export const DECODE_BATCH = 24;
