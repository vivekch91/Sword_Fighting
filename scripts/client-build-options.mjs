// Shared esbuild options for the browser client.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const publicDir = resolve(root, 'dist/public');

export function copyStatic() {
  mkdirSync(publicDir, { recursive: true });
  cpSync(resolve(root, 'client/static'), publicDir, { recursive: true });
}

export const clientOptions = {
  entryPoints: [resolve(root, 'client/main.ts')],
  bundle: true,
  format: 'esm',
  target: ['es2020', 'chrome90', 'firefox90', 'safari14', 'edge90'],
  outfile: resolve(publicDir, 'app.js'),
  sourcemap: true,
  logLevel: 'info',
};
