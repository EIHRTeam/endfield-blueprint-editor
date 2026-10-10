/** Persisted OCR review records must stay tied to evidence while editable layouts change. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { createChecks, report } from './harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'reports/test-artifacts/review');
await build({
  root: ROOT,
  configFile: false,
  logLevel: 'warn',
  build: {
    outDir: OUT,
    emptyOutDir: true,
    minify: false,
    target: 'es2022',
    lib: {
      entry: { review: path.join(ROOT, 'src/core/review.ts'), validate: path.join(ROOT, 'src/core/validate.ts') },
      formats: ['es'],
      fileName: (_, entry) => `${entry}.mjs`,
    },
  },
});
const { createReview, reviewIssueSignature } = await import(pathToFileURL(path.join(OUT, 'review.mjs')).href);
const { validate } = await import(pathToFileURL(path.join(OUT, 'validate.mjs')).href);
const checks = createChecks();
const buildings = { unit: { id: 'unit', name: '设备', w: 1, d: 1, ports: [] } };
const layout = {
  schemaVersion: 2,
  name: '人工核对',
  size: { x: 10, z: 10 },
  nodes: [{ templateId: 'unit', position: { x: 3, z: 4 }, direction: 1 }],
  conveyors: [{ x: 2, z: 7, kind: 'item', dir: 0 }],
};
const evidence = {
  uncertainLines: [
    { x: 2, z: 7, kind: 'item', issue: 'direction', reason: '方向由连通关系推断', resolved: true },
    { x: 2, z: 7, kind: 'item', issue: 'visibility', reason: '部分被遮挡' },
  ],
  devices: [{ templateId: 'unit', x: 3, y: 4, visibleFraction: 0.8, orientationAlternatives: [1, 3] }],
};
const withReview = () => ({ ...structuredClone(layout), ocrReview: createReview(layout, evidence, buildings) });

checks.check('directions settled by connections are not listed; occluded devices are', () => {
  const review = withReview().ocrReview;
  assert.equal(review.issues.length, 2);
  assert.equal(review.issues[0].reason, '部分被遮挡');
  assert.equal(review.issues[0].inferred, undefined);
  assert.deepEqual(review.confirmed, {});
  assert.equal(review.issues[1].kind, 'device');
  assert.match(review.issues[1].reason, /遮挡/);
  assert.doesNotMatch(review.issues[1].reason, /朝向/, 'look-alike orientations are settled by the lines');
});
checks.check('touching doubtful line cells form one place and only near-tie devices are listed', () => {
  const wide = {
    ...structuredClone(layout),
    nodes: [...layout.nodes, { templateId: 'unit', position: { x: 7, z: 1 } }],
  };
  const twin = { ...buildings, twin: { id: 'twin', name: '相似设备', w: 1, d: 1, ports: [] } };
  const review = createReview(
    wide,
    {
      uncertainLines: [
        { x: 1, z: 2, kind: 'item', reason: '线路箭头方向接近，需核对' },
        { x: 2, z: 2, kind: 'item', reason: '线路箭头方向接近，需核对' },
        { x: 2, z: 3, kind: 'item', reason: '与相邻格不衔接' },
        { x: 2, z: 4, kind: 'fluid', reason: '管道' },
        { x: 6, z: 6, kind: 'item', reason: '方向由连通关系推断', resolved: true },
      ],
      devices: [
        { templateId: 'unit', x: 3, y: 4, score: 0.9, alternatives: [{ templateId: 'twin', score: 0.897 }] },
        { templateId: 'unit', x: 7, y: 1, score: 0.9, alternatives: [{ templateId: 'twin', score: 0.88 }] },
      ],
    },
    twin,
  );
  assert.deepEqual(
    review.issues.map(issue => [issue.title, issue.bounds]),
    [
      ['传送带 (1, 2)–(2, 3)，3 格', { x0: 1, z0: 2, x1: 3, z1: 4 }],
      ['管道 (2, 4)', { x0: 2, z0: 4, x1: 3, z1: 5 }],
      ['设备 (3, 4)', { x0: 3, z0: 4, x1: 4, z1: 5 }],
    ],
  );
  assert.match(review.issues[0].reason, /箭头方向接近.*不衔接/);
  assert.match(review.issues[2].reason, /相似设备/);
});
checks.check('video source identity ignores only decode wall time while preserving the complete report', () => {
  const input = {
    ...structuredClone(evidence),
    video: { name: 'recording.mp4', durationSeconds: 10, decodeWallSeconds: 2.5 },
  };
  const before = structuredClone(input);
  const first = createReview(layout, input, buildings);
  const repeated = structuredClone(input);
  repeated.video.decodeWallSeconds = 9.8;
  const second = createReview(layout, repeated, buildings);
  assert.equal(second.sourceId, first.sourceId);
  assert.deepEqual(input, before, 'fingerprinting must not mutate the supplied report');
  assert.deepEqual(first.report, input);
  assert.deepEqual(second.report, repeated, 'both reports keep their actual decode duration');
  const changedLayout = structuredClone(layout);
  changedLayout.nodes[0].direction = 2;
  assert.notEqual(createReview(changedLayout, input, buildings).sourceId, first.sourceId);
  const changedVideo = structuredClone(input);
  changedVideo.video.durationSeconds = 11;
  assert.notEqual(createReview(layout, changedVideo, buildings).sourceId, first.sourceId);
  const changedEvidence = structuredClone(input);
  changedEvidence.uncertainLines[0].reason = '新的识别证据';
  assert.notEqual(createReview(layout, changedEvidence, buildings).sourceId, first.sourceId);
});
checks.check(
  'coverage gaps become bounded, persistent review regions without turning raw edge noise into issues',
  () => {
    const reportWithCoverage = {
      ...evidence,
      registration: { coverage: { unknown_bounds: [0, 0, 10, 10] } },
      reviewRegions: [
        { bounds: { x0: 0, z0: 0, x1: 2, z1: 3 }, reason: '这片画面尚未拍到', missingFraction: 0.9 },
        { bounds: { x0: 8, z0: 8, x1: 12, z1: 10 } },
        { bounds: { x0: 0.5, z0: 0, x1: 2, z1: 3 } },
      ],
    };
    const review = createReview(layout, reportWithCoverage, buildings);
    assert.equal(review.issues.length, 3);
    const region = review.issues[0];
    assert.equal(region.kind, 'coverage');
    assert.deepEqual(region.bounds, { x0: 0, z0: 0, x1: 2, z1: 3 });
    assert.match(region.reason, /尚未拍到/);
    assert.deepEqual(validate({ ...layout, ocrReview: review }, buildings).ocrReview, review);
    const signature = reviewIssueSignature(layout, region, buildings);
    const filled = structuredClone(layout);
    filled.nodes[0].position = { x: 0, z: 1 };
    assert.notEqual(
      reviewIssueSignature(filled, region, buildings),
      signature,
      'filling a blind area invalidates its old confirmation',
    );
  },
);
checks.check('validation preserves original evidence and confirmation signatures without mutating inputs', () => {
  const source = withReview();
  const issue = source.ocrReview.issues[0];
  source.ocrReview.confirmed[issue.id] = reviewIssueSignature(source, issue, buildings);
  source.nodes[0].position.x = 5;
  const before = JSON.stringify(source);
  const restored = validate(source, buildings);
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(restored.ocrReview.report, evidence);
  assert.deepEqual(restored.ocrReview.originalLayout, layout);
  assert.equal(restored.nodes[0].position.x, 5);
  assert.equal(restored.ocrReview.confirmed[issue.id], reviewIssueSignature(restored, issue, buildings));
  assert.deepEqual(createReview(restored, evidence, buildings), restored.ocrReview);
});
checks.check('relevant edits invalidate confirmations and undo restores them; unrelated edits keep them valid', () => {
  const source = withReview();
  const issue = source.ocrReview.issues[0];
  const signature = reviewIssueSignature(source, issue, buildings);
  source.nodes[0].direction = 2;
  assert.equal(reviewIssueSignature(source, issue, buildings), signature);
  source.conveyors[0].dir = 1;
  assert.notEqual(reviewIssueSignature(source, issue, buildings), signature);
  source.conveyors[0].dir = 0;
  assert.equal(reviewIssueSignature(source, issue, buildings), signature);
  source.conveyors = [];
  assert.notEqual(reviewIssueSignature(source, issue, buildings), signature);
});
checks.check(
  'persisted review rejects recursive evidence, invalid coordinates, duplicate IDs and forged confirmations',
  () => {
    for (const mutate of [
      source => {
        source.ocrReview.originalLayout.ocrReview = {};
      },
      source => {
        source.ocrReview.issues[0].bounds.x0 = -1;
      },
      source => {
        source.ocrReview.issues.push(source.ocrReview.issues[0]);
      },
      source => {
        source.ocrReview.confirmed.missing = '12345678-4';
      },
      source => {
        source.ocrReview.report.huge = 'x'.repeat(2 * 1024 * 1024);
      },
      source => {
        source.ocrReview.originalLayout.nodes[0].templateId = 'unknown';
      },
    ]) {
      const source = withReview();
      mutate(source);
      assert.throws(() => validate(source, buildings));
    }
  },
);
checks.check('out-of-grid diagnostics are excluded and a confident result lists nothing to look at', () => {
  const review = createReview(layout, { uncertainLines: [{ x: 90, z: 0, kind: 'fluid' }] }, buildings);
  assert.deepEqual(review.issues, []);
});
report('review', checks);
