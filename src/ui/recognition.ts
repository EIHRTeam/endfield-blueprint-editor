import { validate } from '../core';
import type { BuildingIndex, Layout } from '../core/types';
import { chooseDesktopFiles, isDesktopHost, saveFile } from './desktopHost';
import type { DesktopFile } from './desktopHost';
import type { Editor } from './editor';
import { createReview } from '../core/review';
import { recognitionFileData, recognitionImageBlob } from './recognitionImage';
import { initRecognitionReview } from './recognitionReview';

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_VIDEO_BYTES = 256 * 1024 * 1024;
const isVideo = (file: Pick<File, 'name'>) => /\.(mp4|mov|webm|mkv)$/i.test(file.name);
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface RecognitionResult {
  layout: Layout;
  document: Record<string, unknown>;
  warnings: string[];
  uncertainLines: { x: number; z: number; kind: 'item' | 'fluid'; reason: string }[];
  inferredLines: number;
  images: number | null;
  preview: string | null;
  coveragePreview: string | null;
  video: { durationSeconds: number | null; sampledFrames: number | null; selectedFrames: number } | null;
}

/** Validate both service envelopes and plain layouts before making an import available. */
export function readRecognitionResult(input: unknown, buildings: BuildingIndex): RecognitionResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('识别结果必须是 JSON 对象');
  const source = input as Record<string, unknown>;
  const layout = validate(Object.hasOwn(source, 'layout') ? source.layout : source, buildings);
  const report = source.report as
    | {
        warnings?: unknown;
        uncertainLines?: unknown;
        summary?: { images?: unknown; inferredLineCells?: unknown };
        video?: { durationSeconds?: unknown; sampledFrames?: unknown; selectedFrames?: unknown };
      }
    | undefined;
  const warnings = Array.isArray(report?.warnings)
    ? report.warnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
  const images = report?.summary?.images;
  const uncertainLines: RecognitionResult['uncertainLines'] = [];
  const inferredCells = new Set<string>();
  if (Array.isArray(report?.uncertainLines)) {
    for (const value of report.uncertainLines) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const line = value as Record<string, unknown>;
      if (
        line.resolved === true &&
        typeof line.x === 'number' &&
        typeof line.z === 'number' &&
        (line.kind === 'item' || line.kind === 'fluid')
      ) {
        inferredCells.add(`${line.kind}:${line.x}:${line.z}`);
      } else if (
        typeof line.x === 'number' &&
        Number.isInteger(line.x) &&
        typeof line.z === 'number' &&
        Number.isInteger(line.z) &&
        (line.kind === 'item' || line.kind === 'fluid')
      ) {
        uncertainLines.push({
          x: line.x,
          z: line.z,
          kind: line.kind,
          reason: typeof line.reason === 'string' ? line.reason : '线路形状或方向需要核对',
        });
      }
    }
  }
  const inferredCount = report?.summary?.inferredLineCells;
  const inferredLines =
    typeof inferredCount === 'number' && Number.isInteger(inferredCount) && inferredCount >= 0
      ? inferredCount
      : inferredCells.size;
  const video = report?.video;
  return {
    layout,
    document: Object.hasOwn(source, 'layout') ? { ...structuredClone(source), layout } : { layout },
    warnings,
    uncertainLines,
    inferredLines,
    images: typeof images === 'number' && Number.isInteger(images) && images >= 0 ? images : null,
    preview: typeof source.preview === 'string' ? source.preview : null,
    coveragePreview: typeof source.coveragePreview === 'string' ? source.coveragePreview : null,
    video:
      video && Array.isArray(video.selectedFrames)
        ? {
            durationSeconds:
              typeof video.durationSeconds === 'number' &&
              Number.isFinite(video.durationSeconds) &&
              video.durationSeconds >= 0
                ? video.durationSeconds
                : null,
            sampledFrames:
              typeof video.sampledFrames === 'number' &&
              Number.isInteger(video.sampledFrames) &&
              video.sampledFrames >= 0
                ? video.sampledFrames
                : null,
            selectedFrames: video.selectedFrames.length,
          }
        : null,
  };
}

