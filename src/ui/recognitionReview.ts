import { createReview } from '../core/review';
import type { Layout, OcrReview, OcrReviewIssue } from '../core/types';
import { saveFile } from './desktopHost';
import type { Editor } from './editor';
import { recognitionFileData, recognitionImageBlob } from './recognitionImage';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface ReviewSource {
  layout: Layout;
  document: Record<string, unknown>;
  preview: string | null;
  coveragePreview: string | null;
}

export interface ReviewController {
  isCurrent: (source: ReviewSource) => boolean;
  open: (source: ReviewSource, issueId?: string, replace?: boolean) => void;
  document: () => Record<string, unknown> | null;
  focus: (id: string) => void;
  destroy: () => void;
}

export function initRecognitionReview(editor: Editor): ReviewController {
  const panel = el('recognitionReviewPanel');
  const mode = el<HTMLSelectElement>('reviewOverlayMode');
  const opacity = el<HTMLInputElement>('reviewOpacity');
  const fileInput = el<HTMLInputElement>('reviewImageFile');
  const listeners: Array<[EventTarget, string, EventListener]> = [];
  let focusedId = '';
  /** Places already looked at in this session; only colours the list, nothing to tick off. */
  const visited = new Set<string>();
  let displayedSourceId = '';
  let sourceDocument: { id: string; value: Record<string, unknown> } | null = null;
  type ReviewImage = { id: string; image: HTMLImageElement; data: string; url: string };
  let reference: ReviewImage | null = null;
  let coverage: ReviewImage | null = null;
  const imageRevision = { reference: 0, coverage: 0 };
  let disposed = false;

  const on = (id: string, type: string, listener: () => void) => {
    const node = el(id);
    node.addEventListener(type, listener);
    listeners.push([node, type, listener]);
  };
  const metadata = () => editor.data.ocrReview;
  /**
   * Always derived from the saved evidence rather than the stored list, so drafts saved by older
   * versions (which listed every runner-up) show the same short list as a fresh import.
   */
  let derived: { state: OcrReview; issues: OcrReviewIssue[] } | null = null;
  const issuesOf = (state: OcrReview): OcrReviewIssue[] => {
    if (derived?.state !== state) {
      let issues = state.issues;
      try {
        issues = createReview(state.originalLayout, state.report, editor.buildings).issues;
      } catch {
        // Keep the stored list if the evidence no longer matches the building table.
      }
      derived = { state, issues };
    }
    return derived.issues;
  };
  const reportMessage = (text: string, error = false) => {
    el('reviewMessage').textContent = text;
    el('reviewMessage').classList.toggle('error', error);
  };
  const syncReference = () => {
    const available = reference?.id === metadata()?.sourceId;
    const coverageAvailable = coverage?.id === metadata()?.sourceId;
    mode.disabled = !available && !coverageAvailable;
    for (const option of mode.options) {
      option.disabled = option.value === 'coverage' ? !coverageAvailable : option.value !== 'layout' && !available;
    }
    if (
      (available || coverageAvailable) &&
      ((mode.value === 'coverage' && !coverageAvailable) ||
        (['reference', 'overlay'].includes(mode.value) && !available))
    )
      mode.value = available ? 'overlay' : 'coverage';
    opacity.disabled = !available || mode.value !== 'overlay';
    el('reviewCoverageLegend').hidden = mode.value !== 'coverage' || !coverageAvailable;
    el('reviewImageStatus').textContent = available
      ? '对照图已按蓝图格子对齐；仅用于核对，不进入导出图片。'
      : '没有对照图；可重新打开含预览的识别结果，或选择输出中的 mosaic.png。';
  };

  const focus = (id: string) => {
    const state = metadata();
    const issue = (state ? issuesOf(state) : []).find(item => item.id === id);
    if (!state || !issue) return;
    focusedId = id;
    visited.add(id);
    editor.focusBounds(issue.bounds);
    el('reviewCurrent').textContent = `${issue.title}：${issue.reason}`;
    for (const button of el('reviewIssues').querySelectorAll<HTMLButtonElement>('button')) {
      const selected = button.dataset.reviewId === id;
      button.classList.toggle('active', selected);
      button.classList.toggle('done', visited.has(button.dataset.reviewId ?? ''));
      button.setAttribute('aria-pressed', String(selected));
      if (selected) button.scrollIntoView({ block: 'nearest' });
    }
    if (innerWidth <= 860) document.body.classList.remove('inspect-open');
    editor.canvas?.focus();
  };

  const sync = () => {
    const state = metadata();
    panel.hidden = !state;
    if (!state) {
      displayedSourceId = '';
      focusedId = '';
      editor.requestDraw();
      return;
    }
    if (displayedSourceId !== state.sourceId) {
      displayedSourceId = state.sourceId;
      focusedId = '';
      visited.clear();
      el('reviewCurrent').textContent = '';
      reportMessage('点击条目定位到画布；直接在画布上修改即可，不需要逐项确认。');
    }
    el('reviewProgress').textContent = issuesOf(state).length
      ? `有 ${issuesOf(state).length} 处识别得不太确定，建议看一下`
      : '没有识别得不确定的地方，可对照原图整体看一遍。';
    const list = el('reviewIssues');
    list.replaceChildren();
    for (const issue of issuesOf(state)) {
      const button = document.createElement('button');
      button.dataset.reviewId = issue.id;
      button.classList.toggle('active', issue.id === focusedId);
      button.classList.toggle('done', visited.has(issue.id));
      button.setAttribute('aria-pressed', String(issue.id === focusedId));
      button.textContent = issue.title;
      button.title = issue.reason;
      button.onclick = () => focus(issue.id);
      list.append(button);
    }
    list.hidden = !issuesOf(state).length;
    el<HTMLButtonElement>('btnReviewNext').hidden = !issuesOf(state).length;
    syncReference();
    editor.requestDraw();
  };

  const setReference = async (data: string, id: string, kind: 'reference' | 'coverage' = 'reference') => {
    const request = ++imageRevision[kind];
    const blob = recognitionImageBlob(data);
    if (!blob) throw Error('对照图必须是有效的 PNG、JPEG 或 WebP 图片');
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
      if (disposed || request !== imageRevision[kind] || metadata()?.sourceId !== id) {
        URL.revokeObjectURL(url);
        return;
      }
      const state = metadata()!;
      const expected = state.originalLayout.size.x / state.originalLayout.size.z;
      if (Math.abs(image.naturalWidth / image.naturalHeight - expected) > expected * 0.02)
        throw Error('图片比例与蓝图不符。请选择识别输出的完整 mosaic.png；单张局部截图尚不能直接对齐。');
      const previous = kind === 'reference' ? reference : coverage;
      if (previous) URL.revokeObjectURL(previous.url);
      const next = { id, image, data, url };
      if (kind === 'reference') reference = next;
      else coverage = next;
      syncReference();
      editor.requestDraw();
      reportMessage(
        kind === 'reference' ? '已加载拼接原图，可切换对照方式或调整透明度。' : '已加载覆盖图，可查看尚未拍到的区域。',
      );
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  };

  const savedDocument = (): Record<string, unknown> | null => {
    const state = metadata();
    if (!state) return null;
    const base = sourceDocument?.id === state.sourceId ? sourceDocument.value : {};
    const output: Record<string, unknown> = {
      ...structuredClone(base),
      layout: structuredClone(editor.data),
      report: structuredClone(state.report),
      originalLayout: structuredClone(state.originalLayout),
    };
    if (reference?.id === state.sourceId) output.preview = reference.data;
    else delete output.preview;
    if (coverage?.id === state.sourceId) output.coveragePreview = coverage.data;
    return output;
  };

  const unsubscribe = editor.subscribeDocument(sync);
  const removeOverlay = editor.addCanvasOverlay((ctx, view) => {
    const state = metadata();
    if (!state) return;
    const activeImage =
      mode.value === 'coverage' ? coverage : ['reference', 'overlay'].includes(mode.value) ? reference : null;
    if (activeImage?.id === state.sourceId) {
      ctx.globalAlpha = mode.value === 'overlay' ? Number(opacity.value) / 100 : 1;
      ctx.drawImage(
        activeImage.image,
        view.ox,
        view.oy,
        state.originalLayout.size.x * view.s,
        state.originalLayout.size.z * view.s,
      );
      ctx.globalAlpha = 1;
    }
    const issue = issuesOf(state).find(item => item.id === focusedId);
    if (issue) {
      const b = issue.bounds;
      ctx.fillStyle = '#ffab2633';
      ctx.strokeStyle = '#d87900';
      ctx.lineWidth = 3;
      ctx.fillRect(view.ox + b.x0 * view.s, view.oy + b.z0 * view.s, (b.x1 - b.x0) * view.s, (b.z1 - b.z0) * view.s);
      ctx.strokeRect(view.ox + b.x0 * view.s, view.oy + b.z0 * view.s, (b.x1 - b.x0) * view.s, (b.z1 - b.z0) * view.s);
    }
  });
  on('reviewOverlayMode', 'change', () => {
    syncReference();
    editor.requestDraw();
  });
  on('reviewOpacity', 'input', () => editor.requestDraw());
  on('btnReviewNext', 'click', () => {
    const state = metadata();
    if (!state) return;
    if (!issuesOf(state).length) return;
    const index = issuesOf(state).findIndex(issue => issue.id === focusedId);
    focus(issuesOf(state)[(index + 1) % issuesOf(state).length].id);
  });
  on('btnReviewClose', 'click', () => {
    if (!metadata()) return;
    editor.transact(draft => {
      delete draft.ocrReview;
    }, '已关闭识别对照，可撤销');
  });
  on('btnReviewImage', 'click', () => fileInput.click());
  on('reviewImageFile', 'change', () => {
    const file = fileInput.files?.[0];
    const id = metadata()?.sourceId;
    fileInput.value = '';
    if (!file || !id) return;
    if (file.size > 64 * 1024 * 1024) {
      reportMessage('对照图不能超过 64 MiB', true);
      return;
    }
    void recognitionFileData(file)
      .then(data => setReference(data, id))
      .catch(error => reportMessage((error as Error).message, true));
  });
  on('btnSaveReview', 'click', () => {
    const data = savedDocument();
    if (!data) return;
    void saveFile(
      new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' }),
      `${editor.data.name.replace(/[\\/:*?"<>|]/g, '_') || '蓝图'}_识别结果.json`,
    ).then(
      outcome => {
        if (!outcome.cancelled)
          reportMessage(`已保存当前布局和原始识别证据${outcome.path ? `：${outcome.path}` : '。'}`);
      },
      (error: Error) => reportMessage(`保存失败：${error.message}`, true),
    );
  });
  sync();

  return {
    isCurrent: source =>
      metadata()?.sourceId === createReview(source.layout, source.document.report, editor.buildings).sourceId,
    open: (source, issueId, replace = false) => {
      const state = createReview(source.layout, source.document.report, editor.buildings);
      if (replace || metadata()?.sourceId !== state.sourceId) {
        editor.importLayout({ ...source.layout, ocrReview: state });
        focusedId = '';
      }
      sourceDocument = { id: state.sourceId, value: structuredClone(source.document) };
      if (source.preview && reference?.id !== state.sourceId) {
        void setReference(source.preview, state.sourceId).catch(error => reportMessage((error as Error).message, true));
      }
      if (source.coveragePreview && coverage?.id !== state.sourceId) {
        void setReference(source.coveragePreview, state.sourceId, 'coverage').catch(error =>
          reportMessage((error as Error).message, true),
        );
      }
      sync();
      if (issueId) focus(issueId);
      else if (issuesOf(state).length) focus(issuesOf(state)[0].id);
      if (innerWidth <= 860 && !issueId) document.body.classList.add('inspect-open');
    },
    document: savedDocument,
    focus,
    destroy: () => {
      disposed = true;
      imageRevision.reference += 1;
      imageRevision.coverage += 1;
      unsubscribe();
      removeOverlay();
      if (reference) URL.revokeObjectURL(reference.url);
      if (coverage) URL.revokeObjectURL(coverage.url);
      for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
    },
  };
}
