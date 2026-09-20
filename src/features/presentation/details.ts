/**
 * Blueprint detail defaults.
 *
 * Presentation fields are optional in the document, so the editor always works against a fully
 * populated copy and only writes back the fields the user actually changed.
 */
import type { CoverColor, Layout, PresentationDetails } from '../../core/types';

export const COVER_COLORS: Record<CoverColor, { label: string; color: string }> = {
  blue: { label: '蓝色', color: '#64d0fe' },
  cyan: { label: '青色', color: '#4fecce' },
  yellow: { label: '黄色', color: '#fbfd20' },
  green: { label: '绿色', color: '#d0f170' },
  purple: { label: '紫色', color: '#d3bafe' },
  orange: { label: '橙色', color: '#fea760' },
  gray: { label: '灰色', color: '#d9d9d9' },
};

export const DEFAULT_DETAILS: PresentationDetails = {
  creatorId: '',
  tags: [],
  description: '',
  coverId: '',
  coverColor: 'blue',
  showChangeHints: false,
  connectionPair: '',
  viewport: { zoom: 1, x: 0.5, y: 0.5 },
};

/** Fills in every optional presentation field so the UI never has to check for undefined. */
export function detailsOf(layout: Layout): PresentationDetails {
  const source = layout.presentation ?? {};
  return {
    creatorId: source.creatorId ?? DEFAULT_DETAILS.creatorId,
    tags: source.tags ? [...source.tags] : [],
    description: source.description ?? '',
    coverId: source.coverId ?? '',
    coverColor: source.coverColor ?? DEFAULT_DETAILS.coverColor,
    showChangeHints: source.showChangeHints ?? DEFAULT_DETAILS.showChangeHints,
    connectionPair: source.connectionPair ?? '',
    viewport: {
      zoom: source.viewport?.zoom ?? DEFAULT_DETAILS.viewport.zoom,
      x: source.viewport?.x ?? DEFAULT_DETAILS.viewport.x,
      y: source.viewport?.y ?? DEFAULT_DETAILS.viewport.y,
    },
  };
}

/** Splits a free-form tag input on the separators the original UI accepted. */
export function parseTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,，、\n]/)
        .map(part => part.trim())
        .filter(Boolean),
    ),
  ];
}
