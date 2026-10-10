/**
 * Bridge to the Windows desktop app (desktop/app.py), which serves this page and
 * the recognition API from one local origin and adds native file dialogs.
 * In the browser (or the web edition) every helper falls back to plain web behaviour.
 */

export interface DesktopFile {
  path: string;
  name: string;
  size: number;
}

export interface SaveOutcome {
  /** Full path chosen in the native save dialog (desktop app only). */
  path?: string;
  cancelled?: boolean;
}

let probe: Promise<boolean> | null = null;

/** True when the page is hosted by the desktop app. Cached after the first call. */
export function isDesktopHost(): Promise<boolean> {
  if (!DESKTOP_EDITION || !/^https?:$/.test(location.protocol)) return Promise.resolve(false);
  probe ??= fetch('/health', { cache: 'no-store' })
    .then(response => (response.ok ? response.json() : null))
    .then((body: { desktop?: unknown } | null) => body?.desktop === true)
    .catch(() => false);
  return probe;
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', ...init });
  const body = (await response.json().catch(() => null)) as (T & { error?: unknown }) | null;
  if (!response.ok || !body) {
    const detail = body?.error;
    throw Error(typeof detail === 'string' ? detail : `桌面程序请求失败（HTTP ${response.status}）`);
  }
  return body;
}

/** Native multi-file open dialog; null when cancelled. */
export async function chooseDesktopFiles(): Promise<DesktopFile[] | null> {
  const body = await call<{ files?: DesktopFile[]; cancelled?: boolean }>('/api/desktop/choose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  return body.files?.length ? body.files : null;
}

function anchorDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Save a file: native save dialog in the desktop app, a browser download elsewhere. */
export async function saveFile(blob: Blob, name: string): Promise<SaveOutcome> {
  // The web edition downloads synchronously, inside the click's user activation.
  if (!DESKTOP_EDITION || !(await isDesktopHost())) {
    anchorDownload(blob, name);
    return {};
  }
  return call<SaveOutcome>(`/api/desktop/save?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: blob,
  });
}

/** Sends one diagnostic line to the app's log, so a broken page can be diagnosed from app.log. */
export function reportToAppLog(message: string): void {
  void call('/api/desktop/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: message.slice(0, 2000) }),
  }).catch(() => undefined);
}

/**
 * Records image load failures in the app log.
 *
 * A broken `<img>` with an empty or undecodable source produces no HTTP request, so it leaves no
 * trace in the server log; without this the only evidence is a screenshot.
 */
export function installAssetDiagnostics(): void {
  if (!DESKTOP_EDITION) return;
  const failures = new Set<string>();
  let reported = 0;
  document.addEventListener(
    'error',
    event => {
      const target = event.target as HTMLElement | null;
      if (!(target instanceof HTMLImageElement)) return;
      const source = target.currentSrc || target.src || '(空 src)';
      failures.add(`${target.id || target.className || 'img'} <- ${source}`);
      if (reported >= 20) return;
      reported += 1;
      reportToAppLog(`图片加载失败：${target.id || target.className || 'img'} <- ${source}`);
    },
    true,
  );
  window.addEventListener('load', () => {
    // Loaded lazily, so report the tally once boot has finished.
    setTimeout(() => {
      const broken = [...document.images].filter(image => image.complete && image.naturalWidth === 0).length;
      reportToAppLog(
        `素材自检：图片元素 ${document.images.length} 个，加载失败 ${broken} 个，失败种类 ${failures.size} 种`,
      );
    }, 3000);
  });
}
