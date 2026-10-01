// Measures prediction error + remote smoothness. Start server with: npm run build && node dist/server.js --lag 100 --jitter 30
// Usage: node scripts/e2e/lag.cjs http://localhost:3000   (requires playwright, see e2e.cjs)
const { chromium } = require('playwright');
const URL = process.argv[2]; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const mk = async () => { const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage(); p.on('pageerror', e => console.log('err', e.message)); await p.goto(URL); return p; };
  const a = await mk(), b = await mk();
  await a.fill('#name', 'Walker'); await a.click('#create'); await a.waitForSelector('#room:not([hidden])');
  const code = (await a.textContent('#roomCode')).trim();
  await b.fill('#name', 'Watcher'); await b.fill('#code', code); await b.click('#join'); await b.waitForSelector('#room:not([hidden])');
  await a.click('#start2'); await a.waitForSelector('#lobby', { state: 'hidden' });
  await sleep(1500);
  // Watcher measures remote smoothness of Walker every animation frame
  await b.evaluate(() => {
    window.__m = { maxStep: 0, maxSpeed: 0, frames: 0, stalls: 0 }; let last = null, lt = 0;
    const f = (now) => { const o = window.__sa.game.remotePlayers(now)[0]; if (o && last) { const d = Math.hypot(o.x-last.x, o.y-last.y); const dt = now - lt; window.__m.maxStep = Math.max(window.__m.maxStep, d); if (dt > 0) window.__m.maxSpeed = Math.max(window.__m.maxSpeed, d / dt * 1000); window.__m.frames++; } if (o) last = { x: o.x, y: o.y }; lt = now; requestAnimationFrame(f); };
    requestAnimationFrame(f);
  });
  await a.evaluate(() => {
    window.__m = { maxErr: 0, corrections: 0 }; const g = window.__sa.game;
    const f = () => { const e = Math.hypot(g.errX, g.errY); if (e > 0.5) window.__m.corrections++; window.__m.maxErr = Math.max(window.__m.maxErr, e); requestAnimationFrame(f); }; requestAnimationFrame(f);
  });
  const moves = ['KeyD', 'KeyS', 'KeyA', 'KeyW', 'KeyD'];
  for (const k of moves) { await a.keyboard.down(k); await sleep(900); if (k === 'KeyS') { await a.keyboard.press('Space'); } await a.keyboard.up(k); }
  await a.keyboard.down('KeyD'); await a.keyboard.down('ShiftLeft'); await sleep(800); await a.keyboard.up('ShiftLeft'); await a.keyboard.up('KeyD');
  await sleep(500);
  console.log('walker (prediction):', JSON.stringify(await a.evaluate(() => ({ ...window.__m, rtt: Math.round(window.__sa.net.rtt), pending: window.__sa.game.pending.length }))));
  console.log('watcher (interpolation):', JSON.stringify(await b.evaluate(() => window.__m)));
  await a.screenshot({ path: 'lag.png' });
  await browser.close();
})();
