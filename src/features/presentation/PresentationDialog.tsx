/**
 * Blueprint preview dialog.
 *
 * A lazy chunk: the sheet preview only becomes relevant once the user opens it. Edits are held in a
 * local draft and only committed to the document when applied, so cancelling never changes anything.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bounds, clone, undergroundRole } from '../../core';
import type { Layout, PresentationDetails } from '../../core/types';
import { useEditorStore } from '../../app/store';
import { useScene } from '../../app/SceneContext';
import { COVER_COLORS, detailsOf, parseTags } from './details';
import {
  connectionOptions,
  exportPresentation,
  metrics,
  paintPresentation,
  viewportTransform,
} from './paintPresentation';

const RESOLUTIONS = [1920, 2560, 3840];

/** Clamps a normalised viewport value. */
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export interface PresentationDialogProps {
  onClose: () => void;
  onExport: (resolution: number) => Promise<HTMLCanvasElement>;
}

export default function PresentationDialog({ onClose, onExport }: PresentationDialogProps) {
  const store = useEditorStore();
  const scene = useScene();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [draft, setDraft] = useState<Layout>(() => clone(store.data));
  const [details, setDetails] = useState<PresentationDetails>(() => detailsOf(store.data));
  const [resolution, setResolution] = useState(2560);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('修改会实时预览；应用后随蓝图 JSON 和本机草稿保存。');
  const [coverOpen, setCoverOpen] = useState(false);
  const [coverSearch, setCoverSearch] = useState('');
  const [coverScope, setCoverScope] = useState('all');
  const [coverLimit, setCoverLimit] = useState(60);
  const [busy, setBusy] = useState(false);
  const pan = useRef<{
    startX: number;
    startY: number;
    viewport: PresentationDetails['viewport'];
    axis: 'x' | 'y' | null;
    transform: ReturnType<typeof viewportTransform>;
  } | null>(null);

  /** The layout as the preview sees it: document content plus the pending detail edits. */
  const preview = useMemo<Layout>(() => ({ ...draft, presentation: details }), [draft, details]);

  /**
   * Latest preview, read by `render` so the callback itself can stay referentially stable.
   *
   * A changing `render` identity would make the debounce effect re-run on every paint, and its cleanup
   * would cancel the pending timer before it ever fired — the preview would never render at all.
   */
  const previewRef = useRef(preview);
  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);
  const revisionRef = useRef(0);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const layout = previewRef.current;
    try {
      const m = metrics(scene, layout);
      canvas.width = 1920;
      canvas.height = Math.round((m.height * 1920) / 2560);
      const c = canvas.getContext('2d')!;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.scale(1920 / 2560, 1920 / 2560);
      paintPresentation(c, scene, layout, m);
      // Marks a completed render so the UI (and the acceptance suite) can tell a finished preview
      // apart from the canvas element that exists before the first paint.
      revisionRef.current += 1;
      canvas.dataset.revision = String(revisionRef.current);
      const b = bounds(layout, Object.fromEntries(scene.payload.buildings.map(entry => [entry.id, entry])), 0);
      setMessage(
        m.height > 1080
          ? '设备或文字较多，预览已自动加高，完整保留全部内容。'
          : `尺寸 ${b.x1 - b.x0}×${b.z1 - b.z0} · ${m.items.length} 类设备 / 线路`,
      );
      setError('');
    } catch (thrown) {
      const failure = thrown as Error;
      // Surface the stack too: a silent preview failure is otherwise very hard to diagnose, because
      // the canvas simply stays blank.
      console.error('presentation render failed', failure.stack ?? failure.message);
      setError(failure.message);
    }
  }, [scene]);

  useEffect(() => {
    // `render` reads the current preview through `previewRef`, so `preview` itself is not needed here;
    // it is listed only to re-arm the debounce when the preview changes.
    const timer = setTimeout(render, 80);
    return () => clearTimeout(timer);
  }, [render, preview]);

  const patch = <K extends keyof PresentationDetails>(key: K, value: PresentationDetails[K]) => {
    setDetails(previous => ({ ...previous, [key]: value }));
  };

  const apply = useCallback(() => {
    try {
      const before = store.data;
      const next = clone(before);
      next.presentation = { ...details, tags: details.tags.slice(0, 6) };
      store.commitExternal(before, next, '蓝图详情已保存');
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }, [details, store]);

  const connections = useMemo(() => connectionOptions(draft), [draft]);
  const cover = scene.presentation.covers[details.coverId] ?? scene.presentation.covers['']!;
  const covers = useMemo(() => {
    const needle = coverSearch.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return Object.entries(scene.presentation.covers)
      .filter(
        ([id, row]) =>
          (coverScope === 'all' || row.kind === coverScope) &&
          needle.every(part => `${id} ${row.name}`.toLowerCase().includes(part)),
      )
      .slice(0, coverLimit);
  }, [coverSearch, coverScope, coverLimit, scene.presentation.covers]);

  const suggestions = useMemo(() => {
    const preferred = ['装备', '武陵', '四号谷地'];
    return [
      ...new Set([...preferred.filter(tag => scene.presentation.tags.includes(tag)), ...scene.presentation.tags]),
    ].slice(0, 12);
  }, [scene.presentation.tags]);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const box = canvas.getBoundingClientRect();
    const k = 2560 / box.width;
    const q = { x: (event.clientX - box.left) * k, y: (event.clientY - box.top) * k };
    if (q.x > 1900 || q.y < 116) return;
    const m = metrics(scene, preview);
    const transform = viewportTransform(preview, m, scene);
    pan.current = {
      startX: event.clientX,
      startY: event.clientY,
      viewport: { ...details.viewport },
      axis: q.y > m.height - 100 ? 'x' : q.x > 1876 ? 'y' : null,
      transform,
    };
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = 'grabbing';
    event.preventDefault();
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const current = pan.current;
    if (!current) return;
    const { transform } = current;
    const next = { ...details.viewport };
    if (transform.overflowX && current.axis !== 'y') {
      next.x = clamp01(current.viewport.x - (event.clientX - current.startX) / transform.overflowX);
    }
    if (transform.overflowY && current.axis !== 'x') {
      next.y = clamp01(current.viewport.y - (event.clientY - current.startY) / transform.overflowY);
    }
    patch('viewport', next);
  };

  const endPan = (event: React.PointerEvent<HTMLCanvasElement>) => {
    pan.current = null;
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.style.cursor = '';
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    }
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const box = canvas.getBoundingClientRect();
    const k = 2560 / box.width;
    const q = { x: (event.clientX - box.left) * k, y: (event.clientY - box.top) * k };
    if (q.x > 1900 || q.y < 116) return;
    event.preventDefault();
    const next = { ...details.viewport };
    next.zoom = Math.max(1, Math.min(4, next.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1)));
    // Re-anchor so the cell under the cursor stays put.
    const m = metrics(scene, preview);
    const after = viewportTransform({ ...preview, presentation: { ...details, viewport: next } }, m, scene);
    if (after.overflowX) next.x = Math.max(0, Math.min(1, 0.5));
    if (after.overflowY) next.y = Math.max(0, Math.min(1, 0.5));
    patch('viewport', next);
  };

  const doExport = async () => {
    if (!apply()) return;
    setBusy(true);
    setError('');
    try {
      const canvas = await onExport(resolution);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw Error('PNG 编码失败');
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const safe = (preview.name || 'blueprint').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
      anchor.href = url;
      anchor.download = `${safe}_蓝图预览.png`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(`完整预览已导出：${canvas.width}×${canvas.height}，详情也已保存。`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog id="presentationDialog" aria-labelledby="presentationTitle" open>
      <div className="presentation-head">
        <h2 id="presentationTitle">蓝图预览 · 编辑右侧详情</h2>
        <select
          id="presentationResolution"
          aria-label="完整预览分辨率"
          value={resolution}
          onChange={event => setResolution(Number(event.target.value))}
        >
          {RESOLUTIONS.map(value => (
            <option key={value} value={value}>
              {value} px 宽
            </option>
          ))}
        </select>
        <button id="btnExportPresentation" disabled={busy} onClick={() => void doExport()}>
          导出完整预览 PNG
        </button>
        <button
          id="btnApplyPresentation"
          onClick={() => {
            if (apply()) onClose();
          }}
        >
          应用并返回画布
        </button>
      </div>
      <div className="presentation-body">
        <div className="presentation-settings">
          <label>
            蓝图名称
            <input
              id="presentationName"
              maxLength={120}
              autoComplete="off"
              value={draft.name}
              onChange={event => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label>
            创作者 ID
            <input
              id="presentationCreator"
              maxLength={40}
              placeholder="填写要展示的 ID"
              autoComplete="off"
              value={details.creatorId}
              onChange={event => patch('creatorId', event.target.value)}
            />
          </label>
          <label>
            标签
            <input
              id="presentationTags"
              placeholder="例如：装备，武陵"
              autoComplete="off"
              value={details.tags.join('，')}
              onChange={event => patch('tags', parseTags(event.target.value))}
            />
            <span className="muted">用逗号分隔，最多 6 个。</span>
          </label>
          <div id="tagSuggestions" aria-label="原版常用标签">
            {suggestions.map(tag => (
              <button
                key={tag}
                onClick={() => {
                  const tags = details.tags.includes(tag)
                    ? details.tags.filter(value => value !== tag)
                    : [...details.tags, tag];
                  patch('tags', tags);
                }}
              >
                {tag}
              </button>
            ))}
          </div>
          <label>
            蓝图描述（选填）
            <textarea
              id="presentationDescription"
              maxLength={400}
              placeholder="留空时不占用预览空间"
              value={details.description}
              onChange={event => patch('description', event.target.value)}
            />
          </label>
          <span className="field-label">蓝图封面</span>
          <button id="btnChooseCover" className="presentation-cover" onClick={() => setCoverOpen(value => !value)}>
            <img id="presentationCoverThumb" alt="封面物品" src={scene.assets.urlsFor(cover.asset)} />
            <span>
              <b id="presentationCoverName">{cover.name}</b>
              <small>搜索 / 更换封面图标</small>
            </span>
          </button>
          {coverOpen && (
            <div id="coverPicker">
              <input
                id="coverSearch"
                type="search"
                aria-label="搜索封面图标"
                placeholder="搜索物品或设备名称 / ID"
                value={coverSearch}
                onChange={event => {
                  setCoverSearch(event.target.value);
                  setCoverLimit(60);
                }}
              />
              <select
                id="coverScope"
                aria-label="封面图标分类"
                value={coverScope}
                onChange={event => {
                  setCoverScope(event.target.value);
                  setCoverLimit(60);
                }}
              >
                <option value="all">全部原图</option>
                <option value="device">设备</option>
                <option value="product">物品</option>
              </select>
              <div id="coverResults" className="cover-grid">
                {covers.map(([id, row]) => (
                  <button
                    key={id}
                    className="cover-choice"
                    data-cover={id}
                    title={`${row.name}${id ? ` · ${id}` : ''}`}
                    aria-pressed={id === details.coverId}
                    onClick={() => {
                      patch('coverId', id);
                      setCoverOpen(false);
                    }}
                  >
                    <img src={scene.assets.urlsFor(row.asset)} alt="" loading="lazy" />
                    <span>{row.name}</span>
                  </button>
                ))}
                {!covers.length && <p className="muted">没有匹配的封面图标</p>}
              </div>
              <button
                id="btnMoreCovers"
                hidden={covers.length < coverLimit}
                onClick={() => setCoverLimit(value => value + 60)}
              >
                显示更多
              </button>
            </div>
          )}
          <span className="field-label">封面图纸底色</span>
          <div id="presentationColors" className="presentation-colors" aria-label="封面图纸底色">
            {Object.entries(COVER_COLORS).map(([id, value]) => (
              <button
                key={id}
                data-cover-color={id}
                title={value.label}
                aria-label={value.label}
                aria-pressed={id === details.coverColor}
                style={{ ['--color' as string]: value.color }}
                onClick={() => patch('coverColor', id as PresentationDetails['coverColor'])}
              />
            ))}
          </div>
          <div className="presentation-auto">
            <b>画面取景</b>
            <p className="muted">在左侧预览内滚轮缩放、拖动平移。导出保留当前取景。</p>
          </div>
          <label>
            缩放 <span id="presentationZoomLabel">{Math.round(details.viewport.zoom * 100)}%</span>
            <input
              id="presentationZoom"
              type="range"
              min={100}
              max={400}
              step={1}
              value={details.viewport.zoom * 100}
              onChange={event => patch('viewport', { ...details.viewport, zoom: Number(event.target.value) / 100 })}
            />
          </label>
          <label>
            水平位置
            <input
              id="presentationPanX"
              type="range"
              min={0}
              max={100}
              step={0.1}
              value={details.viewport.x * 100}
              onChange={event => patch('viewport', { ...details.viewport, x: Number(event.target.value) / 100 })}
            />
          </label>
          <label>
            垂直位置
            <input
              id="presentationPanY"
              type="range"
              min={0}
              max={100}
              step={0.1}
              value={details.viewport.y * 100}
              onChange={event => patch('viewport', { ...details.viewport, y: Number(event.target.value) / 100 })}
            />
          </label>
          <button id="btnResetViewport" onClick={() => patch('viewport', { zoom: 1, x: 0.5, y: 0.5 })}>
            完整显示布局
          </button>
          <label className="check">
            <input
              id="presentationChangeHints"
              type="checkbox"
              checked={details.showChangeHints}
              onChange={event => patch('showChangeHints', event.target.checked)}
            />
            显示更换图标角标
          </label>
          <label>
            暗管连接示意
            <select
              id="presentationConnectionPair"
              value={details.connectionPair}
              disabled={!connections.length}
              onChange={event => patch('connectionPair', event.target.value)}
            >
              <option value="">不显示连接光带</option>
              {connections.map(option => (
                <option key={option.value} value={option.value}>
                  {option.text}
                </option>
              ))}
            </select>
            <span className="muted">在画布中配对暗管后，可选择一对连接随图片导出。</span>
          </label>
          <div className="presentation-auto">
            <b>随布局自动生成</b>
            <div id="presentationAuto" />
            <div className="muted">设备清单按原版顺序排列。物流图标按原版隐藏数量。</div>
          </div>
        </div>
        <div className="presentation-stage">
          <canvas
            id="presentationCanvas"
            aria-label="包含右侧详情的完整蓝图预览"
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPan}
            onPointerCancel={endPan}
            onWheel={onWheel}
          />
        </div>
      </div>
      <div className="presentation-foot">
        <span id="presentationMessage">{message}</span>
        <span id="presentationError" role="alert">
          {error}
        </span>
        <button id="btnCancelPresentation" onClick={onClose}>
          取消修改
        </button>
      </div>
    </dialog>
  );
}

/** Re-exported so the editor's export button can use the same painter. */
export { exportPresentation, undergroundRole };
