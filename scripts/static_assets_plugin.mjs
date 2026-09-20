/**
 * Copies the runtime static tree into the build output.
 *
 * Written explicitly rather than configured through a glob-copy plugin because the deployed layout is
 * part of the contract: Python reads these exact paths out of its virtual filesystem, and the font CSS
 * is rewritten during the copy. An explicit list makes the output auditable and keeps `vite dev`
 * (which serves the same tree from the repository through middleware) in step with the build.
 */
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Directories copied into the output, preserving their repository-relative layout. */
const TREES = [
  ['assets/blueprint_source', 'assets/blueprint_source'],
  ['assets/item', 'assets/item'],
  ['assets/blueprint_presentation', 'assets/blueprint_presentation'],
  ['assets/preview_frame', 'assets/preview_frame'],
  ['data/tables', 'data/tables'],
];

/** Individual files: [source, output directory]. */
const FILES = [
  ['data/icon_audit.json', 'data'],
  ['data/building_item_fallbacks.json', 'data'],
  ['examples/demo_blueprint.json', 'examples'],
  ['examples/environment_ports.json', 'examples'],
  ['examples/native_effects.json', 'examples'],
  ['assets/fonts/LICENSE-update.txt', 'assets/fonts'],
];

/**
 * `src:local(...)` must be stripped: the shipped `cn-font-split` chunks have to be authoritative,
 * otherwise an installed system copy of HarmonyOS Sans silently changes the rendering and the exports.
 */
const STRIP_LOCAL_SOURCE = /src:local\("HarmonyOS Sans SC"\),/g;

/** Files in the font directory the browser never loads, plus the 19.66 MiB original TTF. */
const SKIP_FONT_FILES = new Set(['HarmonyOS_Sans_SC.ttf', 'index.html', 'index.proto', 'reporter.bin']);

async function copyDirectory(root, outDir, source) {
  const from = path.join(root, source);
  if (!existsSync(from)) throw new Error(`Missing runtime asset tree: ${source}`);
  const to = path.join(outDir, source);
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
}

async function copyIndividualFile(root, outDir, source) {
  const from = path.join(root, source);
  if (!existsSync(from)) throw new Error(`Missing runtime asset file: ${source}`);
  const to = path.join(outDir, source);
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to);
}

/** Copies the woff2 chunks and writes the stripped stylesheet next to them. */
async function stageFonts(root, outDir) {
  const source = 'assets/fonts/HarmonyOS_Sans_SC';
  const from = path.join(root, source);
  if (!existsSync(from)) throw new Error(`Missing font chunks: ${source}`);
  const to = path.join(outDir, source);
  await mkdir(to, { recursive: true });

  const css = await readFile(path.join(from, 'result.css'), 'utf8');
  const stripped = css.replace(STRIP_LOCAL_SOURCE, 'src:');
  if (/local\(/.test(stripped)) {
    throw new Error('Font CSS still references a local() source; the shipped chunks must be authoritative');
  }
  await writeFile(path.join(to, 'result.css'), stripped);

  let chunks = 0;
  for (const entry of await readdir(from)) {
    if (SKIP_FONT_FILES.has(entry) || entry.endsWith('.css') || entry.endsWith('.json')) continue;
    await cp(path.join(from, entry), path.join(to, entry));
    chunks++;
  }
  if (!chunks) throw new Error('No font chunks were staged');
  return { chunks, css: stripped.length };
}

/** Copies the vendored Pyodide runtime and the Pillow wheel. */
async function stagePyodide(root, outDir) {
  const source = 'vendor/pyodide';
  const from = path.join(root, source);
  if (!existsSync(from)) throw new Error('Missing vendor/pyodide. Run: pnpm vendor:pyodide');
  const to = path.join(outDir, 'pyodide');
  await mkdir(to, { recursive: true });
  await cp(from, to, { recursive: true });

  for (const name of ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) {
    if (!existsSync(path.join(to, name))) throw new Error(`vendor/pyodide is missing ${name}`);
  }
  const lock = JSON.parse(await readFile(path.join(to, 'pyodide-lock.json'), 'utf8'));
  const wheel = lock.packages?.pillow?.file_name;
  if (!wheel || !existsSync(path.join(to, wheel))) {
    throw new Error(`Pillow wheel is not staged next to pyodide-lock.json (expected ${wheel ?? 'pillow'})`);
  }
  return { wheel };
}

/** Copies the Python baking modules into their own namespace path. */
async function stagePython(root, outDir) {
  const source = 'src/bake/python';
  const from = path.join(root, source);
  if (!existsSync(from)) throw new Error(`Missing ${source}`);
  const to = path.join(outDir, 'bake/python');
  await mkdir(to, { recursive: true });
  await cp(from, to, { recursive: true });
  return (await readdir(to)).filter(name => name.endsWith('.py')).sort();
}

/**
 * Vite plugin: stage the whole runtime tree after the bundle is written.
 *
 * `closeBundle` runs after Vite has emptied and populated the output directory, so staging here
 * cannot be clobbered. The dev server serves the same paths from the repository through middleware
 * configured in `vite.config.ts`.
 */
export function createStaticAssetsPlugin() {
  return {
    name: 'endfield:static-assets',
    apply: 'build',
    async closeBundle() {
      const root = process.cwd();
      const outDir = path.resolve(root, 'dist');
      await mkdir(outDir, { recursive: true });

      for (const [source] of TREES) await copyDirectory(root, outDir, source);
      for (const [source] of FILES) await copyIndividualFile(root, outDir, source);

      const fonts = await stageFonts(root, outDir);
      const python = await stagePython(root, outDir);
      const pyodide = await stagePyodide(root, outDir);

      this.info(`staged ${fonts.chunks} font chunks, ${python.length} python modules, pillow wheel ${pyodide.wheel}`);
    },
  };
}
