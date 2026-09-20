/**
 * Pyodide baking worker.
 *
 * Responsibilities, in order:
 *   1. load the self-hosted Pyodide runtime and the Pillow wheel (both separate static files),
 *   2. fetch every source sprite/table listed in `assets-manifest.json` and write it into MEMFS,
 *   3. run the migrated `.py` modules to compose all baked sprites,
 *   4. transfer the encoded images back to the main thread.
 *
 * Nothing is bundled into this file except the small amount of glue below: `.wasm`, `.whl` and
 * `.py` are fetched as ordinary resources and never inlined as base64.
 */
import type { AssetsManifest, BakedAsset, BakeProgress, BakeResult, WorkerRequest, WorkerResponse } from './protocol';

/** Vite rewrites this to the deployed base path, so sub-path deployments keep working. */
const BASE = import.meta.env.BASE_URL;

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  try {
    (self as unknown as Worker).postMessage(message, transfer);
  } catch (error) {
    // surface what could not be structured-cloned
    const detail = error instanceof Error ? error.message : String(error);
    throw Error(`postMessage 失败（type=${message.type}，transfer=${transfer.length}）：${detail}`, { cause: error });
  }
}

function progress(phase: BakeProgress['phase'], message: string, ratio: number): void {
  post({ type: 'progress', progress: { phase, message, ratio } });
}

/** Writes one file into the Pyodide virtual filesystem, creating parents as needed. */
function writeFile(
  py: Awaited<ReturnType<(typeof import('pyodide'))['loadPyodide']>>,
  path: string,
  bytes: Uint8Array,
): void {
  const slash = path.lastIndexOf('/');
  if (slash > 0) py.FS.mkdirTree(path.slice(0, slash));
  py.FS.writeFile(path, bytes);
}

async function loadManifest(): Promise<AssetsManifest> {
  const response = await fetch(`${BASE}assets-manifest.json`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`无法读取资源清单（HTTP ${response.status}）`);
  return (await response.json()) as AssetsManifest;
}

/**
 * Downloads every source asset into MEMFS.
 *
 * Runs with a small concurrency window: 1,150 files over a single connection would serialise into
 * minutes of latency, while unbounded fan-out would stall the worker's HTTP queue.
 */
async function stageAssets(
  py: Awaited<ReturnType<(typeof import('pyodide'))['loadPyodide']>>,
  manifest: AssetsManifest,
): Promise<void> {
  const queue = [...manifest.files];
  let loaded = 0;
  let bytes = 0;
  let lastReport = 0;

  const worker = async () => {
    for (;;) {
      const entry = queue.shift();
      if (!entry) return;
      // Sequential per worker on purpose: a fixed number of workers each pull one file at a time, so
      // the browser's connection pool is not swamped by 1,152 concurrent requests.
      // oxlint-disable-next-line no-await-in-loop -- one file at a time per worker (see above)
      const response = await fetch(`${BASE}${entry.url}`);
      if (!response.ok) throw new Error(`缺少资源：${entry.url}（HTTP ${response.status}）`);
      // oxlint-disable-next-line no-await-in-loop -- same sequential queue
      const buffer = new Uint8Array(await response.arrayBuffer());
      writeFile(py, entry.mount, buffer);
      loaded++;
      bytes += buffer.length;
      // Throttle progress messages; one per file would flood the main thread.
      if (loaded - lastReport >= 25 || loaded === manifest.count) {
        lastReport = loaded;
        progress('assets', `正在准备素材 ${loaded} / ${manifest.count}`, loaded / manifest.count);
      }
    }
  };

  await Promise.all(Array.from({ length: 8 }, worker));
  progress('assets', `已加载 ${manifest.count} 个素材（${(bytes / 1048576).toFixed(1)} MiB）`, 1);
}

