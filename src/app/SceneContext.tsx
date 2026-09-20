/**
 * Scene context.
 *
 * Holds everything the canvas needs that is *not* part of the document: the decoded asset cache, the
 * bake payload slices, the shared viewport handle, and the hooks other panels use to open the
 * library / presentation dialogs. Keeping it separate from the editor store means the document and
 * the artwork have independent lifecycles.
 */
import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { AssetStore } from '../render/assets';
import type { BakePayload, LineItem, Product, PresentationPayload, SpriteBorders, StatusLayer } from '../core/types';
import type { View } from '../features/editor/view';

export interface ViewportHandle {
  fit: () => void;
  centerOn: (x: number, z: number) => void;
  size: () => { width: number; height: number };
  view: () => View;
  isVisible: (x: number, z: number) => boolean;
}

export interface SceneValue {
  assets: AssetStore;
  payload: BakePayload;
  products: Record<string, Product>;
  lineItems: Record<string, LineItem>;
  sprites: Record<string, string>;
  spriteBorders: SpriteBorders;
  statusLayers: Record<string, StatusLayer[]>;
  presentation: PresentationPayload;
  license: string;
  /** Base URL every runtime asset is resolved against. */
  base: string;
  registerViewport: (handle: ViewportHandle) => void;
  viewport: () => ViewportHandle | null;
  /** Opens the item library for a specific device index, or for the icon brush when null. */
  openLibrary: (index: number | null) => void;
  /** Opens the full presentation dialog. */
  openPresentation: () => void;
  /** Overlay the canvas renders (lazy chunks, dialogs). */
  overlay?: ReactNode;
}

const Context = createContext<SceneValue | null>(null);

export function SceneContextProvider({ value, children }: { value: SceneValue; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useScene(): SceneValue {
  const value = useContext(Context);
  if (!value) throw Error('useScene must be used inside <SceneContextProvider>');
  return value;
}
