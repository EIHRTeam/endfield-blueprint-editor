/**
 * Editor state.
 *
 * The document lives in a reducer and every mutation goes through `transact`, which clones,
 * validates and only then commits — the same contract as the previous imperative implementation.
 * Undo/redo is snapshot based and keeps `core/History` as the single source of truth; a revision
 * counter drives re-renders instead of mirroring the stacks into React state.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { History, clone, validate } from '../core';
import type { BakePayload, BlueprintNode, BuildingIndex, Direction, Layout } from '../core/types';

export type Tool = 'select' | 'place' | 'item' | 'fluid' | 'erase' | 'icon';

export const EMPTY_LAYOUT: Layout = {
  schemaVersion: 2,
  name: '未命名蓝图',
  size: { x: 50, z: 50 },
  nodes: [],
  conveyors: [],
};

export const STORAGE_KEY = 'endfield.blueprint.editor.v2';

export interface StoreValue {
  data: Layout;
  /** Bumped on every committed change so the canvas repaints. */
  revision: number;
  buildings: BuildingIndex;
  canUndo: boolean;
  canRedo: boolean;

  /** Applies a mutation to a clone of the document, validating before committing. */
  transact: (operation: (draft: Layout) => void, message?: string) => boolean;
  /** Commits an already-prepared document, recording the before/after pair. */
  commitExternal: (before: Layout, after: Layout, message?: string) => boolean;
  /** Replaces the document without recording history (initial restore and imports). */
  reset: (data: Layout, message?: string) => void;
  undo: () => void;
  redo: () => void;

  status: { message: string; error: boolean };
  setStatus: (message: string, error?: boolean) => void;

  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  tool: Tool;
  setTool: (tool: Tool, options?: { keepSelection?: boolean }) => void;
  chosen: string | null;
  setChosen: (id: string | null) => void;
  rotation: Direction;
  setRotation: (rotation: Direction) => void;
  iconBrush: string | null;
  setIconBrush: (id: string | null) => void;
  activePair: string | null;
  setActivePair: (pair: string | null) => void;
  showGrid: boolean;
  setShowGrid: (value: boolean) => void;
  showPorts: boolean;
  setShowPorts: (value: boolean) => void;
  showHints: boolean;
  setShowHints: (value: boolean) => void;
}

const Context = createContext<StoreValue | null>(null);

export function useEditorStore(): StoreValue {
  const value = useContext(Context);
  if (!value) throw Error('useEditorStore must be used inside <StoreProvider>');
  return value;
}

interface UiState {
  selectedIndex: number;
  tool: Tool;
  chosen: string | null;
  rotation: Direction;
  iconBrush: string | null;
  activePair: string | null;
  showGrid: boolean;
  showPorts: boolean;
  showHints: boolean;
}

const INITIAL_UI: UiState = {
  selectedIndex: -1,
  tool: 'select',
  chosen: null,
  rotation: 0,
  iconBrush: null,
  activePair: null,
  showGrid: true,
  showPorts: false,
  showHints: true,
};

export interface StoreProviderProps {
  payload: BakePayload;
  initial: Layout;
  /** Non-fatal problem from restoring the saved draft, shown once in the status bar. */
  restoreNotice?: string;
  children: ReactNode;
}