async function runBake(): Promise<BakeResult> {
  progress('pyodide', '正在加载 Pyodide 运行时…', 0);
  const pyodideModule = await import(/* @vite-ignore */ `${BASE}pyodide/pyodide.mjs`);
  const loadPyodide = pyodideModule.loadPyodide as (typeof import('pyodide'))['loadPyodide'];

  // Resolve everything against an absolute URL. Inside a worker `location` is the worker's own
  // global, so relying on a relative `indexURL` would make Pyodide resolve `new URL(..., location)`
  // against an unexpected base.
  const indexURL = new URL(`${BASE}pyodide/`, self.location.href).href;
  // Reading the lock file ourselves pins package resolution to the self-hosted index: Pyodide
  // derives its package base from `lockFileURL`, so Pillow is never fetched from a CDN.
  const lockFileURL = `${indexURL}pyodide-lock.json`;
  const lockResponse = await fetch(lockFileURL, { cache: 'force-cache' });
  if (!lockResponse.ok) throw Error(`无法读取 Pyodide 锁文件（HTTP ${lockResponse.status}）：${lockFileURL}`);
  const lockFileContents = await lockResponse.json();

  // Passing the already-resolved lock contents plus an absolute `packageBaseUrl` keeps every download
  // (runtime, stdlib and the Pillow wheel) on our own origin.
  const py = await loadPyodide({ indexURL, packageBaseUrl: indexURL, lockFileContents });

  progress('pillow', '正在加载 Pillow（WASM）…', 0);
  try {
    await py.loadPackage('Pillow');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw Error(`Pillow 加载失败（indexURL=${indexURL}）：${detail}`, { cause: error });
  }
  // Verify the install actually resolves before spending minutes composing sprites; a silent partial
  // install shows up much later as a confusing "No module named 'PIL'". `find_spec` is not reliable
  // under Pyodide's package importer, so the module is imported for real.
  const pillow = String(py.runPython("import PIL.Image as _i; getattr(_i, '__name__', 'PIL.Image')"));
  if (!pillow.startsWith('PIL')) throw Error(`Pillow 未正确安装（indexURL=${indexURL}）`);

  const manifest = await loadManifest();
  progress('assets', `正在准备 ${manifest.count} 个素材文件…`, 0);
  await stageAssets(py, manifest);

  // Collection buffers filled by the host callbacks below.
  const pending: BakedAsset[] = [];
  const reports: Record<string, string> = {};

  const host = {
    /**
     * Receives one encoded image from Python.
     *
     * Python `bytes` crosses the FFI boundary as a `PyProxy`, not as a typed array, so it is drained
     * explicitly. Copying out of the WASM heap is required because the view becomes invalid once
     * Python reuses that buffer.
     */
    emitImage(key: string, extension: string, bytes: { toJs(): Uint8Array } | Uint8Array): void {
      const view = bytes instanceof Uint8Array ? bytes : bytes.toJs();
      const copy = new Uint8Array(view.length);
      copy.set(view);
      pending.push({ key, extension: extension === 'webp' ? 'webp' : 'png', bytes: copy.buffer });
    },
    emitJson(name: string, text: string): void {
      reports[name] = text;
    },
    report(stage: string): void {
      progress('bake', `正在合成：${stage}`, 0);
    },
  };
  // The double-underscore name is the FFI convention Python imports from the JS namespace.
  // oxlint-disable-next-line no-underscore-dangle -- see comment above
  (globalThis as unknown as Record<string, unknown>).__endfieldHost = host;

  progress('bake', '正在合成蓝图素材…', 0);
  // `boot` is staged at /bake/python/boot.py. Its directory has to be on `sys.path` explicitly:
  // the worker runs Python through `runPythonAsync`, which has no script directory to add.
  py.runPython("import sys; sys.path.insert(0, '/bake/python')");
  const boot = py.pyimport('boot');
  const payload = boot.run() as string;
  boot.destroy?.();

  progress('done', `已合成 ${pending.length} 张图片`, 1);

  return { payload, reports, assets: pending };
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  if (event.data?.type !== 'bake') return;
  runBake()
    .then(result => {
      // Transfer every image buffer instead of structured-cloning ~2,000 of them.
      const transfer = result.assets.map(asset => asset.bytes);
      const bad = transfer.findIndex(buffer => !(buffer instanceof ArrayBuffer));
      if (bad >= 0) {
        const offender = transfer[bad] as unknown;
        throw Error(`资产 ${bad} 的像素数据不是 ArrayBuffer：${Object.prototype.toString.call(offender)}`);
      }
      post({ type: 'done', result }, transfer);
    })
    .catch((error: unknown) => {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    });
});
