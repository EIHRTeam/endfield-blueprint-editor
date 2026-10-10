import { footprint } from './geometry';
import type { Bounds, BuildingIndex, Layout, OcrReview, OcrReviewIssue } from './types';

export function reviewFingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${(hash >>> 0).toString(16).padStart(8, '0')}-${text.length}`;
}

/** Score gap below which another device is an equally good match (template scores are 0–1). */
const CLOSE_DEVICE_SCORE = 0.005;

const intersects = (a: Bounds, b: Bounds) => a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;

/** Unrelated edits preserve a confirmation; editing or moving its device/line makes it pending again. */
export function reviewIssueSignature(layout: Layout, issue: OcrReviewIssue, buildings: BuildingIndex): string {
  const nodes = layout.nodes.filter(node => {
    const f = footprint(node, buildings);
    return intersects(issue.bounds, { x0: f.x0, z0: f.z0, x1: f.x0 + f.w, z1: f.z0 + f.d });
  });
  const conveyors = layout.conveyors.filter(line =>
    intersects(issue.bounds, { x0: line.x, z0: line.z, x1: line.x + 1, z1: line.z + 1 }),
  );
  return reviewFingerprint({ nodes, conveyors, size: layout.size });
}

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

function invalidReview(): never {
  throw Error('识别核对记录格式不正确或过大');
}

/** Recognition reports remain evidence; these review items are separate, stable addresses into that evidence. */
export function createReview(layout: Layout, reportValue: unknown, buildings: BuildingIndex): OcrReview {
  if (layout.ocrReview) return structuredClone(layout.ocrReview);
  const originalLayout = structuredClone(layout);
  delete originalLayout.ocrReview;
  const report = object(reportValue) ? structuredClone(reportValue) : {};
  const issues: OcrReviewIssue[] = [];
  const ids = new Set<string>();
  const add = (issue: OcrReviewIssue) => {
    if (ids.has(issue.id)) {
      const existing = issues.find(item => item.id === issue.id)!;
      if (!existing.reason.includes(issue.reason))
        existing.reason = `${existing.reason}；${issue.reason}`.slice(0, 1500);
      if (issue.inferred) existing.inferred = true;
      return;
    }
    const b = issue.bounds;
    if (
      ![b.x0, b.z0, b.x1, b.z1].every(Number.isInteger) ||
      b.x0 < 0 ||
      b.z0 < 0 ||
      b.x1 > layout.size.x ||
      b.z1 > layout.size.z ||
      b.x1 <= b.x0 ||
      b.z1 <= b.z0
    )
      return;
    ids.add(issue.id);
    issues.push(issue);
  };
  if (Array.isArray(report.reviewRegions)) {
    for (const value of report.reviewRegions) {
      if (!object(value) || !object(value.bounds)) continue;
      const { x0, z0, x1, z1 } = value.bounds;
      if (![x0, z0, x1, z1].every(n => typeof n === 'number' && Number.isInteger(n))) continue;
      add({
        id: `coverage:${x0}:${z0}:${x1}:${z1}`,
        title: `画面缺失区域 (${x0}, ${z0})–(${Number(x1) - 1}, ${Number(z1) - 1})`,
        reason:
          typeof value.reason === 'string'
            ? value.reason.slice(0, 1500)
            : '此区域画面不足，不能视为空地；请补拍或手动补齐。',
        bounds: { x0: Number(x0), z0: Number(z0), x1: Number(x1), z1: Number(z1) },
        kind: 'coverage',
      });
    }
  }
  if (Array.isArray(report.uncertainLines)) {
    // Directions already settled by neighbouring ports/lines are not worth a look. Touching
    // cells of one kind form a single place, so a doubtful run of belt is one item, not ten.
    const cells = new Map<string, { kind: 'item' | 'fluid'; x: number; z: number; reason: string }>();
    for (const value of report.uncertainLines) {
      if (
        !object(value) ||
        value.resolved === true ||
        (value.kind !== 'fluid' && value.kind !== 'item') ||
        typeof value.x !== 'number' ||
        typeof value.z !== 'number' ||
        !Number.isInteger(value.x) ||
        !Number.isInteger(value.z)
      )
        continue;
      cells.set(`${value.kind}:${value.x}:${value.z}`, {
        kind: value.kind,
        x: value.x,
        z: value.z,
        reason: typeof value.reason === 'string' ? value.reason.slice(0, 300) : '线路形状或方向需要核对',
      });
    }
    const seen = new Set<string>();
    const ordered = [...cells.values()].sort((a, b) => a.z - b.z || a.x - b.x);
    for (const first of ordered) {
      const firstKey = `${first.kind}:${first.x}:${first.z}`;
      if (seen.has(firstKey)) continue;
      seen.add(firstKey);
      const group = [first];
      for (let i = 0; i < group.length; i++) {
        const { kind, x, z } = group[i];
        for (const [dx, dz] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const key = `${kind}:${x + dx}:${z + dz}`;
          const next = cells.get(key);
          if (next && !seen.has(key)) {
            seen.add(key);
            group.push(next);
          }
        }
      }
      const x0 = Math.min(...group.map(cell => cell.x));
      const z0 = Math.min(...group.map(cell => cell.z));
      const x1 = Math.max(...group.map(cell => cell.x)) + 1;
      const z1 = Math.max(...group.map(cell => cell.z)) + 1;
      const name = first.kind === 'fluid' ? '管道' : '传送带';
      const reasons = [...new Set(group.map(cell => cell.reason))];
      add({
        id: `line:${first.kind}:${first.x}:${first.z}`,
        title:
          group.length === 1
            ? `${name} (${first.x}, ${first.z})`
            : `${name} (${x0}, ${z0})–(${x1 - 1}, ${z1 - 1})，${group.length} 格`,
        reason: (reasons.length > 2 ? [...reasons.slice(0, 2), `等 ${reasons.length} 种情况`] : reasons)
          .join('；')
          .slice(0, 1500),
        bounds: { x0, z0, x1, z1 },
        kind: first.kind,
      });
    }
  }
  if (Array.isArray(report.devices)) {
    for (const value of report.devices) {
      if (!object(value)) continue;
      const position = object(value.position) ? value.position : {};
      const x = value.x ?? position.x;
      const z = value.z ?? value.y ?? position.z;
      const node = layout.nodes.find(
        candidate =>
          candidate.templateId === value.templateId && candidate.position.x === x && candidate.position.z === z,
      );
      if (!node) continue;
      const reasons: string[] = [];
      if (
        (typeof value.visibleFraction === 'number' && value.visibleFraction < 0.97) ||
        (typeof value.productVisibleFraction === 'number' && value.productVisibleFraction < 0.97)
      )
        reasons.push('设备或徽标被遮挡，请核对类型与物品');
      // Only a different device that scored practically the same is a real doubt; every match
      // carries runner-ups, and look-alike orientations are settled by the connected lines.
      const score = typeof value.score === 'number' ? value.score : null;
      const rivals = new Set<string>();
      if (score !== null && Array.isArray(value.alternatives)) {
        for (const alternative of value.alternatives) {
          if (
            object(alternative) &&
            typeof alternative.templateId === 'string' &&
            alternative.templateId !== node.templateId &&
            typeof alternative.score === 'number' &&
            score - alternative.score <= CLOSE_DEVICE_SCORE
          )
            rivals.add(buildings[alternative.templateId]?.name ?? alternative.templateId);
        }
      }
      if (rivals.size) reasons.push(`和「${[...rivals].join('」「')}」几乎一样像，请核对设备类型`);
      if (!reasons.length) continue;
      const f = footprint(node, buildings);
      add({
        id: `device:${node.templateId}:${node.position.x}:${node.position.z}`,
        title: `${buildings[node.templateId].name} (${node.position.x}, ${node.position.z})`,
        reason: reasons.join('；'),
        bounds: { x0: f.x0, z0: f.z0, x1: f.x0 + f.w, z1: f.z0 + f.d },
        kind: 'device',
      });
    }
  }
  // Runtime duration is audit evidence, but must not turn an identical recording into a new source.
  const identityReport = { ...report };
  if (object(report.video)) {
    const video = { ...report.video };
    delete video.decodeWallSeconds;
    identityReport.video = video;
  }
  return {
    version: 1,
    sourceId: reviewFingerprint({ originalLayout, report: identityReport }),
    originalLayout,
    report,
    issues,
    confirmed: {},
  };
}

/** Bound persisted review data before rendering it or storing another copy in localStorage. */
export function validateReview(value: unknown): asserts value is OcrReview {
  if (
    !object(value) ||
    value.version !== 1 ||
    typeof value.sourceId !== 'string' ||
    !/^[a-f0-9]{8}-\d{1,9}$/.test(value.sourceId)
  )
    return invalidReview();
  if (
    !object(value.originalLayout) ||
    value.originalLayout.ocrReview != null ||
    !object(value.report) ||
    !object(value.confirmed) ||
    !Array.isArray(value.issues) ||
    value.issues.length > 5000 ||
    JSON.stringify(value).length > 2 * 1024 * 1024
  )
    return invalidReview();
  const ids = new Set<string>();
  for (const issue of value.issues) {
    if (
      !object(issue) ||
      typeof issue.id !== 'string' ||
      !/^[a-z][a-z0-9_:.-]{0,159}$/.test(issue.id) ||
      ids.has(issue.id) ||
      typeof issue.title !== 'string' ||
      issue.title.length > 200 ||
      typeof issue.reason !== 'string' ||
      issue.reason.length > 1500 ||
      !['item', 'fluid', 'device', 'coverage', 'general'].includes(String(issue.kind)) ||
      !object(issue.bounds) ||
      (issue.inferred != null && typeof issue.inferred !== 'boolean')
    )
      return invalidReview();
    const b = issue.bounds;
    if (
      ![b.x0, b.z0, b.x1, b.z1].every(n => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 50) ||
      Number(b.x0) >= Number(b.x1) ||
      Number(b.z0) >= Number(b.z1)
    )
      return invalidReview();
    ids.add(issue.id);
  }
  for (const [id, signature] of Object.entries(value.confirmed)) {
    if (!ids.has(id) || typeof signature !== 'string' || !/^[a-f0-9]{8}-\d{1,9}$/.test(signature))
      return invalidReview();
  }
}
