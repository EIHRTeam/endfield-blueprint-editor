/**
 * Generates `assets-manifest.json`, the list of static files the baking worker must load into
 * Pyodide's MEMFS.
 *
 * The manifest is data, not code: the worker `fetch`es it, so file names and sizes never inflate a
 * JavaScript chunk and the deployment can be audited without running Python.
 *
 * It also runs as a Vite dev-server middleware, so `vite dev` and `vite build` describe exactly the
 * same tree (modulo the font CSS, which is generated on the fly in dev).
 */
import { readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Where a file is mounted inside Pyodide's virtual filesystem. */
function mountedPath(name) {
  return name.startsWith(PY_PREFIX) ? `/bake/python/${name.slice(PY_PREFIX.length)}` : `/kernel/${name}`;
}

/** Where the browser fetches a file from, which follows the deployed layout. */
function deployedUrl(name) {
  return name.startsWith(PY_PREFIX) ? `bake/python/${name.slice(PY_PREFIX.length)}` : name;
}

/** Prefix marking the Python modules staged outside the kernel tree. */
const PY_PREFIX = 'src/bake/python/';

/** Directories walked recursively. Pyodide and the font chunks are for the browser, not for MEMFS. */
const TREES = [
  'assets/blueprint_source',
  'assets/item',
  'assets/blueprint_presentation',
  'assets/preview_frame',
  'data/tables',
];

/**
 * Individual files handed to Python.
 *
 * Each entry is `[source path in the repository, deployed path in dist/]`. The two differ for the
 * `.py` modules (staged at `bake/python/`) and the font licence (staged at `assets/fonts/`).
 */
const FILES = [
  ['data/icon_audit.json', 'data/icon_audit.json'],
  ['data/building_item_fallbacks.json', 'data/building_item_fallbacks.json'],
  ['examples/demo_blueprint.json', 'examples/demo_blueprint.json'],
];

/**
 * @param {string} root Project root.
 * @param {string} relative Directory relative to the root.
 * @param {string[]} out Accumulator of relative file paths.
 */
async function walk(root, relative, out) {
  const absolute = path.join(root, relative);
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const next = `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      await walk(root, next, out);
    } else if (entry.isFile()) {
      out.push(next);
    }
  }
}

/**
 * Builds the manifest for a project rooted at `root`.
 * @param {string} root Absolute project root.
 * @returns {Promise<{root: string, count: number, bytes: number, files: Array<{path: string, bytes: number, mount: string}>}>}
 */
export async function buildManifest(root) {
  const names = [];
  for (const tree of TREES) {
    if (!existsSync(path.join(root, tree))) throw new Error(`Missing asset tree for the manifest: ${tree}`);
    await walk(root, tree, names);
  }
  for (const [source] of FILES) {
    if (!existsSync(path.join(root, source))) throw new Error(`Missing asset for the manifest: ${source}`);
    names.push(source);
  }

  const python = await readdir(path.join(root, 'src/bake/python'));
  for (const name of python) {
    if (name.endsWith('.py')) names.push(`src/bake/python/${name}`);
  }

  names.sort();

  let total = 0;
  const files = [];
  for (const name of names) {
    const info = await stat(path.join(root, name));
    total += info.size;
    files.push({ path: name, bytes: info.size });
  }

  // The kernel tree is mounted at /kernel preserving its historical relative layout, while the `.py`
  // modules are mounted at /bake/python so `boot.py` can be imported by name. `url` is where the
  // browser fetches the file from, which matches the deployed layout written by the static-assets
  // plugin rather than the repository layout.
  return {
    root: '/kernel',
    count: files.length,
    bytes: total,
    files: files.map(entry => ({
      path: entry.path,
      bytes: entry.bytes,
      mount: mountedPath(entry.path),
      url: deployedUrl(entry.path),
    })),
  };
}

/** Vite plugin that writes and serves `assets-manifest.json`. */
export function createManifestPlugin() {
  const FILE_NAME = 'assets-manifest.json';
  return {
    name: 'endfield:assets-manifest',
    async configureServer(server) {
      // Not an Express route: this is a Vite connect middleware, where an async handler is fine.
      // oxlint-disable-next-line no-async-endpoint-handlers -- see comment above
      server.middlewares.use(async (req, res, next) => {
        if ((req.url ?? '').split('?')[0] !== `/${FILE_NAME}`) return next();
        try {
          const manifest = await buildManifest(server.config.root);
          const body = JSON.stringify(manifest);
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(body);
        } catch (error) {
          res.statusCode = 500;
          res.end(String(error));
        }
      });
    },
    async closeBundle() {
      const root = process.cwd();
      const manifest = await buildManifest(root);
      await writeFile(path.join(root, 'dist', FILE_NAME), `${JSON.stringify(manifest)}\n`);
      this.info(`manifest: ${manifest.count} files, ${(manifest.bytes / 1048576).toFixed(1)} MiB to load into Pyodide`);
    },
  };
}
