/**
 * Main-thread side of the baking worker.
 *
 * Keeps the worker lifecycle and the encoded-bytes transport in one place. Decoding is deliberately
 * the caller's job (see `app/cache.ts` and `app/bootstrap.ts`) because the caller has to decide
 * whether to persist the encoded bytes before turning them into bitmaps.
 */
import type { BakeProgress, BakeResult, WorkerResponse } from './protocol';

export interface BakeCallbacks {
  onProgress?: (progress: BakeProgress) => void;
}

/** Creates the baking worker. Vite emits it as its own chunk. */
function createWorker(): Worker {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
}

/**
 * Runs one full bake and resolves with the raw worker result.
 *
 * Rejects with a user-facing message when Pyodide, Pillow or the Python modules fail, so the UI can
 * show something actionable instead of a blank canvas.
 */
export async function bakeBlueprint(base: string, callbacks: BakeCallbacks = {}): Promise<BakeResult> {
  void base;
  const worker = createWorker();
  try {
    return await new Promise<BakeResult>((resolve, reject) => {
      worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
        const data = event.data;
        if (data.type === 'progress') callbacks.onProgress?.(data.progress);
        else if (data.type === 'done') resolve(data.result);
        else if (data.type === 'error') reject(Error(data.message));
      });
      worker.addEventListener('error', event => reject(Error(event.message || '烘焙线程启动失败')));
      worker.postMessage({ type: 'bake' });
    });
  } finally {
    worker.terminate();
  }
}

/**
 * Decodes encoded PNG/WEBP bytes into bitmaps in batches, yielding so progress can paint.
 *
 * A throwing `install` aborts the whole decode: the caller has been torn down (or is otherwise unable
 * to accept assets), and continuing would only produce a stream of identical failures.
 */
export async function decodeBatch(
  entries: Array<[string, { extension: 'png' | 'webp'; bytes: ArrayBuffer }]>,
  install: (key: string, bitmap: ImageBitmap) => void,
  onProgress?: (done: number, total: number) => void,
  batchSize = 24,
): Promise<void> {
  for (let i = 0; i < entries.length; i += batchSize) {
    // Sequential by design: each batch is decoded in parallel but the next batch waits, so progress
    // can paint and peak memory stays bounded instead of holding every decoded bitmap at once.
    // oxlint-disable-next-line no-await-in-loop -- batches are sequential by design (see above)
    await Promise.all(
      entries.slice(i, i + batchSize).map(async ([key, asset]) => {
        const type = asset.extension === 'webp' ? 'image/webp' : 'image/png';
        const blob = new Blob([asset.bytes], { type });
        install(key, await createImageBitmap(blob));
      }),
    );
    onProgress?.(Math.min(i + batchSize, entries.length), entries.length);
  }
}
