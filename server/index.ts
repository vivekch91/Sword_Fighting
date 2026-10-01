// Entry point: serves the built client from dist/public and hosts the game
// WebSocket on the same port. Flags: --dev (rebuild client on change),
// --lag <ms> --jitter <ms> (simulated latency), --port <n>.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DT } from '../shared/constants';
import { attachGateway } from './net';
import { RoomManager } from './rooms';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(v) ? v : def;
};

const DEV = flag('dev');
const PORT = opt('port', Number(process.env.PORT) || 3000);
const LAG = { lagMs: opt('lag', Number(process.env.LAG_MS) || 0), jitterMs: opt('jitter', Number(process.env.JITTER_MS) || 0) };

// dist/server.js (prod) and server/index.ts (dev) both resolve to <repo>/dist/public
const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = existsSync(join(here, 'public')) ? join(here, 'public') : resolve(here, '../dist/public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json',
};

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  let file = resolve(PUBLIC, rel || 'index.html');
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(PUBLIC, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end('Client not built. Run `npm run build` (or `npm run dev`).');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': DEV ? 'no-store' : 'no-cache' });
  createReadStream(file).pipe(res);
}

async function main(): Promise<void> {
  if (DEV) {
    const devModule = '../scripts/devbuild.mjs'; // dev-only, kept out of the prod bundle
    const { startClientWatch } = (await import(devModule)) as { startClientWatch: () => Promise<void> };
    await startClientWatch();
  }

  const rooms = new RoomManager();
  const server = createServer(serveStatic);
  attachGateway(server, rooms, LAG);

  // Fixed-timestep loop (30 Hz) with drift correction.
  const stepMs = DT * 1000;
  let next = performance.now();
  const loop = () => {
    const now = performance.now();
    let steps = 0;
    while (now >= next && steps < 5) {
      rooms.tickAll();
      next += stepMs;
      steps++;
    }
    if (now - next > 250) next = now; // way behind (e.g. machine slept): resync
    setTimeout(loop, Math.max(0, next - performance.now()));
  };
  loop();
  setInterval(() => rooms.sweep(), 2000);

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n⚔  Sword Arena server running${DEV ? ' (dev)' : ''}`);
    console.log(`   Local:   http://localhost:${PORT}`);
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) {
        if (a.family === 'IPv4' && !a.internal) console.log(`   LAN:     http://${a.address}:${PORT}`);
      }
    }
    if (LAG.lagMs || LAG.jitterMs) console.log(`   Simulated latency: ${LAG.lagMs} ms RTT + up to ${LAG.jitterMs} ms jitter each way`);
    console.log('');
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
