// Production build: client bundle -> dist/public, server bundle -> dist/server.js
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { clientOptions, copyStatic, root } from './client-build-options.mjs';

rmSync(resolve(root, 'dist'), { recursive: true, force: true });
copyStatic();
await build({ ...clientOptions, minify: true });
await build({
  entryPoints: [resolve(root, 'server/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: resolve(root, 'dist/server.js'),
  external: ['bufferutil', 'utf-8-validate', 'esbuild'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
