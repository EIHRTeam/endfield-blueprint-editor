/**
 * Lazy entry point for the full preview export.
 *
 * The heavy painter is imported on demand so it lands in the presentation chunk instead of the
 * editor's initial bundle.
 */
import type { Layout } from '../../core/types';
import type { SceneValue } from '../../app/SceneContext';

export default async function exportPresentationPreview(
  scene: SceneValue,
  layout: Layout,
  width: number,
): Promise<HTMLCanvasElement> {
  const { exportPresentation } = await import('./paintPresentation');
  return exportPresentation(scene, layout, width);
}
