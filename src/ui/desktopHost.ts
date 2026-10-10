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
