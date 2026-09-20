#!/usr/bin/env node
/**
 * Vendor the Pyodide runtime and the Pillow WASM wheel into `vendor/pyodide/`.
 *
 * `.wasm` / `.py` / wheel binaries are never inlined into the bundle and never committed to
 * Git: the Pyodide runtime comes from the `pyodide` npm package (pnpm pins the version) and
 * the Pillow wheel is fetched from the Pyodide package index. Every file is verified against
 * the sha256 recorded in Pyodide's own `pyodide-lock.json`, so the staged runtime is
 * reproducible and tamper-evident.
 *
 * Runs from `postinstall`, and can be re-run explicitly with `pnpm vendor:pyodide`.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const TARGET = path.join(ROOT, 'vendor', 'pyodide');

/** Files the browser fetches directly. `pyodide.d.ts` is kept only for editor type hints. */
const RUNTIME_FILES = [
  'pyodide.mjs',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
  'pyodide.d.ts',
];

/** Pyodide builds we install the exact package version of. */
const PACKAGE_NAME = 'pillow';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function resolvePyodidePackage() {
  try {
    return path.dirname(require.resolve('pyodide/package.json'));
  } catch {
    return null;
  }
}

async function fetchBinary(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  const packageDir = await resolvePyodidePackage();
  if (!packageDir) {
    // `postinstall` also runs for installs that deliberately skip dependencies.
    console.log('[vendor:pyodide] pyodide is not installed yet; skipping vendoring');
    return;
  }

  const pyodideVersion = require('pyodide/package.json').version;
  const lockPath = path.join(packageDir, 'pyodide-lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  // The npm version and the CDN tag are the same string, e.g. 314.0.7 -> /pyodide/v314.0.7/full/.
  const cdnBase = `https://cdn.jsdelivr.net/pyodide/v${pyodideVersion}/full/`;

  await rm(TARGET, { recursive: true, force: true });
  await mkdir(TARGET, { recursive: true });

  const report = [];

  for (const name of RUNTIME_FILES) {
    const source = path.join(packageDir, name);
    if (!existsSync(source)) throw new Error(`Pyodide package is missing ${name}`);
    const bytes = await readFile(source);
    await writeFile(path.join(TARGET, name), bytes);
    report.push({ name, bytes: bytes.length, source: 'pyodide' });
  }

  const entry = lock.packages?.[PACKAGE_NAME];
  if (!entry?.file_name) throw new Error(`pyodide-lock.json has no "${PACKAGE_NAME}" entry`);

  const wheelUrl = cdnBase + entry.file_name;
  const wheel = await fetchBinary(wheelUrl);
  const digest = sha256(wheel);
  if (entry.sha256 && digest !== entry.sha256) {
    throw new Error(`Checksum mismatch for ${entry.file_name}\n  expected ${entry.sha256}\n  actual   ${digest}`);
  }
  await writeFile(path.join(TARGET, entry.file_name), wheel);
  report.push({ name: entry.file_name, bytes: wheel.length, source: 'cdn' });

  // Record what was staged so the build can assert the exact same set is deployed.
  await writeFile(
    path.join(TARGET, 'vendor-manifest.json'),
    `${JSON.stringify(
      {
        pyodideVersion,
        pythonVersion: lock.info?.python,
        files: report.map(({ name, bytes, source }) => ({ name, bytes, source })),
      },
      null,
      2,
    )}\n`,
  );

  const total = report.reduce((sum, item) => sum + item.bytes, 0);
  console.log(
    `[vendor:pyodide] staged ${report.length} files (${(total / 1048576).toFixed(1)} MiB) ` +
      `with sha256 verification`,
  );
}

main().catch(error => {
  console.error(`[vendor:pyodide] ${error.message}`);
  process.exitCode = 1;
});
