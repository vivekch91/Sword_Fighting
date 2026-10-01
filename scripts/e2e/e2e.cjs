// Headless 3-player match driven by simple bots. Usage: node scripts/e2e/e2e.cjs http://localhost:3000 [screenshotDir]
// Requires: npm i -D playwright && npx playwright install chromium
const { chromium } = require('playwright');
const URL = process.argv[2] || 'http://localhost:3100';
const OUT = process.argv[3] || '.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BOT = `
(() => {
  const sa = window.__sa; const canvas = document.getElementById('game');
  const keys = { KeyW:false, KeyA:false, KeyS:false, KeyD:false };
  const setKey = (code, down) => { if (keys[code] === down) return; keys[code] = down; window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code })); };
  window.__stats = { maxErr: 0, frames: 0, jumps: 0 };
  let lastRemote = new Map();
  let t = 0;
  setInterval(() => {
    t++;
    const g = sa.game; const me = g.localPlayer(1);
    const err = Math.hypot(g.errX, g.errY); window.__stats.maxErr = Math.max(window.__stats.maxErr, err);
    const others = g.remotePlayers(performance.now()).filter(p => p.alive);
    for (const o of others) { const l = lastRemote.get(o.id); if (l && Math.hypot(o.x-l.x,o.y-l.y) > 40) window.__stats.jumps++; lastRemote.set(o.id, {x:o.x,y:o.y}); }
    if (!me || !me.alive || !others.length) { for (const k in keys) setKey(k,false); return; }
    let tgt = others[0], best = 1e9;
    for (const o of others) { const d = Math.hypot(o.x-me.x,o.y-me.y); if (d < best) { best = d; tgt = o; } }
    const v = sa.renderer.view; const r = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + v.ox + tgt.x*v.scale, clientY: r.top + v.oy + tgt.y*v.scale }));
    let dx = tgt.x - me.x, dy = tgt.y - me.y;
    window.__hist = window.__hist || []; window.__hist.push({x:me.x,y:me.y}); if (window.__hist.length > 20) window.__hist.shift();
    const h0 = window.__hist[0];
    if (window.__detour > 0) { window.__detour--; [dx, dy] = window.__detourDir; }
    else if (best > 80 && window.__hist.length === 20 && Math.hypot(me.x-h0.x, me.y-h0.y) < 15) { window.__detour = 20; window.__detourDir = Math.random() < 0.5 ? [-dy, dx] : [dy, -dx]; window.__hist = []; }
    setKey('KeyD', dx > 30); setKey('KeyA', dx < -30);
    setKey('KeyS', dy > 30); setKey('KeyW', dy < -30);
    if (best < 95) {
      const roll = Math.random();
      if (roll < 0.25) canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
      else if (roll < 0.28) { canvas.dispatchEvent(new MouseEvent('mousedown', { button: 2 })); setTimeout(() => window.dispatchEvent(new MouseEvent('mouseup', { button: 2 })), 650); }
      else if (roll < 0.30) window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
    }
  }, 50);
})();`;

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const pages = [];
  for (let i = 0; i < 4; i++) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => console.log(`page${i} error:`, e.message));
    p.on('console', (m) => { if (m.type() === 'error') console.log(`page${i} console:`, m.text()); });
    await p.goto(URL);
    pages.push(p);
  }
  const [a, b, c, d] = pages;
  await a.fill('#name', 'Alice'); await a.click('#create');
  await a.waitForSelector('#room:not([hidden])');
  const code = (await a.textContent('#roomCode')).trim();
  console.log('room code', code);
  for (const [p, n] of [[b, 'Bob'], [c, 'Cara']]) { await p.fill('#name', n); await p.fill('#code', code); await p.click('#join'); await p.waitForSelector('#room:not([hidden])'); }
  await d.fill('#name', 'Dan'); await d.fill('#code', code); await d.click('#join'); await sleep(400);
  console.log('4th player error:', await d.textContent('#error'));
  await a.screenshot({ path: `${OUT}/01-lobby.png` });
  for (const p of [a, b, c]) await p.click('#ready');
  await a.waitForSelector('#lobby', { state: 'hidden' });
  console.log('match started');
  // in-progress rejection
  await d.click('#join'); await sleep(400);
  console.log('in-progress error:', await d.textContent('#error'));
  for (const p of [a, b, c]) await p.evaluate(BOT);
  await sleep(2500);
  await a.screenshot({ path: `${OUT}/02-fight.png` });
  let shot = 3;
  const t0 = Date.now();
  let lastRound = 0;
  while (Date.now() - t0 < 150000) {
    const s = await a.evaluate(() => { const l = window.__sa.game.latest; return { phase: l?.phase, round: l?.round, hp: l?.players.map(p => Math.round(p.hp)), fps: window.__sa.renderer.fps }; });
    if (s.round !== lastRound) { console.log(`t=${((Date.now()-t0)/1000).toFixed(0)}s`, JSON.stringify(s)); lastRound = s.round; }
    if (s.phase === 'roundEnd' && shot === 3) { await a.screenshot({ path: `${OUT}/03-roundend.png` }); shot++; }
    if (s.phase === 'matchEnd') { console.log('MATCH END', JSON.stringify(s)); break; }
    await sleep(500);
  }
  await sleep(500);
  await a.screenshot({ path: `${OUT}/04-matchend.png` });
  for (const [i, p] of [a, b, c].entries()) console.log(`page${i} stats`, JSON.stringify(await p.evaluate(() => ({ ...window.__stats, fps: Math.round(window.__sa.renderer.fps), rtt: Math.round(window.__sa.net.rtt) }))));
  // Rematch
  for (const p of [a, b, c]) await p.click('#rematch');
  await sleep(800);
  console.log('after rematch phase:', await a.evaluate(() => window.__sa.game.latest.phase + ' round ' + window.__sa.game.latest.round));
  // Disconnect / rejoin: close Cara's page, reopen and rejoin
  const cctx = c.context();
  await c.close();
  await sleep(1500);
  console.log('after Cara left:', await a.evaluate(() => JSON.stringify(window.__sa.session.room.players.map(p => [p.name, p.connected]))));
  const c2 = await cctx.newPage();
  await c2.goto(`${URL}?room=${code}`);
  await c2.fill('#name', 'Cara'); await c2.click('#join');
  await sleep(1000);
  console.log('Cara rejoined, phase on her page:', await c2.evaluate(() => window.__sa.game.latest?.phase), 'players:', await a.evaluate(() => JSON.stringify(window.__sa.session.room.players.map(p => [p.name, p.connected]))));
  await c2.screenshot({ path: `${OUT}/05-rejoined.png` });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
