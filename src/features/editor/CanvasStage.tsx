/**
 * The editor canvas.
 *
 * Painting is imperative and shared with the PNG exporter (`paintScene`), which is what guarantees
 * that the on-screen layout and the exported image agree. React only owns the element, the viewport
 * and the pointer state machine.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { clone, connectedRoute, footprint, hit, mergeRoutes, placementError, removeNode } from '../../core';
import type { Conveyor, Layout, PortKind, WorldPort } from '../../core/types';
import { drawNode, paintScene } from '../../render/paintScene';
import type { DrawableImage } from '../../render/assets';
import { drawSlicedSprite } from '../../render/paintScene';
import { useEditorStore } from '../../app/store';
import { fitView, initialView, insideLayout, toCell, zoomAt } from './view';
import type { View } from './view';
import { useScene } from '../../app/SceneContext';

type Gesture =
  | { type: 'pan'; x: number; y: number; ox: number; oy: number }
  | {
      type: 'move';
      index: number;
      start: { x: number; z: number };
      original: Layout['nodes'][number];
      preview: Layout['nodes'][number];
      moved: boolean;
    }
  | {
      type: 'route';
      start: { x: number; z: number; gx: number; gz: number };
      kind: PortKind;
      path: Conveyor[];
      startPort: WorldPort | null;
      endPort: WorldPort | null;
      error: string;
    };

export function CanvasStage() {
  const store = useEditorStore();
  const scene = useScene();
  const {
    data,
    buildings,
    revision,
    selectedIndex,
    tool,
    chosen,
    rotation,
    activePair,
    showGrid,
    showPorts,
    showHints,
  } = store;

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState<View>(initialView);
  const [hover, setHover] = useState<{ x: number; z: number; gx: number; gz: number } | null>(null);
  const [space, setSpace] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  const frame = useRef(0);

  const paint = useMemo(
    () => ({
      assets: scene.assets,
      buildings,
      products: scene.products,
      sprites: scene.sprites,
      spriteBorders: scene.spriteBorders,
      statusLayers: scene.statusLayers,
    }),
    [scene, buildings],
  );

  const toggleConnection = useCallback(
    (index: number) => {
      const node = data.nodes[index];
      if (!node?.undergroundPair) return;
      store.setSelectedIndex(index);
      store.setActivePair(store.activePair === node.undergroundPair ? null : node.undergroundPair);
    },
    [data, store],
  );

  const requestDraw = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      draw();
    });
    // `draw` is recreated each render and closes over fresh state, so it is intentionally not a
    // dependency here. The canvas is an imperative surface: React owns the element and the viewport,
    // not the pixels.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- see comment above
  }, []);

  /** Resizes the backing store to the element, honouring device pixel ratio. */
  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ratio = devicePixelRatio || 1;
    canvas.width = Math.round(wrap.clientWidth * ratio);
    canvas.height = Math.round(wrap.clientHeight * ratio);
    requestDraw();
  }, [requestDraw]);

  useLayoutEffect(() => {
    resize();
    const observer = new ResizeObserver(resize);
    if (wrapRef.current) observer.observe(wrapRef.current);
    return () => observer.disconnect();
  }, [resize]);

  /** Fits the layout the first time real content appears. */
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || !wrapRef.current) return;
    fitted.current = true;
    setView(fitView(data, buildings, wrapRef.current.clientWidth, wrapRef.current.clientHeight));
  }, [data, buildings]);

  // Repaints whenever anything the canvas draws changes.
  useEffect(() => {
    requestDraw();
  }, [revision, view, hover, selectedIndex, showGrid, showPorts, showHints, activePair, requestDraw]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const ratio = devicePixelRatio || 1;
    const width = canvas.width / ratio;
    const height = canvas.height / ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#e6e6e6';
    ctx.fillRect(0, 0, width, height);

    const current = gesture.current;
    paintScene(ctx, data, paint, view, {
      grid: showGrid,
      ports: showPorts,
      hints: showHints,
      hintScale: 0.5,
      activePair,
      dimIndex: current?.type === 'move' && current.moved ? current.index : -1,
    });

    ctx.strokeStyle = '#b5bdc2';
    ctx.lineWidth = 1;
    ctx.strokeRect(view.ox, view.oy, data.size.x * view.s, data.size.z * view.s);

    if (hover && !current && tool === 'select') {
      const index = hit(data.nodes, buildings, hover.x, hover.z);
      const f =
        index >= 0
          ? footprint(data.nodes[index]!, buildings)
          : data.conveyors.some(belt => belt.x === hover.x && belt.z === hover.z)
            ? { x0: hover.x, z0: hover.z, w: 1, d: 1 }
            : null;
      if (f) {
        const pad = (22 / 128) * view.s;
        drawSlicedSprite(
          ctx,
          scene.assets.get(scene.sprites.hover_frame),
          scene.spriteBorders.hover_frame,
          view.ox + f.x0 * view.s - pad,
          view.oy + f.z0 * view.s - pad,
          f.w * view.s + pad * 2,
          f.d * view.s + pad * 2,
          view.s / 128,
        );
      }
    }

    if (selectedIndex >= 0 && data.nodes[selectedIndex]) {
      const f = footprint(data.nodes[selectedIndex]!, buildings);
      drawSlicedSprite(
        ctx,
        scene.assets.get(scene.sprites.selection_frame),
        scene.spriteBorders.selection_frame,
        view.ox + f.x0 * view.s,
        view.oy + f.z0 * view.s,
        f.w * view.s,
        f.d * view.s,
        view.s / 128,
      );
    }

    // Placement ghost: either a device being dragged or the device about to be placed.
    let ghost: Parameters<typeof drawNode>[1] | null = null;
    let ignore = -1;
    if (current?.type === 'move' && current.moved) {
      ghost = current.preview;
      ignore = current.index;
    } else if (tool === 'place' && chosen && hover && !current) {
      ghost = { templateId: chosen, position: { x: hover.x, z: hover.z }, direction: rotation };
    }
    if (ghost) {
      const error = placementError(data, buildings, ghost, ignore);
      ctx.save();
      ctx.globalAlpha = 0.6;
      drawNode(ctx, ghost, paint, view);
      ctx.restore();
      rectOutline(ctx, ghost, error ? '#d36159' : '#4aaccb', Boolean(error));
    }

    if (current?.type === 'route') {
      ctx.save();
      ctx.globalAlpha = 0.8;
      paintScene(ctx, { ...data, conveyors: current.path }, paint, view, { linesOnly: true });
      ctx.restore();
      for (const endpoint of [current.startPort, current.endPort]) {
        if (!endpoint) continue;
        ctx.strokeStyle = '#1887a6';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(
          view.ox + endpoint.edgeX * view.s,
          view.oy + endpoint.edgeZ * view.s,
          Math.max(5, view.s * 0.17),
          0,
          Math.PI * 2,
        );
        ctx.stroke();
      }
      if (current.error && hover) {
        ctx.strokeStyle = '#c94848';
        ctx.lineWidth = 2;
        ctx.strokeRect(view.ox + hover.x * view.s, view.oy + hover.z * view.s, view.s, view.s);
      }
    }
    // Every value the painter reads is listed explicitly; `paint` bundles the render lookups.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- see comment above
  }, [
    data,
    paint,
    view,
    hover,
    selectedIndex,
    tool,
    chosen,
    rotation,
    showGrid,
    showPorts,
    showHints,
    activePair,
    buildings,
    scene,
  ]);

  const rectOutline = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      node: { position: { x: number; z: number }; direction?: number; templateId: string },
      color: string,
      fill: boolean,
    ) => {
      const f = footprint(node, buildings);
      const x = view.ox + f.x0 * view.s;
      const y = view.oy + f.z0 * view.s;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      if (fill) {
        ctx.fillStyle = color;
        ctx.globalAlpha *= 0.16;
        ctx.fillRect(x, y, f.w * view.s, f.d * view.s);
        ctx.globalAlpha /= 0.16;
      }
      ctx.strokeRect(x + 1, y + 1, f.w * view.s - 2, f.d * view.s - 2);
    },
    [buildings, view],
  );

  const cellFromEvent = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const canvas = canvasRef.current!;
      return toCell(view, canvas.getBoundingClientRect(), event.clientX, event.clientY);
    },
    [view],
  );

  const updateRoute = useCallback(
    (end: { x: number; z: number; gx: number; gz: number }, verticalFirst: boolean) => {
      const current = gesture.current;
      if (current?.type !== 'route') return;
      try {
        const result = connectedRoute(data, buildings, current.start, end, current.kind, verticalFirst, rotation);
        current.path = result.path;
        current.startPort = result.start.port ?? null;
        current.endPort = result.end.port ?? null;
        current.error = '';
      } catch (error) {
        current.path = [];
        current.startPort = null;
        current.endPort = null;
        current.error = (error as Error).message;
      }
    },
    [data, buildings, rotation],
  );

  const eraseAt = useCallback(
    (cell: { x: number; z: number }) => {
      const index = hit(data.nodes, buildings, cell.x, cell.z);
      if (index >= 0) {
        store.setSelectedIndex(-1);
        store.transact(draft => removeNode(draft.nodes, index), '已删除设备，可撤销');
      } else {
        store.transact(draft => {
          draft.conveyors = draft.conveyors.filter(belt => belt.x !== cell.x || belt.z !== cell.z);
        }, '已删除该格线路，可撤销');
      }
    },
    [data, buildings, store],
  );

  // Pointer and wheel handling. React attaches these as native listeners because the gesture state
  // machine needs pointer capture and non-passive wheel events.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onPointerDown = (event: PointerEvent) => {
      if (event.button > 2) return;
      const cell = cellFromEvent(event);
      canvas.focus();
      if (event.button === 2) {
        if (insideLayout(data, cell)) eraseAt(cell);
        return;
      }
      canvas.setPointerCapture(event.pointerId);
      if (event.button === 1 || space) {
        event.preventDefault();
        gesture.current = { type: 'pan', x: event.clientX, y: event.clientY, ox: view.ox, oy: view.oy };
        return;
      }
      if (!insideLayout(data, cell)) return;

      const index = hit(data.nodes, buildings, cell.x, cell.z);
      if (tool === 'icon') {
        if (index >= 0) {
          store.setSelectedIndex(index);
          store.transact(draft => {
            draft.nodes[index]!.productIcon = store.iconBrush;
          }, '设备属性已更新');
        } else {
          store.setStatus('点击设备可标注物品，Esc 退出图标画笔');
        }
        return;
      }
      if (tool === 'erase') {
        eraseAt(cell);
        return;
      }
      if (tool === 'item' || tool === 'fluid') {
        gesture.current = {
          type: 'route',
          start: cell,
          kind: tool,
          path: [],
          startPort: null,
          endPort: null,
          error: '',
        };
        updateRoute(cell, event.shiftKey);
        requestDraw();
        return;
      }
      if (index >= 0) {
        store.setTool('select', { keepSelection: true });
        store.setSelectedIndex(index);
        if (innerWidth <= 860) document.body.classList.add('inspect-open');
        gesture.current = {
          type: 'move',
          index,
          start: { x: cell.x, z: cell.z },
          original: clone(data.nodes[index]!),
          preview: clone(data.nodes[index]!),
          moved: false,
        };
        requestDraw();
        return;
      }
      if (tool === 'place' && chosen) {
        const node = { templateId: chosen, position: { x: cell.x, z: cell.z }, direction: rotation, productIcon: null };
        store.transact(draft => {
          draft.nodes.push(node);
        }, `已放置 ${buildings[chosen]!.name}`);
      } else {
        store.setSelectedIndex(-1);
        requestDraw();
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      const cell = cellFromEvent(event);
      setHover(insideLayout(data, cell) ? cell : null);
      const current = gesture.current;
      if (current?.type === 'pan') {
        setView(previous => ({
          ...previous,
          ox: current.ox + event.clientX - current.x,
          oy: current.oy + event.clientY - current.y,
        }));
      } else if (current?.type === 'move') {
        current.preview.position = {
          x: current.original.position.x + cell.x - current.start.x,
          z: current.original.position.z + cell.z - current.start.z,
        };
        current.moved = current.moved || cell.x !== current.start.x || cell.z !== current.start.z;
        requestDraw();
      } else if (current?.type === 'route') {
        updateRoute(
          {
            ...cell,
            x: Math.max(0, Math.min(data.size.x - 1, cell.x)),
            z: Math.max(0, Math.min(data.size.z - 1, cell.z)),
          },
          event.shiftKey,
        );
        requestDraw();
      } else {
        requestDraw();
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      const current = gesture.current;
      gesture.current = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);

      if (current?.type === 'move' && current.moved) {
        store.transact(draft => {
          draft.nodes[current.index] = current.preview;
        }, '设备位置已更新');
      }
      if (current?.type === 'move' && !current.moved && showHints) {
        handleHintClick(event, current.index);
      }
      if (current?.type === 'route') {
        if (current.error) store.setStatus(current.error, true);
        else if (current.path.length) {
          const path = current.path;
          store.transact(
            draft => {
              draft.conveyors = mergeRoutes(draft.conveyors, path);
            },
            `已铺设 ${path.length} 格线路${current.startPort || current.endPort ? ' · 已吸附接口' : ''}`,
          );
        }
      }
      requestDraw();
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      setView(previous =>
        zoomAt(previous, event.clientX - rect.left, event.clientY - rect.top, event.deltaY < 0 ? 1.15 : 1 / 1.15),
      );
    };

    const onPointerLeave = () => {
      if (!gesture.current) {
        setHover(null);
        requestDraw();
      }
    };
    const onPointerCancel = () => {
      gesture.current = null;
      requestDraw();
    };
    const onContextMenu = (event: MouseEvent) => event.preventDefault();

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenu);
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
    };
    // Pointer handlers are re-registered when any input they read changes. `store` is a stable object
    // whose individual fields are read through it, so it is listed rather than each field.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- see comment above
  }, [
    canvasRef,
    cellFromEvent,
    data,
    buildings,
    view,
    tool,
    chosen,
    rotation,
    space,
    store,
    eraseAt,
    updateRoute,
    requestDraw,
    showHints,
  ]);

  /** Tapping the on-canvas change-icon badge or the underground toggle opens the related panel. */
  const handleHintClick = useCallback(
    (event: PointerEvent, index: number) => {
      const node = data.nodes[index];
      if (!node) return;
      const building = buildings[node.templateId]!;
      const f = footprint(node, buildings);
      const rect = canvasRef.current!.getBoundingClientRect();
      const cx = view.ox + (f.x0 + f.w / 2) * view.s;
      const cy = view.oy + (f.z0 + f.d / 2) * view.s;
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const within = (left: number, top: number) => x >= left && x <= left + 22 && y >= top && y <= top + 22;
      if (
        building.canModify &&
        x > cx + Math.min(4, view.s * 0.1) &&
        y < cy - Math.min(4, view.s * 0.1) &&
        within(cx + (67.5 / 128) * view.s - 22, cy - (67.5 / 128) * view.s)
      ) {
        scene.openLibrary(index);
      } else if (building.underground && within(cx - 1, cy - 20.25)) {
        toggleConnection(index);
      }
    },
    [data, buildings, view, scene, toggleConnection],
  );

  // Space pans, and Escape cancels any in-flight gesture.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpace(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpace(false);
    };
    const onBlur = () => {
      setSpace(false);
      gesture.current = null;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // Expose the viewport so the toolbar's "fit" button and the summary cards can drive it.
  useEffect(() => {
    scene.registerViewport({
      fit: () => {
        const wrap = wrapRef.current;
        if (wrap) setView(fitView(data, buildings, wrap.clientWidth, wrap.clientHeight));
      },
      centerOn: (x: number, z: number) => {
        const wrap = wrapRef.current;
        if (!wrap) return;
        setView(previous => ({
          ...previous,
          ox: wrap.clientWidth / 2 - (x + 0.5) * previous.s,
          oy: wrap.clientHeight / 2 - (z + 0.5) * previous.s,
        }));
      },
      size: () => ({ width: wrapRef.current?.clientWidth ?? 0, height: wrapRef.current?.clientHeight ?? 0 }),
      view: () => view,
      isVisible: (x, z) => {
        const wrap = wrapRef.current;
        if (!wrap) return true;
        const cx = view.ox + (x + 0.5) * view.s;
        const cy = view.oy + (z + 0.5) * view.s;
        return cx >= 20 && cx <= wrap.clientWidth - 20 && cy >= 70 && cy <= wrap.clientHeight - 20;
      },
    });
  }, [scene, data, buildings, view]);

  return (
    <section id="wrap" ref={wrapRef}>
      <canvas id="cv" tabIndex={0} aria-label="蓝图编辑画布" ref={canvasRef} />
      {scene.overlay}
    </section>
  );
}

/** Assets an image element can draw; exported for the presentation preview. */
export type { DrawableImage };