export function validateScreenshotFiles(files: Pick<File, 'name' | 'size'>[]): void {
  if (!files.length) throw Error('请选择截图、ZIP 或录屏文件');
  if (files.some(file => file.size === 0)) throw Error('不能识别空文件');
  if (files.some(isVideo)) {
    if (files.length !== 1) throw Error('录屏请单独选择，每次仅支持 1 个视频，不能混入图片或 ZIP');
    if (files[0].size > MAX_VIDEO_BYTES) throw Error('录屏不能超过 256 MiB');
    return;
  }
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_BYTES) throw Error('图片或 ZIP 总计不能超过 64 MiB');
  if (files.some(file => !/\.(png|jpe?g|webp|zip)$/i.test(file.name)))
    throw Error('仅支持 PNG、JPEG、WebP、ZIP 或 MP4、MOV、WebM、MKV 录屏');
  if (files.some(file => /\.zip$/i.test(file.name))) {
    if (files.length !== 1) throw Error('ZIP 请单独选择，每次仅支持 1 个 ZIP');
  } else if (files.length > 16) throw Error('每次最多选择 16 张图片');
}

/** Background recognition job as reported by `GET /api/jobs/{id}`. */
interface RecognitionJob {
  id: string;
  name: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  stage: string;
  progress: number;
  error: string | null;
  elapsedSeconds: number;
}

/** Dispatched on window by the toolbar's 「导入 JSON」 when the file is a recognition result. */
export const RECOGNITION_IMPORT_EVENT = 'blueprint:import-recognition';

const JOB_STORAGE_KEY = 'endfield-blueprint-recognition-job';
const LAUNCHER_LABEL = '截图 / 录屏识别';

function readJob(input: unknown): RecognitionJob | null {
  const job = (input as { job?: unknown } | null)?.job as Partial<RecognitionJob> | undefined;
  if (!job || typeof job.id !== 'string' || !/^[0-9a-f]{32}$/.test(job.id)) return null;
  const status = ['running', 'done', 'error', 'cancelled'].includes(job.status as string) ? job.status! : 'error';
  return {
    id: job.id,
    name: typeof job.name === 'string' ? job.name : '',
    status,
    stage: typeof job.stage === 'string' ? job.stage : '',
    progress:
      typeof job.progress === 'number' && Number.isFinite(job.progress) ? Math.min(1, Math.max(0, job.progress)) : 0,
    error: typeof job.error === 'string' ? job.error : null,
    elapsedSeconds: typeof job.elapsedSeconds === 'number' ? job.elapsedSeconds : 0,
  };
}

function storedJob(): { base: string; id: string } | null {
  try {
    const value = JSON.parse(localStorage.getItem(JOB_STORAGE_KEY) ?? 'null') as {
      base?: unknown;
      id?: unknown;
    } | null;
    return value && typeof value.base === 'string' && typeof value.id === 'string' && /^[0-9a-f]{32}$/.test(value.id)
      ? { base: value.base, id: value.id }
      : null;
  } catch {
    return null;
  }
}

function storeJob(value: { base: string; id: string } | null) {
  try {
    if (value) localStorage.setItem(JOB_STORAGE_KEY, JSON.stringify(value));
    else localStorage.removeItem(JOB_STORAGE_KEY);
  } catch {
    // Private mode or disabled storage: progress still works until the page reloads.
  }
}

/** POST with upload progress; fetch cannot report how much of a large video was sent. */
function upload(
  url: string,
  body: XMLHttpRequestBodyInit,
  contentType: string,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<{ status: number; payload: unknown }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = event => {
      if (event.lengthComputable && event.total) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let payload: unknown = null;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        payload = null;
      }
      resolve({ status: xhr.status, payload });
    };
    xhr.onerror = () => reject(Error('network'));
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