/** Provides the document plus all transient editor state. */
export function StoreProvider({ payload, initial, restoreNotice, children }: StoreProviderProps) {
  const buildings = useMemo<BuildingIndex>(() => {
    const index: BuildingIndex = {};
    for (const building of payload.buildings) index[building.id] = building;
    return index;
  }, [payload]);

  /**
   * Undo/redo log.
   *
   * The stacks live in React state, not in a ref, because whether undo is available is *rendered*
   * (the toolbar buttons' disabled state). A ref would not re-render when a stack changed, so the
   * buttons could show a stale state.
   */
  const history = useRef(new History());
  const [stacks, setStacks] = useState({ past: 0, future: 0 });
  const [data, setData] = useState<Layout>(initial);
  const [revision, setRevision] = useState(0);
  // The starting status is derived once from the restored document, so nothing has to announce it
  // from an effect (which would be a synchronous state update during mount).
  const [status, setStatusState] = useState(() => {
    if (restoreNotice) return { message: restoreNotice, error: true };
    if (initial.nodes.length) return { message: '已恢复本机草稿', error: false };
    return { message: '选择设备或点击“示例”开始编辑', error: false };
  });
  const [ui, setUi] = useState<UiState>(INITIAL_UI);

  const setStatus = useCallback((message: string, error = false) => {
    setStatusState({ message, error });
  }, []);

  const commit = useCallback(
    (before: Layout, after: Layout, message?: string) => {
      const log = history.current;
      if (!log.commit(before, after)) return false;
      setData(after);
      setRevision(value => value + 1);
      setStacks({ past: log.past.length, future: log.future.length });
      if (message) setStatus(message);
      return true;
    },
    [setStatus],
  );

  const transact = useCallback(
    (operation: (draft: Layout) => void, message?: string) => {
      try {
        const draft = clone(data);
        operation(draft);
        const valid = validate(draft, buildings);
        return commit(data, valid, message);
      } catch (error) {
        setStatus((error as Error).message, true);
        return false;
      }
    },
    [data, buildings, commit, setStatus],
  );

  const reset = useCallback(
    (next: Layout, message?: string) => {
      setData(next);
      setRevision(value => value + 1);
      if (message) setStatus(message);
    },
    [setStatus],
  );

  const undo = useCallback(() => {
    const log = history.current;
    if (!log.past.length) return;
    setData(log.undo(data));
    setRevision(value => value + 1);
    setStacks({ past: log.past.length, future: log.future.length });
    setUi(previous => ({ ...previous, selectedIndex: -1 }));
    setStatus('已撤销');
  }, [data, setStatus]);

  const redo = useCallback(() => {
    const log = history.current;
    if (!log.future.length) return;
    setData(log.redo(data));
    setRevision(value => value + 1);
    setStacks({ past: log.past.length, future: log.future.length });
    setUi(previous => ({ ...previous, selectedIndex: -1 }));
    setStatus('已重做');
  }, [data, setStatus]);

  const setTool = useCallback((tool: Tool, options?: { keepSelection?: boolean }) => {
    setUi(previous => ({
      ...previous,
      tool,
      // Choosing a tool other than "select" clears the selection, matching the original behaviour,
      // except while placing an icon brush onto the currently selected device.
      selectedIndex: tool !== 'select' && !options?.keepSelection ? -1 : previous.selectedIndex,
    }));
  }, []);

  const value = useMemo<StoreValue>(
    () => ({
      data,
      revision,
      buildings,
      canUndo: stacks.past > 0,
      canRedo: stacks.future > 0,
      transact,
      commitExternal: commit,
      reset,
      undo,
      redo,
      status,
      setStatus,
      selectedIndex: ui.selectedIndex,
      setSelectedIndex: (index: number) => setUi(previous => ({ ...previous, selectedIndex: index })),
      tool: ui.tool,
      setTool,
      chosen: ui.chosen,
      setChosen: (chosen: string | null) => setUi(previous => ({ ...previous, chosen })),
      rotation: ui.rotation,
      setRotation: (rotation: Direction) => setUi(previous => ({ ...previous, rotation })),
      iconBrush: ui.iconBrush,
      setIconBrush: (iconBrush: string | null) => setUi(previous => ({ ...previous, iconBrush })),
      activePair: ui.activePair,
      setActivePair: (activePair: string | null) => setUi(previous => ({ ...previous, activePair })),
      showGrid: ui.showGrid,
      setShowGrid: (showGrid: boolean) => setUi(previous => ({ ...previous, showGrid })),
      showPorts: ui.showPorts,
      setShowPorts: (showPorts: boolean) => setUi(previous => ({ ...previous, showPorts })),
      showHints: ui.showHints,
      setShowHints: (showHints: boolean) => setUi(previous => ({ ...previous, showHints })),
    }),
    [data, revision, buildings, stacks, transact, commit, reset, undo, redo, status, setStatus, ui, setTool],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The selected node, or null. Shared by the inspector panel and the canvas overlays. */
export function selectedNode(data: Layout, selectedIndex: number): BlueprintNode | null {
  return data.nodes[selectedIndex] ?? null;
}
