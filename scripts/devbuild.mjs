// Used by `npm run dev`: rebuilds the client bundle on every change.
import { context } from 'esbuild';
import { watch } from 'node:fs';
import { resolve } from 'node:path';
import { clientOptions, copyStatic, root } from './client-build-options.mjs';

let ctx;
export async function startClientWatch() {
  copyStatic();
  watch(resolve(root, 'client/static'), () => copyStatic());
  ctx ??= await context({ ...clientOptions, logLevel: 'warning' });
  await ctx.rebuild();
  await ctx.watch();
  console.log('   Client: watching client/ and shared/ for changes (refresh the browser after edits)');
}
