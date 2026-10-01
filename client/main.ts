// Client entry: lobby UI, connection lifecycle, fixed-rate input loop, render loop.
import { DT } from '../shared/constants';
import type { RoomInfo, ServerMsg } from '../shared/types';
import { ClientGame } from './game';
import { InputSampler } from './input';
import { Net } from './net';
import { Renderer } from './render';

const TICK_MS = DT * 1000;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('game');
const renderer = new Renderer(canvas);
const sampler = new InputSampler(canvas);
const game = new ClientGame();
const net = new Net();

const ui = {
  lobby: $('lobby'), home: $('home'), room: $('room'), error: $('error'),
  name: $<HTMLInputElement>('name'), code: $<HTMLInputElement>('code'),
  create: $('create'), join: $('join'), roomCode: $('roomCode'), copyLink: $('copyLink'),
  players: $('players'), ready: $('ready'), leave: $('leave'), start2: $('start2'), roomHint: $('roomHint'),
  overlay: $('overlay'), overlayTitle: $('overlayTitle'), overlayText: $('overlayText'),
  rematch: $('rematch'), overlayLeave: $('overlayLeave'), toast: $('toast'),
};

const session = {
  name: '',
  code: '',
  room: null as RoomInfo | null,
  inRoom: false,
  reconnecting: false,
  reconnectTries: 0,
  lastRound: 0,
  lastPhase: '' as string,
};

// ── Persistence (best-effort) ───────────────────────────────────────────────
try { ui.name.value = localStorage.getItem('sa.name') ?? ''; } catch { /* storage unavailable */ }
const urlCode = new URLSearchParams(location.search).get('room');
if (urlCode) ui.code.value = urlCode.toUpperCase();

function saveName(): string {
  const n = ui.name.value.trim();
  try { localStorage.setItem('sa.name', n); } catch { /* ignore */ }
  return n;
}

function showError(msg: string): void {
  ui.error.textContent = msg;
  if (session.room && session.room.phase !== 'lobby') toast(msg);
}

let toastTimer = 0;
function toast(msg: string, ms = 2500): void {
  ui.toast.textContent = msg;
  ui.toast.hidden = false;
  window.clearTimeout(toastTimer);
  if (ms > 0) toastTimer = window.setTimeout(() => (ui.toast.hidden = true), ms);
}

// ── Lobby actions ───────────────────────────────────────────────────────────
ui.create.onclick = () => {
  const name = saveName();
  if (!name) return showError('Please enter a name.');
  session.name = name;
  ui.error.textContent = '';
  net.send({ t: 'create', name });
};
ui.join.onclick = () => {
  const name = saveName();
  const code = ui.code.value.trim().toUpperCase();
  if (!name) return showError('Please enter a name.');
  if (!code) return showError('Enter a room code.');
  session.name = name;
  ui.error.textContent = '';
  net.send({ t: 'join', code, name });
};
ui.code.addEventListener('keydown', (e) => { if (e.key === 'Enter') ui.join.click(); });
ui.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') (ui.code.value ? ui.join : ui.create).click(); });
ui.ready.onclick = () => {
  const me = session.room?.players.find((p) => p.id === game.myId);
  net.send({ t: 'ready', ready: !me?.ready });
};
ui.start2.onclick = () => net.send({ t: 'start2' });
ui.rematch.onclick = () => net.send({ t: 'rematch' });
const leave = () => {
  net.send({ t: 'leave' });
  goHome();
};
ui.leave.onclick = leave;
ui.overlayLeave.onclick = leave;
ui.copyLink.onclick = async () => {
  const link = `${location.origin}${location.pathname}?room=${session.code}`;
  try {
    await navigator.clipboard.writeText(link);
    ui.copyLink.textContent = 'Copied!';
  } catch {
    ui.copyLink.textContent = link;
  }
  setTimeout(() => (ui.copyLink.textContent = 'Copy invite link'), 1500);
};

function goHome(): void {
  session.inRoom = false;
  session.code = '';
  session.room = null;
  game.myId = '';
  game.reset();
  game.phase = 'lobby';
  history.replaceState(null, '', location.pathname);
  render();
}

// ── Server messages ─────────────────────────────────────────────────────────
net.onMessage = (msg: ServerMsg) => {
  switch (msg.t) {
    case 'joined':
      game.myId = msg.you;
      session.code = msg.code;
      session.inRoom = true;
      session.reconnecting = false;
      session.reconnectTries = 0;
      game.reset();
      ui.toast.hidden = true;
      ui.code.value = msg.code;
      history.replaceState(null, '', `?room=${msg.code}`);
      if (msg.rejoined) toast('Rejoined the match!', 1500);
      render();
      break;
    case 'lobby':
      session.room = msg.room;
      if (msg.room.phase === 'lobby' && session.lastPhase !== 'lobby') game.reset();
      game.phase = msg.room.phase;
      session.lastPhase = msg.room.phase;
      render();
      break;
    case 'snap': {
      const now = performance.now();
      if (msg.phase === 'playing' && (msg.round !== session.lastRound)) renderer.banner(`Round ${msg.round} — Fight!`, now);
      session.lastRound = msg.round;
      const phaseChanged = game.latest?.phase !== msg.phase;
      game.onSnapshot(msg, now);
      if (phaseChanged) render();
      break;
    }
    case 'error':
      if (session.reconnecting) {
        session.reconnecting = false;
        goHome();
        ui.toast.hidden = true;
      }
      showError(msg.msg);
      break;
    case 'left':
      break;
  }
};