function serviceBase(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value.trim());
  } catch {
    throw Error('请输入完整的识别服务地址，例如 http://127.0.0.1:8765');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw Error('识别服务地址必须是 HTTP 或 HTTPS 地址，且不能包含账号密码');
  }
  return `${endpoint.origin}${endpoint.pathname.replace(/\/$/, '')}/`;
}

function serviceUrl(value: string, video: boolean): string {
  return new URL(video ? 'api/recognize-video' : 'api/recognize', serviceBase(value)).href;
}

/** Lets files be dropped onto the recognition dialog. */
function dragOver(event: Event) {
  if ((event as DragEvent).dataTransfer?.types.includes('Files')) event.preventDefault();
}

/** Keeps recognition asynchronous and reviewable without altering the existing editor import contract. */
export function initRecognition(editor: Editor): () => void {
  const review = initRecognitionReview(editor);
  const dialog = el<HTMLDialogElement>('recognitionDialog');
  const filesInput = el<HTMLInputElement>('recognitionFiles');
  const jsonInput = el<HTMLInputElement>('recognitionJsonFile');
  const runButton = el<HTMLButtonElement>('btnRecognize');
  const importButton = el<HTMLButtonElement>('btnImportRecognition');
  const saveButton = el<HTMLButtonElement>('btnSaveRecognition');
  const jsonButton = el<HTMLButtonElement>('btnOpenRecognitionJson');
  const cancelButton = el<HTMLButtonElement>('btnCancelRecognition');
  const endpoint = el<HTMLInputElement>('recognitionEndpoint');
  const preview = el<HTMLImageElement>('recognitionPreview');
  const coveragePreview = el<HTMLImageElement>('recognitionCoveragePreview');
  const status = el('recognitionStatus');
  const replace = el<HTMLInputElement>('recognitionReplace');
  const launcher = el<HTMLButtonElement>('btnRecognition');
  const progressBox = el('recognitionProgress');
  const progressBar = el<HTMLProgressElement>('recognitionProgressBar');
  const progressText = el('recognitionProgressText');
  const listeners: Array<[EventTarget, string, EventListener]> = [];
  let current: RecognitionResult | null = null;
  let previewUrl: string | null = null;
  let coveragePreviewUrl: string | null = null;
  let pending: AbortController | null = null;
  let revision = 0;
  let disposed = false;
  /** idle | legacy (single blocking request) | upload | job (server-side, pollable). */
  let phase: 'idle' | 'legacy' | 'upload' | 'job' = 'idle';
  let job: { base: string; id: string } | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let tracking = 0;
  /** Hosted by the desktop app: same-origin service, native file dialog. */
  let desktop = false;
  /** Files picked in the desktop app's native dialog; read by the service straight from disk. */
  let picked: DesktopFile[] | null = null;
  const chooseButton = el<HTMLButtonElement>('btnChooseRecognitionFiles');
  const selection = (): Pick<File, 'name' | 'size'>[] => picked ?? Array.from(filesInput.files ?? []);
  const baseUrl = () => (desktop ? `${location.origin}/` : serviceBase(endpoint.value));
  const unreachable = () =>
    desktop
      ? '无法连接本地识别服务，请关闭并重新打开程序。'
      : '无法连接识别服务。请先运行 python scripts/ocr_server.py，并确认服务地址；静态站点也可打开命令行生成的识别 JSON。';

  const on = (id: string, type: string, handler: () => void) => {
    const target = el(id);
    target.addEventListener(type, handler);
    listeners.push([target, type, handler]);
  };
  const message = (text: string, error = false) => {
    status.textContent = text;
    status.classList.toggle('error', error);
  };
  const refreshImport = () => {
    if (!current) return;
    const same = review.isCurrent(current);
    const hasContent = Boolean(editor.data.nodes.length || editor.data.conveyors.length || editor.data.ocrReview);
    el('recognitionReplaceWarning').hidden = !hasContent;
    importButton.disabled = hasContent && !same && !replace.checked;
    importButton.textContent =
      same && !replace.checked
        ? '继续当前对照（保留修改）'
        : hasContent
          ? '替换当前布局（可撤销）'
          : '导入编辑器（可撤销）';
    saveButton.textContent = same ? '下载当前修订及报告' : '下载识别结果 JSON';
  };
  const startReview = (issueId?: string) => {
    if (!current) return;
    refreshImport();
    if (importButton.disabled) {
      message('当前布局已有内容，请先保存修改，再勾选替换；原布局可撤销恢复。', true);
      return;
    }
    try {
      review.open(current, issueId, replace.checked);
      storeJob(null);
      setLauncher();
      replace.checked = false;
      dialog.close();
    } catch (error) {
      message((error as Error).message, true);
    }
  };
  const clearResult = () => {
    current = null;
    el('recognitionResult').hidden = true;
    importButton.disabled = true;
    saveButton.disabled = true;
    preview.hidden = true;
    preview.removeAttribute('src');
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    coveragePreview.removeAttribute('src');
    el('recognitionCoverage').hidden = true;
    if (coveragePreviewUrl) URL.revokeObjectURL(coveragePreviewUrl);
    coveragePreviewUrl = null;
    replace.checked = false;
    el('recognitionReplaceWarning').hidden = true;
  };
  const setBusy = (busy: boolean) => {
    filesInput.disabled = busy;
    chooseButton.disabled = busy;
    endpoint.disabled = busy;
    el<HTMLInputElement>('recognitionWidth').disabled = busy;
    el<HTMLInputElement>('recognitionHeight').disabled = busy;
    jsonButton.disabled = busy;
    runButton.disabled = busy || !selection().length;
    cancelButton.hidden = !busy;
    cancelButton.textContent = phase === 'legacy' ? '停止等待' : '取消识别';
  };
  const showProgress = (fraction: number | null, text: string) => {
    progressBox.hidden = false;
    if (fraction === null) progressBar.removeAttribute('value');
    else progressBar.value = fraction;
    progressText.textContent = text;
  };
  const hideProgress = () => {
    progressBox.hidden = true;
    progressBar.value = 0;
    progressText.textContent = '';
  };
  const setLauncher = (suffix = '') => {
    launcher.textContent = suffix ? `${LAUNCHER_LABEL} · ${suffix}` : LAUNCHER_LABEL;
  };
  const showResult = (input: unknown) => {
    const result = readRecognitionResult(input, editor.buildings);
    clearResult();
    current = result;
    el('recognitionResult').hidden = false;
    el('recognitionSummary').textContent = [
      ...(result.video
        ? [
            result.video.durationSeconds === null
              ? '录屏'
              : `${Number(result.video.durationSeconds.toFixed(1))} 秒录屏`,
            `${result.video.sampledFrames === null ? '' : `采样 ${result.video.sampledFrames} 帧，`}选用 ${result.video.selectedFrames} 帧`,
          ]
        : result.images === null
          ? []
          : [`${result.images} 张截图`]),
      `${result.layout.size.x} × ${result.layout.size.z} 格`,
      `${result.layout.nodes.length} 个设备`,
      `${result.layout.conveyors.length} 段线路`,
      ...(result.inferredLines ? [`${result.inferredLines} 处线路方向由连接关系推断`] : []),
    ].join(' · ');
    const list = el('recognitionWarningList');
    list.replaceChildren();
    for (const warning of result.warnings) {
      const item = document.createElement('li');
      item.textContent = warning;
      list.append(item);
    }
    for (const issue of createReview(result.layout, result.document.report, editor.buildings).issues) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.className = 'recognition-locate';
      button.textContent = `${issue.title}（坐标从 0 开始）：${issue.reason} · 点击定位`;
      button.onclick = () => startReview(issue.id);
      item.append(button);
      list.append(item);
    }
    el('recognitionWarnings').hidden = false;
    if (result.preview) {
      const blob = recognitionImageBlob(result.preview);
      if (blob) {
        previewUrl = URL.createObjectURL(blob);
        preview.src = previewUrl;
        preview.hidden = false;
      }
    }
    if (result.coveragePreview) {
      const blob = recognitionImageBlob(result.coveragePreview);
      if (blob) {
        coveragePreviewUrl = URL.createObjectURL(blob);
        coveragePreview.src = coveragePreviewUrl;
        el('recognitionCoverage').hidden = false;
      }
    }
    importButton.disabled = false;
    saveButton.disabled = false;
    refreshImport();
    message(
      result.warnings.length || result.uncertainLines.length
        ? '结果已就绪，可以直接导入。当前布局尚未修改。'
        : '结果已就绪，可以直接导入。当前布局尚未修改。',
    );
  };
  // A function so TypeScript does not narrow `phase` across awaits.
  const followingJob = () => phase === 'job';
  const stopTracking = () => {
    tracking += 1;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  };
  const cancel = () => {
    revision += 1;
    pending?.abort();
    pending = null;
    stopTracking();
    phase = 'idle';
    setBusy(false);
    hideProgress();
    setLauncher();
  };
  const finishJob = () => {
    stopTracking();
    job = null;
    phase = 'idle';
    setBusy(false);
    hideProgress();
  };
  /** Poll a server-side job; survives closing the dialog, reloads and discarded tabs. */
  const poll = async (token: number, failures = 0): Promise<void> => {
    if (!job || token !== tracking || disposed) return;
    const { base, id } = job;
    const again = (delay: number, nextFailures = 0) => {
      if (token === tracking && !disposed) pollTimer = setTimeout(() => void poll(token, nextFailures), delay);
    };
    let response: Response;
    let payload: unknown;
    try {
      response = await fetch(new URL(`api/jobs/${id}`, base), { cache: 'no-store' });
      payload = await response.json();
    } catch {
      if (token !== tracking || disposed) return;
      showProgress(null, '暂时连不上识别服务，正在重试…（服务窗口不要关闭）');
      again(Math.min(10_000, 2000 * (failures + 1)), failures + 1);
      return;
    }
    if (token !== tracking || disposed) return;
    const state = readJob(payload);
    if (!response.ok || !state) {
      storeJob(null);
      finishJob();
      setLauncher();
      message('识别任务已不存在（识别服务可能已重启），请重新开始识别。', true);
      return;
    }
    if (state.status === 'running') {
      const percent = Math.round(state.progress * 100);
      showProgress(
        state.progress,
        `${state.stage || '识别中'} · ${percent}% · 已用 ${Math.round(state.elapsedSeconds)} 秒`,
      );
      setLauncher(`识别中 ${percent}%`);
      message('正在识别。可以关闭此窗口或切换页面，完成后会保留结果；刷新页面也能继续查看进度。');
      // Background tabs throttle timers anyway; a visible page polls once a second.
      again(document.hidden ? 5000 : 1000);
      return;
    }
    if (state.status === 'done') {
      showProgress(1, '识别完成，正在读取结果…');
      try {
        const result = await fetch(new URL(`api/jobs/${id}/result`, base), { cache: 'no-store' });
        if (!result.ok) throw Error(`HTTP ${result.status}`);
        const body: unknown = await result.json();
        if (token !== tracking || disposed) return;
        finishJob();
        showResult(body);
        setLauncher(dialog.open ? '' : '识别完成，点此导入');
      } catch (error) {
        if (token !== tracking || disposed) return;
        storeJob(null);
        finishJob();
        setLauncher();
        message(`无法读取识别结果：${(error as Error).message}`, true);
      }
      return;
    }
    storeJob(null);
    finishJob();
    setLauncher();
    if (state.status === 'cancelled') message('识别已取消。');
    else message(state.error ?? '识别失败，详细原因见本地服务终端。', true);
  };
  const follow = (base: string, state: RecognitionJob) => {
    stopTracking();
    clearResult();
    job = { base, id: state.id };
    storeJob(job);
    phase = 'job';
    setBusy(true);
    showProgress(state.progress, state.stage || '识别中');
    void poll(tracking);
  };
  const recognize = async () => {
    const files = Array.from(filesInput.files ?? []);
    const chosen = selection();
    const video = chosen.length === 1 && isVideo(chosen[0]);
    let url: string;
    let size: [number, number] | undefined;
    try {
      validateScreenshotFiles(chosen);
      url = desktop
        ? new URL(video ? 'api/recognize-video' : 'api/recognize', baseUrl()).href
        : serviceUrl(endpoint.value, video);
      const width = el<HTMLInputElement>('recognitionWidth').value;
      const height = el<HTMLInputElement>('recognitionHeight').value;
      if (width || height) {
        size = [Number(width), Number(height)];
        if (!width || !height || size.some(value => !Number.isInteger(value) || value < 1 || value > 50))
          throw Error('指定尺寸时，请同时输入 1–50 的整数宽度和高度');
      }
    } catch (error) {
      message((error as Error).message, true);
      return;
    }
    clearResult();
    stopTracking();
    storeJob(null);
    const requestRevision = ++revision;
    const controller = new AbortController();
    pending = controller;
    phase = 'upload';
    setBusy(true);
    message(video ? '正在上传录屏…' : '正在读取截图…');
    showProgress(0, '上传中 0%');
    const base = baseUrl();
    try {
      if (picked) {
        // Desktop app: the service reads the files in place; nothing is uploaded.
        showProgress(null, '正在提交识别任务…');
        let response: Response;
        try {
          response = await fetch(new URL('api/jobs/files', base), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: picked.map(file => file.path), ...(size ? { size } : {}) }),
            signal: controller.signal,
          });
        } catch (error) {
          if (controller.signal.aborted) throw error;
          throw Error(unreachable(), { cause: error });
        }
        const payload: unknown = await response.json().catch(() => null);
        if (requestRevision !== revision || disposed) return;
        const accepted = readJob(payload);
        if ((response.status === 202 || response.status === 429) && accepted) {
          pending = null;
          follow(base, accepted);
          if (response.status === 429) message('已有一项识别正在进行，下面显示的是它的进度。');
          return;
        }
        const detail = (payload as { error?: unknown } | null)?.error;
        throw Error(typeof detail === 'string' ? detail : `识别请求失败（HTTP ${response.status}）`);
      }
      let body: XMLHttpRequestBodyInit;
      let jobUrl: URL;
      if (video) {
        const address = new URL(url);
        address.searchParams.set('name', files[0].name);
        if (size) {
          address.searchParams.set('width', String(size[0]));
          address.searchParams.set('height', String(size[1]));
        }
        url = address.href;
        jobUrl = new URL('api/jobs/video', base);
        jobUrl.search = address.search;
        body = files[0];
      } else {
        const encoded = await Promise.all(
          files.map(async file => ({ name: file.name, data: (await recognitionFileData(file)).split(',')[1] ?? '' })),
        );
        body = JSON.stringify({ files: encoded, ...(size ? { size } : {}) });
        jobUrl = new URL('api/jobs', base);
      }
      if (controller.signal.aborted) return;
      let submitted: { status: number; payload: unknown };
      try {
        submitted = await upload(
          jobUrl.href,
          body,
          video ? 'application/octet-stream' : 'application/json',
          controller.signal,
          fraction => {
            if (requestRevision === revision) showProgress(fraction, `上传中 ${Math.round(fraction * 100)}%`);
          },
        );
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw Error(unreachable(), { cause: error });
      }
      if (requestRevision !== revision || disposed) return;
      const accepted = readJob(submitted.payload);
      if (submitted.status === 202 && accepted) {
        pending = null;
        follow(base, accepted);
        return;
      }
      if (submitted.status === 429 && accepted) {
        pending = null;
        follow(base, accepted);
        message('已有一项识别正在进行，下面显示的是它的进度。');
        return;
      }
      if (submitted.status !== 404 && submitted.status !== 405) {
        const detail = (submitted.payload as { error?: unknown } | null)?.error;
        throw Error(typeof detail === 'string' ? detail : `识别服务请求失败（HTTP ${submitted.status}）`);
      }
      // Older services without background jobs: one blocking request, no progress.
      phase = 'legacy';
      setBusy(true);
      showProgress(null, '旧版识别服务不提供进度；处理可能需要几分钟…');
      message(
        video ? '正在上传录屏并自动选帧识别；处理可能需要几分钟…' : '正在读取截图并识别；多图拼接可能需要几分钟…',
      );
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': video ? 'application/octet-stream' : 'application/json' },
          body: body as BodyInit,
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw Error(unreachable(), { cause: error });
      }
      const payload: unknown = await response.json().catch(() => {
        throw Error(`识别服务返回了无法读取的结果（HTTP ${response.status}）`);
      });
      if (!response.ok) {
        const detail = (payload as { error?: unknown } | null)?.error;
        throw Error(typeof detail === 'string' ? detail : `识别服务请求失败（HTTP ${response.status}）`);
      }
      if (requestRevision === revision && !disposed) showResult(payload);
    } catch (error) {
      if (requestRevision === revision && !disposed && !controller.signal.aborted)
        message((error as Error).message, true);
    } finally {
      if (requestRevision === revision && !disposed && !followingJob()) {
        pending = null;
        phase = 'idle';
        setBusy(false);
        hideProgress();
      }
    }
  };

  on('btnRecognition', 'click', () => {
    refreshImport();
    if (phase !== 'job') setLauncher();
    dialog.showModal();
  });
  on('btnCloseRecognition', 'click', () => dialog.close());
  on('recognitionDialog', 'close', () => {
    // Background jobs and uploads keep running; only the old blocking request is abandoned.
    if (pending && phase === 'legacy') {
      cancel();
      message('已停止等待，识别服务可能仍在运行。可以重新开始。');
    }
  });
  const selectionChanged = () => {
    clearResult();
    storeJob(null);
    revision += 1;
    const files = selection();
    el('recognitionFileList').textContent = files.length
      ? files.map(file => file.name).join('、')
      : '尚未选择截图或录屏';
    runButton.disabled = true;
    try {
      validateScreenshotFiles(files);
      runButton.disabled = false;
      message(`${files.length === 1 && isVideo(files[0]) ? '录屏' : '截图'}已选择，点击「开始识别」。`);
    } catch (error) {
      message((error as Error).message, Boolean(files.length));
    }
  };
  on('recognitionFiles', 'change', () => {
    picked = null;
    selectionChanged();
  });
  on('btnChooseRecognitionFiles', 'click', () => {
    chooseButton.disabled = true;
    void chooseDesktopFiles()
      .then(files => {
        if (!files || disposed) return;
        picked = files;
        filesInput.value = '';
        selectionChanged();
      })
      .catch(error => message((error as Error).message, true))
      .finally(() => {
        chooseButton.disabled = phase !== 'idle';
      });
  });
  // Drop screenshots or a recording anywhere on the dialog.
  const drop = (event: Event) => {
    const files = (event as DragEvent).dataTransfer?.files;
    if (!files?.length) return;
    event.preventDefault();
    if (phase !== 'idle') {
      message('正在识别，请等这次识别结束或取消后再拖入文件。', true);
      return;
    }
    filesInput.files = files;
    picked = null;
    selectionChanged();
  };
  dialog.addEventListener('dragover', dragOver);
  dialog.addEventListener('drop', drop);
  listeners.push([dialog, 'dragover', dragOver], [dialog, 'drop', drop]);
  on('btnRecognize', 'click', () => void recognize());
  on('btnCancelRecognition', 'click', () => {
    if (phase === 'job' && job) {
      const { base, id } = job;
      cancelButton.disabled = true;
      message('正在取消识别…');
      void fetch(new URL(`api/jobs/${id}`, base), { method: 'DELETE' })
        .catch(() => {
          // Service unreachable: stop following locally.
          storeJob(null);
          finishJob();
          setLauncher();
          message('无法连接识别服务，已停止跟踪这次识别。', true);
        })
        .finally(() => {
          cancelButton.disabled = false;
        });
      return;
    }
    const legacy = phase === 'legacy';
    cancel();
    message(legacy ? '已停止等待，识别服务可能仍在运行。可以重新开始。' : '已取消上传。');
  });
  on('btnOpenRecognitionJson', 'click', () => jsonInput.click());
  on('recognitionJsonFile', 'change', () => {
    const file = jsonInput.files?.[0];
    jsonInput.value = '';
    if (!file) return;
    clearResult();
    storeJob(null);
    const requestRevision = ++revision;
    if (file.size > MAX_BYTES) {
      message('识别 JSON 不能超过 64 MiB', true);
      return;
    }
    message('正在读取识别 JSON…');
    void file
      .text()
      .then(text => {
        if (requestRevision === revision && !disposed) showResult(JSON.parse(text));
      })
      .catch(error => {
        if (requestRevision === revision && !disposed) message(`无法打开识别 JSON：${(error as Error).message}`, true);
      });
  });
  on('recognitionReplace', 'change', refreshImport);
  on('btnImportRecognition', 'click', () => startReview());
  on('btnSaveRecognition', 'click', () => {
    if (!current) return;
    const saved = review.isCurrent(current) ? review.document() : null;
    const blob = new Blob([`${JSON.stringify(saved ?? current.document, null, 2)}\n`], { type: 'application/json' });
    void saveFile(blob, `${current.layout.name.replace(/[\\/:*?"<>|]/g, '_') || '截图识别'}_识别结果.json`).then(
      outcome => {
        if (outcome.path) message(`识别结果已保存到 ${outcome.path}`);
      },
      (error: Error) => message(`保存失败：${error.message}`, true),
    );
  });

  // Toolbar 「导入 JSON」 with a recognition result: one click, replacing the
  // layout like any JSON import (undoable) and opening the review panel.
  const importFromToolbar = (event: Event) => {
    try {
      showResult((event as CustomEvent<unknown>).detail);
    } catch (error) {
      editor.message(`导入失败：${(error as Error).message}`, true);
      return;
    }
    if (!current) return;
    try {
      review.open(current, undefined, !review.isCurrent(current));
      editor.message(
        `已导入识别结果：${current.layout.nodes.length} 个设备 / ${current.layout.conveyors.length} 段线路；右侧可对照原图（可撤销）`,
      );
    } catch (error) {
      editor.message(`导入失败：${(error as Error).message}`, true);
    }
  };
  window.addEventListener(RECOGNITION_IMPORT_EVENT, importFromToolbar);
  listeners.push([window, RECOGNITION_IMPORT_EVENT, importFromToolbar]);
  const resume = () => {
    // Returning to a throttled background tab: refresh progress immediately.
    if (!document.hidden && phase === 'job' && job) {
      stopTracking();
      void poll(tracking);
    }
  };
  document.addEventListener('visibilitychange', resume);
  listeners.push([document, 'visibilitychange', resume]);
  const unsubscribe = editor.subscribeDocument(refreshImport);
  void isDesktopHost().then(yes => {
    if (disposed || !yes) return;
    desktop = true;
    el('recognitionService').hidden = true;
    el('recognitionFilesLabel').hidden = true;
    chooseButton.hidden = false;
    el('recognitionDropHint').hidden = false;
  });
  // Reattach to a recognition started before a reload or tab discard.
  const saved = storedJob();
  if (saved) {
    job = saved;
    phase = 'job';
    setBusy(true);
    showProgress(null, '正在连接识别任务…');
    void poll(tracking);
    if (!dialog.open) dialog.showModal();
  }
  return () => {
    disposed = true;
    // Leave a server-side job running; a later page can reattach to it.
    stopTracking();
    cancel();
    clearResult();
    unsubscribe();
    review.destroy();
    for (const [target, type, handler] of listeners) target.removeEventListener(type, handler);
  };
}
