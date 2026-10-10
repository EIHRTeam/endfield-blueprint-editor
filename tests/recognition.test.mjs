/** Recognition UI contract tests use real validation/history and a deterministic local-service reply. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from 'playwright';
import { build } from 'vite';
import { createChecks, report, startServer } from './harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'reports/test-artifacts/recognition');
await build({
  root: ROOT,
  configFile: false,
  logLevel: 'warn',
  // Matches vite.config.ts: only the desktop edition renders recognition.
  define: { DESKTOP_EDITION: 'true' },
  build: {
    outDir: OUT,
    emptyOutDir: true,
    minify: false,
    target: 'es2022',
    lib: {
      entry: {
        shell: path.join(ROOT, 'src/ui/shell.tsx'),
        recognition: path.join(ROOT, 'src/ui/recognition.ts'),
        editor: path.join(ROOT, 'src/ui/editor.ts'),
      },
      formats: ['es'],
      fileName: (_, entry) => `${entry}.mjs`,
    },
    rolldownOptions: { external: ['react', 'react/jsx-runtime'] },
  },
});
const { Shell } = await import(pathToFileURL(path.join(OUT, 'shell.mjs')).href);
const { readRecognitionResult, validateScreenshotFiles } = await import(
  pathToFileURL(path.join(OUT, 'recognition.mjs')).href
);
const checks = createChecks();
const buildings = { unit: { id: 'unit', name: '设备', w: 1, d: 1, ports: [], faces: [], normalFaces: [] } };
const layout = {
  schemaVersion: 2,
  name: '截图蓝图',
  size: { x: 10, z: 10 },
  nodes: [{ templateId: 'unit', position: { x: 3, z: 4 }, direction: 1 }],
  conveyors: [],
};
const envelope = {
  layout,
  report: {
    warnings: ['右上角接口被遮挡', '<img src=x onerror=alert(1)>'],
    summary: { images: 2, nodes: 999 },
    evidence: [{ source: '1.png', confidence: 0.73 }],
    uncertainLines: [
      { x: 2, z: 7, kind: 'fluid', reason: '箭头方向接近' },
      { x: 3, z: 8, kind: 'item', reason: '由连接关系推断', resolved: true },
    ],
  },
};

checks.check('input limits reject excessive, mixed, empty and unsupported uploads', () => {
  const file = { name: 'image.png', size: 30 };
  assert.doesNotThrow(() => validateScreenshotFiles(Array.from({ length: 16 }, () => ({ ...file }))));
  assert.doesNotThrow(() => validateScreenshotFiles([{ name: '蓝图.ZIP', size: 400 }]));
  assert.throws(() => validateScreenshotFiles(Array.from({ length: 17 }, () => ({ ...file }))), /16/);
  assert.throws(() => validateScreenshotFiles([file, { name: 'all.zip', size: 1 }]), /单独/);
  assert.throws(() => validateScreenshotFiles([{ name: 'big.png', size: 64 * 1024 * 1024 + 1 }]), /64/);
  assert.throws(() => validateScreenshotFiles([{ name: 'empty.png', size: 0 }]), /空/);
  assert.throws(() => validateScreenshotFiles([{ name: 'file.svg', size: 30 }]), /仅支持/);
});
checks.check(
  'a single recording accepts supported containers up to 256 MiB while image limits remain unchanged',
  () => {
    for (const extension of ['mp4', 'MOV', 'webm', 'mkv']) {
      assert.doesNotThrow(() => validateScreenshotFiles([{ name: `录屏.${extension}`, size: 256 * 1024 * 1024 }]));
    }
    const video = { name: '录屏.mp4', size: 97 * 1024 * 1024 };
    assert.throws(() => validateScreenshotFiles([{ ...video, size: 256 * 1024 * 1024 + 1 }]), /256/);
    assert.throws(() => validateScreenshotFiles([{ ...video, size: 0 }]), /空/);
    for (const name of ['1.png', '蓝图.zip', 'other.webm']) {
      assert.throws(() => validateScreenshotFiles([video, { name, size: 1 }]), /录屏请单独选择/);
    }
    assert.throws(() => validateScreenshotFiles([{ name: 'big.zip', size: 64 * 1024 * 1024 + 1 }]), /64/);
  },
);
checks.check('plain and enveloped layouts share editor validation and preserve their input', () => {
  const input = structuredClone(envelope);
  assert.deepEqual(readRecognitionResult(input, buildings).layout, layout);
  assert.deepEqual(readRecognitionResult(layout, buildings).layout, layout);
  assert.deepEqual(input, envelope);
  assert.throws(() => readRecognitionResult({ layout: { nodes: [{ templateId: 'unknown' }] } }, buildings), /未知/);
});

const server = await startServer({ desktop: true });
let browser;
try {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }), headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const markup = renderToStaticMarkup(createElement(Shell, { licence: '', loadingHidden: true }));
  const styles = [
    await readFile(path.join(ROOT, 'src/styles.css'), 'utf8'),
    await readFile(path.join(ROOT, 'src/ui/recognition.css'), 'utf8'),
  ].join('\n');
  await page.route('**/recognition-test/**', async route => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1);
    await route.fulfill({ contentType: 'text/javascript', body: await readFile(path.join(OUT, name), 'utf8') });
  });
  await page.route('**/recognition-harness', route =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html lang="zh-CN"><head><style>${styles}</style></head><body>${markup}
      <script type="module">
        import { initRecognition } from '/recognition-test/recognition.mjs';
        import { Editor } from '/recognition-test/editor.mjs';
        const editor = new Editor({
          payload: { buildings: ${JSON.stringify(Object.values(buildings))}, products: {}, sprites: {}, spriteBorders: {}, statusLayers: {} },
          assets: { get: () => null }, onRevision: () => {}, status: { setStatus: () => {}, setSaveStatus: () => {} },
        });
        editor.canvas = document.getElementById('cv');
        editor.ctx = editor.canvas.getContext('2d');
        editor.wrap = document.getElementById('wrap');
        editor.resize();
        window.testEditor = editor;
        window.testTeardown = initRecognition(editor);
      </script></body></html>`,
    }),
  );
  await page.goto(`${server.base}recognition-harness`);
  await page.waitForFunction(() => Boolean(window.testEditor));
  const initial = await page.evaluate(() => window.testEditor.data);
  await page.click('#btnRecognition');
  const uploadJson = value =>
    page.locator('#recognitionJsonFile').setInputFiles({
      name: 'result.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(value)),
    });
  const waitReady = () => page.waitForFunction(() => !document.getElementById('btnSaveRecognition').disabled);
  const withoutReview = data => {
    const { ocrReview: _review, ...rest } = data;
    return rest;
  };

  await checks.checkAsync(
    'JSON review shows actual counts and escaped warnings without changing the layout',
    async () => {
      await uploadJson(envelope);
      await waitReady();
      assert.match(await page.locator('#recognitionSummary').textContent(), /2 张截图.*1 个设备/);
      assert.equal(await page.locator('#recognitionWarningList li').count(), 3);
      assert.match(
        await page.locator('#recognitionWarningList').textContent(),
        /管道 \(2, 7\).*坐标从 0 开始.*箭头方向接近/,
      );
      assert.match(await page.locator('#recognitionSummary').textContent(), /1 处线路方向由连接关系推断/);
      assert.doesNotMatch(
        await page.locator('#recognitionWarningList').textContent(),
        /\(3, 8\)/,
        'directions settled by connections are not listed',
      );
      assert.equal(await page.locator('#recognitionWarningList img').count(), 0);
      assert.deepEqual(await page.evaluate(() => window.testEditor.data), initial);
    },
  );
  await checks.checkAsync('download preserves the complete report evidence beside its normalized layout', async () => {
    const ready = page.waitForEvent('download');
    await page.click('#btnSaveRecognition');
    const download = await ready;
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), envelope);
  });
  await checks.checkAsync('explicit import updates the real editor and can be undone and redone', async () => {
    await page.click('#btnImportRecognition');
    assert.equal(await page.locator('#recognitionDialog').isVisible(), false);
    assert.deepEqual(withoutReview(await page.evaluate(() => window.testEditor.data)), layout);
    assert.equal(await page.evaluate(() => window.testEditor.data.ocrReview.version), 1);
    await page.evaluate(() => window.testEditor.undo());
    assert.deepEqual(await page.evaluate(() => window.testEditor.data), initial);
    await page.evaluate(() => window.testEditor.redo());
    assert.deepEqual(withoutReview(await page.evaluate(() => window.testEditor.data)), layout);
    await page.click('#btnRecognition');
  });
  await checks.checkAsync('invalid JSON clears the pending result and leaves the live layout unchanged', async () => {
    await uploadJson({ layout: { nodes: [{ templateId: 'unknown' }] } });
    await page.waitForFunction(() => document.getElementById('recognitionStatus').classList.contains('error'));
    assert.equal(await page.locator('#btnImportRecognition').isDisabled(), true);
    assert.deepEqual(withoutReview(await page.evaluate(() => window.testEditor.data)), layout);
  });
  await checks.checkAsync(
    'multiple screenshots are sent to the selected endpoint as base64 and remain reviewable',
    async () => {
      let submitted;
      await page.route('**/api/recognize', route => {
        submitted = route.request().postDataJSON();
        return route.fulfill({ json: envelope });
      });
      await page.locator('#recognitionEndpoint').fill(server.base.slice(0, -1));
      await page.locator('#recognitionFiles').setInputFiles([
        { name: '1.png', mimeType: 'image/png', buffer: Buffer.from('first image') },
        { name: '2.png', mimeType: 'image/png', buffer: Buffer.from('second image') },
      ]);
      await page.locator('#recognitionWidth').fill('10');
      await page.click('#btnRecognize');
      assert.match(await page.locator('#recognitionStatus').textContent(), /同时输入/);
      assert.equal(submitted, undefined, 'incomplete manual dimensions must not send a recognition request');
      await page.locator('#recognitionHeight').fill('10');
      await page.click('#btnRecognize');
      await waitReady();
      assert.deepEqual(
        submitted.files.map(file => [file.name, Buffer.from(file.data, 'base64').toString()]),
        [
          ['1.png', 'first image'],
          ['2.png', 'second image'],
        ],
      );
      assert.deepEqual(submitted.size, [10, 10]);
      await page.locator('#recognitionWidth').fill('');
      await page.locator('#recognitionHeight').fill('');
      assert.deepEqual(withoutReview(await page.evaluate(() => window.testEditor.data)), layout);
    },
  );
  await checks.checkAsync('service errors preserve the editor and disable import of an obsolete result', async () => {
    await page.unroute('**/api/recognize');
    await page.route('**/api/recognize', route =>
      route.fulfill({ status: 422, json: { error: '截图之间没有可定位的重叠区域' } }),
    );
    await page.click('#btnRecognize');
    await page.waitForFunction(() => document.getElementById('recognitionStatus').textContent.includes('重叠区域'));
    assert.equal(await page.locator('#btnImportRecognition').isDisabled(), true);
    assert.deepEqual(withoutReview(await page.evaluate(() => window.testEditor.data)), layout);
  });
  await checks.checkAsync(
    'cancelling an in-flight request prevents late results from becoming importable',
    async () => {
      await page.unroute('**/api/recognize');
      let release;
      let submitted;
      const reached = new Promise(resolve => {
        submitted = resolve;
      });
      await page.route('**/api/recognize', async route => {
        submitted();
        await new Promise(resolve => {
          release = resolve;
        });
        await route.fulfill({ json: envelope }).catch(() => {});
      });
      await page.click('#btnRecognize');
      await reached;
      await page.click('#btnCancelRecognition');
      release();
      assert.equal(await page.locator('#btnImportRecognition').isDisabled(), true);
      assert.equal(await page.locator('#btnRecognize').isDisabled(), false);
      assert.match(await page.locator('#recognitionStatus').textContent(), /已停止等待.*可能仍在运行/);
    },
  );
  await checks.checkAsync(
    'unavailable service offers the local startup command and offline JSON fallback',
    async () => {
      await page.unroute('**/api/recognize');
      await page.route('**/api/recognize', route => route.abort('connectionrefused'));
      await page.click('#btnRecognize');
      await page.waitForFunction(() => document.getElementById('recognitionStatus').textContent.includes('无法连接'));
      assert.match(await page.locator('#recognitionStatus').textContent(), /python scripts\/ocr_server.py/);
      assert.equal(await page.locator('#btnImportRecognition').isDisabled(), true);
    },
  );

  let videoEnvelope;
  await checks.checkAsync(
    'recordings use a binary request with encoded filename and optional dimensions, never altering the live layout',
    async () => {
      const coveragePreview = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 100;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#db4d51';
        ctx.fillRect(0, 0, 100, 100);
        return canvas.toDataURL('image/png');
      });
      videoEnvelope = {
        ...envelope,
        coveragePreview,
        report: {
          ...envelope.report,
          video: {
            durationSeconds: 10.25,
            decodeWallSeconds: 2.5,
            sampledFrames: 21,
            selectedFrames: [
              { name: 'frame-1.png', timestampSeconds: 0 },
              { name: 'frame-2.png', timestampSeconds: 8.5 },
            ],
          },
          reviewRegions: [
            { bounds: { x0: 0, z0: 0, x1: 2, z1: 3 }, missingFraction: 0.8, reason: '左上角没有拍全，请补拍' },
          ],
        },
      };
      let submitted;
      await page.route('**/api/recognize-video?*', route => {
        submitted = {
          url: route.request().url(),
          type: route.request().headers()['content-type'],
          data: route.request().postDataBuffer(),
        };
        return route.fulfill({ json: videoEnvelope });
      });
      const bytes = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 0, 255, 128]);
      const name = '蓝图 00-33 & #1.mp4';
      await page.locator('#recognitionFiles').setInputFiles({ name, mimeType: 'video/mp4', buffer: bytes });
      await page.locator('#recognitionWidth').fill('10');
      await page.locator('#recognitionHeight').fill('10');
      await page.click('#btnRecognize');
      await waitReady();
      assert.equal(new URL(submitted.url).searchParams.get('name'), name);
      assert.equal(new URL(submitted.url).searchParams.get('width'), '10');
      assert.equal(new URL(submitted.url).searchParams.get('height'), '10');
      assert.equal(submitted.type, 'application/octet-stream');
      assert.deepEqual(submitted.data, bytes);
      assert.match(await page.locator('#recognitionSummary').textContent(), /10.3 秒录屏.*采样 21 帧，选用 2 帧/);
      assert.equal(await page.locator('#recognitionCoverage').isVisible(), true);
      assert.match(await page.locator('#recognitionCoverage').textContent(), /缺失画面不能视为空地/);
      assert.match(
        await page.locator('#recognitionWarningList button').first().textContent(),
        /画面缺失区域.*没有拍全/,
      );
      assert.deepEqual(withoutReview(await page.evaluate(() => window.testEditor.data)), layout);
      const ready = page.waitForEvent('download');
      await page.click('#btnSaveRecognition');
      const stream = await (await ready).createReadStream();
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), videoEnvelope);
      await page.locator('#recognitionWidth').fill('');
      await page.locator('#recognitionHeight').fill('');
    },
  );
  await checks.checkAsync(
    'coverage regions can be located while the coverage image and frame evidence survive a corrected download',
    async () => {
      await page.locator('#recognitionReplace').check();
      await page.locator('#recognitionWarningList button').first().click();
      assert.match(await page.locator('#reviewCurrent').textContent(), /画面缺失区域.*没有拍全/);
      await page.waitForFunction(() => !document.querySelector('#reviewOverlayMode option[value=coverage]').disabled);
      await page.locator('#reviewOverlayMode').selectOption('coverage');
      assert.equal(await page.locator('#reviewCoverageLegend').isVisible(), true);
      assert.deepEqual(
        await page.evaluate(() => {
          const editor = window.testEditor;
          editor.draw();
          const { s, ox, oy } = editor.view;
          return Array.from(editor.ctx.getImageData(Math.floor(ox + 3.5 * s), Math.floor(oy + 3.5 * s), 1, 1).data);
        }),
        [219, 77, 81, 255],
      );
      assert.equal(await page.locator('#reviewIssues input[type=checkbox]').count(), 0, 'nothing to tick off');
      const corrected = await page.evaluate(() => {
        window.testEditor.transact(draft => {
          draft.nodes[0].direction = 2;
        });
        return window.testEditor.data;
      });
      assert.equal(corrected.ocrReview.issues[0].kind, 'coverage');
      assert.equal(
        JSON.stringify(corrected.ocrReview).includes('data:image'),
        false,
        'preview bytes must not enter saved drafts',
      );
      const ready = page.waitForEvent('download');
      await page.click('#btnSaveReview');
      const stream = await (await ready).createReadStream();
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const saved = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.deepEqual(saved.layout, corrected);
      assert.equal(saved.coveragePreview, videoEnvelope.coveragePreview);
      assert.deepEqual(saved.report, videoEnvelope.report);
      await page.click('#btnRecognition');
      await uploadJson({
        ...videoEnvelope,
        report: {
          ...videoEnvelope.report,
          video: { ...videoEnvelope.report.video, decodeWallSeconds: 8.7 },
        },
      });
      await waitReady();
      await page.click('#btnImportRecognition');
      assert.deepEqual(await page.evaluate(() => window.testEditor.data), corrected);
      await page.click('#btnRecognition');
    },
  );
  await checks.checkAsync(
    'mixed video uploads are blocked and cancelled video requests cannot replace pending or edited results',
    async () => {
      const before = await page.evaluate(() => window.testEditor.data);
      const file = { name: 'video.mp4', mimeType: 'video/mp4', buffer: Buffer.from('video') };
      await page
        .locator('#recognitionFiles')
        .setInputFiles([file, { name: '1.png', mimeType: 'image/png', buffer: Buffer.from('image') }]);
      assert.equal(await page.locator('#btnRecognize').isDisabled(), true);
      assert.match(await page.locator('#recognitionStatus').textContent(), /不能混入图片/);
      await page.locator('#recognitionFiles').setInputFiles(file);
      await page.locator('#recognitionWidth').fill('');
      await page.locator('#recognitionHeight').fill('');
      await page.unroute('**/api/recognize-video?*');
      let release;
      let arrived;
      let requestUrl;
      const reached = new Promise(resolve => {
        arrived = resolve;
      });
      await page.route('**/api/recognize-video?*', async route => {
        requestUrl = route.request().url();
        arrived();
        await new Promise(resolve => {
          release = resolve;
        });
        await route.fulfill({ json: videoEnvelope }).catch(() => {});
      });
      await page.click('#btnRecognize');
      await reached;
      await page.click('#btnCancelRecognition');
      release();
      assert.equal(new URL(requestUrl).searchParams.has('width'), false);
      assert.equal(await page.locator('#btnImportRecognition').isDisabled(), true);
      assert.match(await page.locator('#recognitionStatus').textContent(), /已停止等待.*可能仍在运行/);
      assert.deepEqual(await page.evaluate(() => window.testEditor.data), before);
    },
  );

  let editedReview;
  let referenceImage;
  await checks.checkAsync(
    'clickable evidence opens an editable canvas review and aligns the original image to the grid',
    async () => {
      await page.click('#btnCloseRecognition');
      await page.evaluate(input => window.testEditor.importLayout(input), initial);
      referenceImage = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 100;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'rgb(220,20,40)';
        ctx.fillRect(0, 0, 100, 100);
        return canvas.toDataURL('image/png');
      });
      await page.click('#btnRecognition');
      await uploadJson({ ...envelope, preview: referenceImage });
      await waitReady();
      await page.locator('#recognitionWarningList button').first().click();
      assert.equal(await page.locator('#recognitionDialog').isVisible(), false);
      assert.equal(await page.locator('#recognitionReviewPanel').isVisible(), true);
      assert.equal(await page.locator('#reviewIssues > button').count(), 1, 'only the uncertain pipe is listed');
      assert.match(await page.locator('#reviewProgress').textContent(), /有 1 处识别得不太确定/);
      await page.waitForFunction(() => !document.getElementById('reviewOverlayMode').disabled);
      await page.locator('#reviewOverlayMode').selectOption('reference');
      const sample = () =>
        page.evaluate(() => {
          const editor = window.testEditor;
          editor.draw();
          const { s, ox, oy } = editor.view;
          return Array.from(editor.ctx.getImageData(Math.floor(ox + 2.5 * s), Math.floor(oy + 6.5 * s), 1, 1).data);
        });
      assert.deepEqual(await sample(), [220, 20, 40, 255]);
      await page.evaluate(() => {
        window.testEditor.view.ox += 11;
        window.testEditor.view.oy -= 9;
        window.testEditor.view.s *= 0.8;
      });
      assert.deepEqual(await sample(), [220, 20, 40, 255], 'the reference follows viewport pan and zoom');
      await page.locator('#reviewOverlayMode').selectOption('layout');
      assert.deepEqual(await sample(), [230, 230, 230, 255]);
    },
  );
  await checks.checkAsync(
    'manual corrections and the comparison survive real localStorage restore without any confirmation step',
    async () => {
      await page.evaluate(() =>
        window.testEditor.transact(draft => {
          draft.conveyors.push({ x: 2, z: 7, kind: 'fluid', dir: 2 });
          draft.nodes[0].position.x = 5;
        }),
      );
      await page.click('#btnReviewNext');
      assert.equal(await page.locator('#reviewIssues > button.done').count(), 1, 'visited places are marked');
      editedReview = await page.evaluate(() => {
        window.testEditor.saveNow();
        return window.testEditor.data;
      });
      assert.deepEqual(editedReview.ocrReview.confirmed, {});
      await page.reload();
      await page.waitForFunction(() => Boolean(window.testEditor));
      assert.deepEqual(await page.evaluate(() => window.testEditor.data), editedReview);
      assert.equal(await page.locator('#recognitionReviewPanel').isVisible(), true);
      assert.equal(
        await page.locator('#reviewOverlayMode').isDisabled(),
        true,
        'image bytes do not bloat the automatic draft',
      );
    },
  );
  await checks.checkAsync(
    'reopening the same recognition continues manual corrections instead of reimporting its original layout',
    async () => {
      await page.click('#btnRecognition');
      await uploadJson({ ...envelope, preview: referenceImage });
      await waitReady();
      assert.match(await page.locator('#btnImportRecognition').textContent(), /继续当前对照/);
      await page.click('#btnImportRecognition');
      assert.deepEqual(await page.evaluate(() => window.testEditor.data), editedReview);
      await page.waitForFunction(() => !document.getElementById('reviewOverlayMode').disabled);
      const ready = page.waitForEvent('download');
      await page.click('#btnSaveReview');
      const stream = await (await ready).createReadStream();
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const saved = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.deepEqual(saved.layout, editedReview);
      assert.deepEqual(saved.originalLayout, layout);
      assert.deepEqual(saved.report, envelope.report);
      assert.equal(saved.preview, referenceImage);
    },
  );
  await checks.checkAsync(
    'a different result requires explicit replacement and undo restores corrections and confirmations together',
    async () => {
      await page.click('#btnRecognition');
      await uploadJson({ ...envelope, layout: { ...layout, name: '另一份蓝图' } });
      await waitReady();
      assert.equal(await page.locator('#btnImportRecognition').isDisabled(), true);
      await page.locator('#recognitionWarningList button').first().click();
      assert.match(await page.locator('#recognitionStatus').textContent(), /请先保存修改/);
      assert.deepEqual(await page.evaluate(() => window.testEditor.data), editedReview);
      await page.locator('#recognitionReplace').check();
      await page.click('#btnImportRecognition');
      assert.equal(await page.evaluate(() => window.testEditor.data.name), '另一份蓝图');
      await page.evaluate(() => window.testEditor.undo());
      assert.deepEqual(await page.evaluate(() => window.testEditor.data), editedReview);
      await page.click('#btnRecognition');
    },
  );
  await checks.checkAsync('closing the comparison keeps the layout, hides the panel and can be undone', async () => {
    await page.click('#btnCloseRecognition');
    await page.click('#btnReviewClose');
    const closed = await page.evaluate(() => window.testEditor.data);
    assert.equal(closed.ocrReview, undefined);
    assert.deepEqual(closed, withoutReview(editedReview));
    assert.equal(await page.locator('#recognitionReviewPanel').isVisible(), false);
    await page.evaluate(() => window.testEditor.undo());
    assert.deepEqual(await page.evaluate(() => window.testEditor.data), editedReview);
    assert.equal(await page.locator('#recognitionReviewPanel').isVisible(), true);
    const legacy = structuredClone(editedReview);
    legacy.ocrReview.issues.push({
      id: 'general:layout',
      title: '全图检查',
      reason: '旧版本保存的条目',
      kind: 'general',
      bounds: { x0: 0, z0: 0, x1: 10, z1: 10 },
    });
    await page.evaluate(input => window.testEditor.importLayout(input), legacy);
    assert.equal(
      await page.locator('#reviewIssues > button').count(),
      1,
      'drafts saved by older versions show the list derived from their evidence',
    );
    await page.evaluate(() => window.testEditor.undo());
    await page.click('#btnRecognition');
  });
  await checks.checkAsync(
    'background jobs show progress, survive closing the dialog and a reload, and can be cancelled',
    async () => {
      const id = 'a'.repeat(32);
      const second = 'b'.repeat(32);
      const state = { [id]: 'running', [second]: 'running' };
      const deleted = [];
      const isJobs = url => new URL(url).pathname.startsWith('/api/jobs');
      await page.route(isJobs, route => {
        const request = route.request();
        const { pathname } = new URL(request.url());
        const job = jobId => ({
          job: {
            id: jobId,
            name: 'video.mp4',
            status: state[jobId],
            stage: state[jobId] === 'running' ? '对齐并拼接画面' : '完成',
            progress: state[jobId] === 'running' ? 0.4 : 1,
            error: null,
            elapsedSeconds: 12.3,
          },
        });
        if (request.method() === 'POST') {
          assert.equal(request.headers()['content-type'], 'application/octet-stream');
          return route.fulfill({ status: 202, json: job(state[id] === 'running' ? id : second) });
        }
        const jobId = pathname.split('/')[3];
        if (request.method() === 'DELETE') {
          deleted.push(jobId);
          state[jobId] = 'cancelled';
          return route.fulfill({ status: 202, json: job(jobId) });
        }
        if (pathname.endsWith('/result')) return route.fulfill({ json: videoEnvelope });
        return route.fulfill({ json: job(jobId) });
      });
      await page.click('#btnCloseRecognition');
      await page.evaluate(input => window.testEditor.importLayout(input), initial);
      await page.click('#btnRecognition');
      await page.locator('#recognitionEndpoint').fill(server.base.slice(0, -1));
      await page
        .locator('#recognitionFiles')
        .setInputFiles({ name: 'video.mp4', mimeType: 'video/mp4', buffer: Buffer.from('video') });
      await page.click('#btnRecognize');
      await page.waitForFunction(() =>
        /对齐并拼接画面 · 40%/.test(document.getElementById('recognitionProgressText').textContent),
      );
      assert.equal(await page.locator('#recognitionProgressBar').evaluate(bar => bar.value), 0.4);
      assert.match(await page.locator('#btnCancelRecognition').textContent(), /取消识别/);
      // Closing the dialog no longer abandons the work.
      await page.click('#btnCloseRecognition');
      assert.match(await page.locator('#btnRecognition').textContent(), /识别中 40%/);
      assert.deepEqual(deleted, []);
      // A reload (or a tab the browser discarded) reattaches to the same job.
      await page.reload();
      await page.waitForFunction(() => Boolean(window.testEditor));
      await page.waitForFunction(() => document.getElementById('recognitionDialog').open);
      await page.waitForFunction(() =>
        /对齐并拼接画面/.test(document.getElementById('recognitionProgressText').textContent),
      );
      state[id] = 'done';
      await waitReady();
      assert.match(await page.locator('#recognitionSummary').textContent(), /10.3 秒录屏/);
      assert.equal(await page.locator('#recognitionProgress').isVisible(), false);
      assert.equal(await page.locator('#btnRecognize').isDisabled(), true, 'the reloaded page has no file selected');

      await page
        .locator('#recognitionFiles')
        .setInputFiles({ name: 'video.mp4', mimeType: 'video/mp4', buffer: Buffer.from('video') });
      await page.click('#btnRecognize');
      await page.waitForFunction(() => !document.getElementById('btnCancelRecognition').hidden);
      await page.click('#btnCancelRecognition');
      await page.waitForFunction(() => /识别已取消/.test(document.getElementById('recognitionStatus').textContent));
      assert.deepEqual(deleted, [second]);
      assert.equal(await page.locator('#btnCancelRecognition').isHidden(), true);
      assert.equal(await page.evaluate(key => localStorage.getItem(key), 'endfield-blueprint-recognition-job'), null);
      await page.unroute(isJobs);
    },
  );
  await checks.checkAsync(
    'a recognition result opened from the toolbar JSON import replaces the layout in one step and is undoable',
    async () => {
      await page.click('#btnCloseRecognition');
      const before = await page.evaluate(() => window.testEditor.data);
      await page.evaluate(detail => window.dispatchEvent(new CustomEvent('blueprint:import-recognition', { detail })), {
        ...envelope,
        layout: { ...layout, name: '工具栏导入' },
      });
      assert.equal(await page.evaluate(() => window.testEditor.data.name), '工具栏导入');
      assert.equal(await page.locator('#recognitionReviewPanel').isVisible(), true);
      assert.equal(await page.locator('#recognitionDialog').isVisible(), false);
      await page.evaluate(() => window.testEditor.undo());
      assert.deepEqual(await page.evaluate(() => window.testEditor.data), before);
      await page.click('#btnRecognition');
    },
  );
  await checks.checkAsync('dialog remains usable at a narrow mobile viewport', async () => {
    await page.setViewportSize({ width: 390, height: 700 });
    const box = await page.locator('#recognitionDialog').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390);
    assert.ok(box.y >= 0 && box.y + box.height <= 700);
    await page.click('#btnCloseRecognition');
    assert.equal(await page.locator('#recognitionDialog').isVisible(), false);
    assert.deepEqual(errors, []);
  });
} catch (error) {
  checks.failed.push(`suite crashed: ${error.message}`);
} finally {
  if (browser) await browser.close();
  await server.close();
}
report('recognition', checks);