net.onOpen = () => {
  if (session.reconnecting && session.code && session.name) {
    net.send({ t: 'join', code: session.code, name: session.name });
  }
};

net.onClose = () => {
  if (session.inRoom) {
    session.reconnecting = true;
    session.inRoom = false;
    toast('Connection lost — reconnecting…', 0);
  }
  if (session.reconnecting && ++session.reconnectTries > 20) {
    session.reconnecting = false;
    goHome();
    toast('Could not reconnect to the server.', 4000);
  }
  setTimeout(() => net.connect(), session.reconnecting ? 1500 : 3000);
};

// ── DOM state rendering ─────────────────────────────────────────────────────
function render(): void {
  const room = session.room;
  const inRoom = session.inRoom || session.reconnecting;
  const playing = inRoom && room && room.phase !== 'lobby';
  ui.lobby.hidden = !!playing;
  ui.home.hidden = inRoom;
  ui.room.hidden = !inRoom;
  sampler.enabled = !!playing;
  if (!room || !inRoom) {
    ui.overlay.hidden = true;
    return;
  }

  ui.roomCode.textContent = room.code;
  const me = room.players.find((p) => p.id === game.myId);
  ui.players.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const p = room.players[i];
    const li = document.createElement('li');
    if (!p) {
      li.className = 'empty';
      li.textContent = 'Waiting for player…';
    } else {
      const colors = ['#e8554e', '#4ea3e8', '#f2c14e'];
      li.innerHTML = `<span class="dot" style="background:${colors[p.color % 3]}"></span><span class="nm"></span><span class="st ${p.ready ? 'ok' : ''}">${p.ready ? 'Ready' : 'Not ready'}</span>`;
      (li.querySelector('.nm') as HTMLElement).textContent = `${p.name}${p.id === game.myId ? ' (you)' : ''}${p.id === room.hostId ? ' ★' : ''}`;
    }
    ui.players.appendChild(li);
  }
  ui.ready.textContent = me?.ready ? 'Ready ✓' : 'Ready';
  ui.ready.classList.toggle('on', !!me?.ready);
  ui.start2.hidden = !(room.hostId === game.myId && room.players.length === 2);
  ui.roomHint.textContent = room.players.length < 3
    ? `Share the code — ${3 - room.players.length} more player${room.players.length === 2 ? '' : 's'} needed.`
    : 'Match starts automatically when all 3 are ready.';

  // Match-end overlay
  if (room.phase === 'matchEnd') {
    const snap = game.latest;
    const winner = room.players.find((p) => p.id === snap?.matchWinner);
    ui.overlay.hidden = false;
    ui.overlayTitle.textContent = winner ? (winner.id === game.myId ? '🏆 You win the match!' : `🏆 ${winner.name} wins the match!`) : 'Match over';
    const present = room.players.filter((p) => p.connected);
    const votes = present.filter((p) => p.rematch).length;
    ui.overlayText.textContent = present.length < 2
      ? 'Waiting for another player to rejoin…'
      : `Rematch votes: ${votes}/${present.length}`;
    ui.rematch.textContent = me?.rematch ? 'Waiting…' : 'Rematch';
    (ui.rematch as HTMLButtonElement).disabled = !!me?.rematch;
  } else {
    ui.overlay.hidden = true;
  }
}

// ── Game loop ───────────────────────────────────────────────────────────────
let acc = 0;
let last = performance.now();

function inputTick(): void {
  const p = game.predicted;
  let aim = p?.facing ?? 0;
  if (p) {
    const m = renderer.screenToWorld(sampler.mouseX, sampler.mouseY);
    const lp = game.localPlayer(1)!;
    aim = Math.atan2(m.y - lp.y, m.x - lp.x);
  }
  const input = sampler.sample(++game.seq, aim);
  net.send({ t: 'input', ...input });
  const swingBefore = p?.swingId ?? 0;
  game.applyLocalInput(input);
  const q = game.predicted;
  sampler.consume(!!q && q.action === 'light' && q.swingId !== swingBefore, !!q && q.action === 'dodge' && q.actionTick === 0);
}

function frame(now: number): void {
  const dt = Math.min(250, now - last);
  last = now;
  const active = session.inRoom && net.open && game.simulating;
  if (active) {
    acc += dt;
    let steps = 0;
    while (acc >= TICK_MS && steps < 5) {
      inputTick();
      acc -= TICK_MS;
      steps++;
    }
    if (steps === 5) acc = 0;
  } else acc = 0;

  game.decayError(dt);
  renderer.addEvents(game.takeDueEvents(now), now, game.myId);
  const showWorld = session.room && session.room.phase !== 'lobby' && (session.inRoom || session.reconnecting);
  renderer.draw(
    now,
    showWorld ? session.room : null,
    showWorld ? game.latest : null,
    showWorld ? game.remotePlayers(now) : [],
    showWorld ? game.localPlayer(acc / TICK_MS) : null,
    game.myId,
    net.rtt,
  );
  requestAnimationFrame(frame);
}

net.connect();
render();
requestAnimationFrame(frame);

// Expose a tiny debug hook for automated tests.
(window as unknown as { __sa: unknown }).__sa = { game, session, renderer, net };
