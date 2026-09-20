import path from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createManifestPlugin } from './scripts/manifest_plugin.mjs';
import { createStaticAssetsPlugin } from './scripts/static_assets_plugin.mjs';

/**
 * The runtime static tree is staged by `createStaticAssetsPlugin` (build) and served from the
 * repository by `devStaticAssets` (dev). No glob-copy plugin is involved: the deployed layout is part
 * of the contract because Python reads these exact paths out of its virtual filesystem.
 */

/**
 * Dev-only bridge so `vite dev` can serve the staged tree without copying it into the repository.
 * Paths mirror the production layout exactly, which keeps runtime URL building identical.
 */
function devStaticAssets(): Plugin {
  const roots = [
    { prefix: '/assets/', dir: 'assets' },
    { prefix: '/data/', dir: 'data' },
    { prefix: '/examples/', dir: 'examples' },
    { prefix: '/bake/python/', dir: 'src/bake/python' },
    { prefix: '/pyodide/', dir: 'vendor/pyodide' },
  ];
  return {
    name: 'endfield:dev-static-assets',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = (request.url ?? '').split('?')[0];
        const root = roots.find(entry => url.startsWith(entry.prefix));
        if (!root) return next();
        const relative = decodeURIComponent(url.slice(root.prefix.length));
        if (relative.includes('..')) return next();
        const target = path.join(server.config.root, root.dir, relative);
        void serveFile(target, url, response, next);
      });
    },
  };
}

/** Serves one file, rewriting the font stylesheet's `local()` fallback on the fly. */
async function serveFile(
  target: string,
  url: string,
  response: import('node:http').ServerResponse,
  next: () => void,
): Promise<void> {
  const fs = await import('node:fs/promises');
  const info = await fs.stat(target).catch(() => null);
  if (!info?.isFile()) return next();

  const types: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
    '.wasm': 'application/wasm',
    '.whl': 'application/octet-stream',
    '.zip': 'application/zip',
    '.py': 'text/x-python; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
  };
  const extension = url.slice(url.lastIndexOf('.'));
  const type = types[extension] ?? 'application/octet-stream';
  const body = await fs.readFile(target);
  const text =
    extension === '.css' ? body.toString('utf8').replace(/src:local\("HarmonyOS Sans SC"\),/g, 'src:') : null;
  response.setHeader('Content-Type', type);
  response.setHeader('Content-Length', text === null ? body.length : Buffer.byteLength(text));
  response.end(text ?? body);
}

export default defineConfig({
  plugins: [
    // React Compiler runs through @vitejs/plugin-react's `compiler` option.
    react({ compiler: { logDiagnostics: true } }),
    createStaticAssetsPlugin(),
    devStaticAssets(),
    createManifestPlugin(),
  ],
  build: {
    // Never inline any asset as a data URL. A multi-chunk ES module output is a hard requirement,
    // so `vite-plugin-singlefile` / `build.lib` are deliberately not used either.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 450,
    rolldownOptions: {
      output: {
        // Vite 8 is Rolldown-based: `output.manualChunks` no longer accepts the object form.
        // `codeSplitting.groups` is the supported replacement.
        codeSplitting: {
          groups: [
            { name: 'vendor-react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'vendor-runtime', test: /react[\\/]compiler-runtime/ },
            { name: 'core', test: /src[\\/](core|render)[\\/]/ },
          ],
        },
      },
    },
    sourcemap: true,
  },
});
