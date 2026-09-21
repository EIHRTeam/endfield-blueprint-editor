#!/usr/bin/env node
/**
 * Deployment gate for the built output.
 *
 * Enforces the two properties this rewrite exists to guarantee, plus the Cloudflare Pages limits the
 * site is deployed under:
 *
 *   1. A multi-chunk bundle. A single emitted JavaScript file would mean the single-file build crept
 *      back in, and an inlined asset would mean base64 came back with it.
 *   2. No inlining of any kind. Binary assets, JSON payloads, `.wasm` and `.py` are separate files.
 *
 * Runs as the last step of `pnpm build`, so a regression fails the build rather than shipping.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');

/** Cloudflare Pages allows 25 MiB per asset and 20,000 files on the free plan. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 20_000;
/** Keep chunks comfortably under Vite's 500 kB warning threshold. */
const MAX_CHUNK_BYTES = 450 * 1024;
const MIN_CHUNKS = 4;

const problems = [];
const checks = [];

async function walk(relative = '') {
  const absolute = path.join(DIST, relative);
  const out = [];
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(next)));
    else if (entry.isFile()) out.push(next);
  }
  return out;
}

function fail(message) {
  problems.push(message);
}

async function main() {
  if (!existsSync(DIST)) {
    console.error('dist/ is missing. Run the build first.');
    process.exitCode = 1;
    return;
  }

  const files = await walk();
  const sizes = new Map();
  for (const file of files) sizes.set(file, (await stat(path.join(DIST, file))).size);

  // ---- entry point and staged runtime -------------------------------------
  for (const required of [
    'index.html',
    'assets-manifest.json',
    'pyodide/pyodide.mjs',
    'pyodide/pyodide.asm.wasm',
    'pyodide/python_stdlib.zip',
    'pyodide/pyodide-lock.json',
    'data/tables/FactoryBuildingTable.json',
    'examples/demo_blueprint.json',
    'assets/fonts/HarmonyOS_Sans_SC/result.css',
  ]) {
    if (!sizes.has(required)) fail(`缺少产物：${required}`);
  }
  checks.push('entry point, Pyodide runtime and source assets are present');

  // ---- the Pillow wheel and the .py modules must be separate files ---------
  const wheel = files.find(file => file.startsWith('pyodide/') && file.endsWith('.whl'));
  if (!wheel) fail('Pillow wheel 未作为独立文件分发（pyodide/*.whl）');
  const python = files.filter(file => file.startsWith('bake/python/') && file.endsWith('.py'));
  if (python.length < 4) fail(`.py 模块未作为独立文件分发（找到 ${python.length} 个）`);
  checks.push(`Pillow wheel and ${python.length} Python modules ship as separate files`);

  // ---- multi-chunk shape ---------------------------------------------------
  const rootJs = files.filter(file => /^assets\/[^/]+\.js$/.test(file));
  if (rootJs.length < MIN_CHUNKS) {
    fail(`产物只有 ${rootJs.length} 个 JS chunk，少于要求的 ${MIN_CHUNKS} 个（疑似回退为单文件构建）`);
  }
  checks.push(`${rootJs.length} JavaScript chunks emitted (minimum ${MIN_CHUNKS})`);
  if (rootJs.length === 1) fail('只有一个 JS chunk，说明单文件构建方案被重新引入');

  for (const file of rootJs) {
    const size = sizes.get(file);
    if (size > MAX_CHUNK_BYTES) {
      fail(`${file} 体积 ${(size / 1024).toFixed(0)} kB，超过 ${(MAX_CHUNK_BYTES / 1024).toFixed(0)} kB 上限`);
    }
  }
  checks.push(`every chunk is under ${(MAX_CHUNK_BYTES / 1024).toFixed(0)} kB`);

  // ---- no inlined assets ---------------------------------------------------
  const inlinable = files.filter(file => /\.(js|mjs|css|html)$/.test(file) && !file.endsWith('.map'));
  const offenders = [];
  for (const file of inlinable) {
    const text = await readFile(path.join(DIST, file), 'utf8');
    for (const pattern of [/data:image\//, /data:font\//, /data:application\/wasm/, /;base64,[A-Za-z0-9+/]{200}/]) {
      if (pattern.test(text)) offenders.push(`${file} (${pattern})`);
    }
  }
  if (offenders.length) fail(`发现内联资产：\n  ${offenders.join('\n  ')}`);
  checks.push(`${inlinable.length} script/style documents contain no inlined asset payloads`);

  // The manifest must not carry the data it points at; it is a file list.
  const manifest = JSON.parse(await readFile(path.join(DIST, 'assets-manifest.json'), 'utf8'));
  if (!Array.isArray(manifest.files) || !manifest.files.length) fail('assets-manifest.json 没有文件列表');
  for (const entry of manifest.files) {
    if (typeof entry.url !== 'string' || !entry.url) fail(`assets-manifest.json 条目缺少 url：${entry.path}`);
    if (typeof entry.mount !== 'string' || !entry.mount) fail(`assets-manifest.json 条目缺少 mount：${entry.path}`);
  }
  checks.push(`asset manifest lists ${manifest.files.length} files (${(manifest.bytes / 1048576).toFixed(1)} MiB)`);

  // ---- Cloudflare Pages limits --------------------------------------------
  if (files.length > MAX_FILES) fail(`产物 ${files.length} 个文件，超过 Cloudflare Pages 的 ${MAX_FILES} 上限`);
  checks.push(`${files.length} files (Cloudflare Pages limit ${MAX_FILES})`);
  const largest = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0];
  if (largest && largest[1] > MAX_FILE_BYTES) {
    fail(`最大文件 ${largest[0]} 为 ${(largest[1] / 1048576).toFixed(2)} MiB，超过 25 MiB 上限`);
  }
  if (largest) checks.push(`largest file ${largest[0]} at ${(largest[1] / 1048576).toFixed(2)} MiB (limit 25 MiB)`);

  // ---- report --------------------------------------------------------------
  for (const check of checks) console.log(`✓ ${check}`);
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const problem of problems) console.error(`✗ ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n${checks.length} deployment checks passed`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
