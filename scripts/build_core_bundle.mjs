#!/usr/bin/env node
/**
 * Builds a test-only bundle of the framework-free core.
 *
 * The shipped `core` chunk is tree-shaken down to what the editor calls, so it cannot be used to
 * assert the whole public surface. This rebuilds `src/core/index.ts` as an ES module plus a CJS
 * shim for Node, into `reports/test-artifacts/`, purely for the regression suite.
 */
import { build } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'reports/test-artifacts');

export async function buildCoreBundle() {
  await mkdir(OUT, { recursive: true });
  await build({
    root: ROOT,
    logLevel: 'warn',
    configFile: false,
    build: {
      outDir: 'reports/test-artifacts',
      emptyOutDir: false,
      minify: false,
      target: 'es2022',
      lib: {
        entry: path.join(ROOT, 'src/core/index.ts'),
        formats: ['es'],
        fileName: () => 'core-bundle.mjs',
      },
    },
  });
  const bundle = path.join(OUT, 'core-bundle.mjs');
  // A CJS shim lets the suite `require` the same artifact from plain Node.
  await writeFile(path.join(OUT, 'core-bundle.cjs'), `module.exports = require('./core-bundle.mjs');\n`);
  return bundle;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const bundle = await buildCoreBundle();
  console.log(`[core-bundle] ${path.relative(ROOT, bundle)}`);
}
