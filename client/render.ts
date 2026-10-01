// Canvas 2D renderer: arena, fighters, effects, HUD.
import {
  ARENA_H, ARENA_W, BLOCK_ARC, DODGE, HEAVY, LIGHT, MAX_HP, MAX_STAMINA, OBSTACLES, PLAYER_COLORS,
  PLAYER_RADIUS, ROUNDS_TO_WIN, TICK_RATE,
} from '../shared/constants';
import { activeSwing } from '../shared/combat';
import { HEAVY_TOTAL, LIGHT_TOTAL } from '../shared/sim';
import type { HitEvent, LobbyPlayer, PlayerSim, RoomInfo, SnapshotMsg } from '../shared/types';

interface Floater { x: number; y: number; text: string; color: string; born: number; size: number }
interface Spark { x: number; y: number; vx: number; vy: number; born: number; color: string }

export interface View { scale: number; ox: number; oy: number; cssW: number; cssH: number }

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private floor: HTMLCanvasElement;
  private floaters: Floater[] = [];
  private sparks: Spark[] = [];
  private flashes = new Map<string, number>(); // id -> time of last hit
  view: View = { scale: 1, ox: 0, oy: 0, cssW: 0, cssH: 0 };
  private fpsFrames = 0;
  private fpsT = 0;
  fps = 0;
  private bannerText = '';
  private bannerAt = -1e9;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.floor = this.buildFloor();
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth, h = window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    const margin = 70; // room for HUD
    const scale = Math.min(w / (ARENA_W + 40), (h - margin) / (ARENA_H + 40));
    this.view = { scale, ox: (w - ARENA_W * scale) / 2, oy: (h - ARENA_H * scale) / 2 + 10, cssW: w, cssH: h };
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const v = this.view;
    return { x: (sx - v.ox) / v.scale, y: (sy - v.oy) / v.scale };
  }

  banner(text: string, now: number): void {
    this.bannerText = text;
    this.bannerAt = now;
  }

  private buildFloor(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = ARENA_W;
    c.height = ARENA_H;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(ARENA_W / 2, ARENA_H / 2, 50, ARENA_W / 2, ARENA_H / 2, ARENA_W * 0.7);
    grd.addColorStop(0, '#3a3f4b');
    grd.addColorStop(1, '#262a33');
    g.fillStyle = grd;
    g.fillRect(0, 0, ARENA_W, ARENA_H);
    g.strokeStyle = 'rgba(255,255,255,0.04)';
    g.lineWidth = 1;
    for (let x = 0; x <= ARENA_W; x += 50) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, ARENA_H); g.stroke(); }
    for (let y = 0; y <= ARENA_H; y += 50) { g.beginPath(); g.moveTo(0, y); g.lineTo(ARENA_W, y); g.stroke(); }
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    g.lineWidth = 3;
    g.beginPath(); g.arc(ARENA_W / 2, ARENA_H / 2, 260, 0, Math.PI * 2); g.stroke();
    for (const o of OBSTACLES) {
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(o.x + 6, o.y + 8, o.w, o.h);
      g.fillStyle = '#596173';
      g.fillRect(o.x, o.y, o.w, o.h);
      g.fillStyle = '#6b7488';
      g.fillRect(o.x, o.y, o.w, 6);
      g.strokeStyle = '#2b2f38';
      g.lineWidth = 2;
      g.strokeRect(o.x + 1, o.y + 1, o.w - 2, o.h - 2);
    }
    g.strokeStyle = '#8a93a8';
    g.lineWidth = 6;
    g.strokeRect(3, 3, ARENA_W - 6, ARENA_H - 6);
    return c;
  }

  addEvents(events: HitEvent[], now: number, myId: string): void {
    for (const e of events) {
      const color = e.blocked ? '#9fd3ff' : e.heavy ? '#ff7a59' : '#ffffff';
      const text = e.blocked ? `BLOCK ${fmt(e.damage)}` : `-${fmt(e.damage)}`;
      this.floaters.push({ x: e.x, y: e.y - 30, text, color, born: now, size: e.heavy ? 26 : 19 });
      if (e.stagger) this.floaters.push({ x: e.x, y: e.y - 58, text: 'STAGGER!', color: '#ffd84e', born: now, size: 20 });
      if (e.killed) this.floaters.push({ x: e.x, y: e.y - 60, text: e.target === myId ? 'YOU DIED' : 'KO!', color: '#ff4e4e', born: now, size: 30 });
      this.flashes.set(e.target, now);
      const n = e.heavy ? 14 : 8;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, s = 80 + Math.random() * 220;
        this.sparks.push({ x: e.x, y: e.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, born: now, color: e.blocked ? '#bfe6ff' : '#ffd36b' });
      }
    }
  }

  draw(now: number, room: RoomInfo | null, snap: SnapshotMsg | null, players: PlayerSim[], me: PlayerSim | null, myId: string, rtt: number): void {
    const ctx = this.ctx, v = this.view;
    this.fpsFrames++;
    if (now - this.fpsT >= 500) { this.fps = (this.fpsFrames * 1000) / (now - this.fpsT); this.fpsFrames = 0; this.fpsT = now; }

    ctx.fillStyle = '#14161b';
    ctx.fillRect(0, 0, v.cssW, v.cssH);

    ctx.save();
    ctx.translate(v.ox, v.oy);
    ctx.scale(v.scale, v.scale);
    ctx.drawImage(this.floor, 0, 0);

    const info = new Map<string, LobbyPlayer>((room?.players ?? []).map((p) => [p.id, p]));
    const all = me ? [...players, me] : players;
    // Dead first, then living (living drawn on top)
    all.sort((a, b) => Number(a.alive) - Number(b.alive));
    for (const p of all) this.drawFighter(p, info.get(p.id), p.id === myId, now);

    this.drawEffects(now);
    ctx.restore();

    this.drawHud(now, room, snap, me, myId, rtt, info);
  }

  private drawFighter(p: PlayerSim, lp: LobbyPlayer | undefined, isMe: boolean, now: number): void {
    const ctx = this.ctx;
    const color = PLAYER_COLORS[(lp?.color ?? 0) % PLAYER_COLORS.length];
    const r = PLAYER_RADIUS;
    ctx.save();
    ctx.translate(p.x, p.y);

    if (!p.alive) {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#555';
      circle(ctx, 0, 0, r);
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(-10, -10); ctx.lineTo(10, 10); ctx.moveTo(10, -10); ctx.lineTo(-10, 10); ctx.stroke();
      ctx.globalAlpha = 0.6;
      this.label(lp?.name ?? '?', 0, -r - 10, '#aaa');
      ctx.restore();
      return;
    }

    // Heavy telegraph: growing red wedge + "!"
    if (p.action === 'heavyCharge') {
      const k = Math.min(1, p.actionTick / HEAVY.charge);
      ctx.fillStyle = `rgba(255,60,40,${0.12 + 0.18 * k})`;
      wedge(ctx, p.facing, HEAVY.range + r, HEAVY.arc);
      ctx.strokeStyle = `rgba(255,90,60,${0.5 + 0.5 * k})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, (HEAVY.range + r) * k, p.facing - HEAVY.arc / 2, p.facing + HEAVY.arc / 2); ctx.stroke();
      ctx.fillStyle = '#ff4e3a';
      ctx.font = 'bold 22px system-ui, sans-serif';
      ctx.textAlign = 'center';
      if (Math.floor(now / 90) % 2 === 0 || k > 0.8) ctx.fillText('!', 0, -r - 26);
    }

    // Active swing arc (the real hitbox shape)
    const sw = activeSwing(p);
    if (sw) {
      ctx.fillStyle = sw.heavy ? 'rgba(255,140,90,0.35)' : 'rgba(255,255,255,0.22)';
      wedge(ctx, p.facing, sw.spec.range + r, sw.spec.arc);
    }

    // Dodge ghost trail
    if (p.action === 'dodge') {
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = color;
      circle(ctx, -p.dodgeDx * 18, -p.dodgeDy * 18, r);
      circle(ctx, -p.dodgeDx * 34, -p.dodgeDy * 34, r * 0.9);
      ctx.globalAlpha = p.actionTick < DODGE.iframes ? 0.55 : 0.85;
    }

    // Sword
    this.drawSword(p, color);

    // Body
    const flash = this.flashes.get(p.id);
    const flashing = flash !== undefined && now - flash < 120;
    ctx.fillStyle = flashing ? '#ffffff' : color;
    circle(ctx, 0, 0, r);
    ctx.lineWidth = 3;
    ctx.strokeStyle = isMe ? '#ffffff' : 'rgba(0,0,0,0.5)';
    ctx.stroke();
    // Face direction marker
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    circle(ctx, Math.cos(p.facing) * 10, Math.sin(p.facing) * 10, 5);
    ctx.globalAlpha = 1;

    // Shield
    if (p.blocking) {
      ctx.strokeStyle = 'rgba(160,215,255,0.95)';
      ctx.lineWidth = 6;
      ctx.beginPath(); ctx.arc(0, 0, r + 7, p.facing - BLOCK_ARC / 2, p.facing + BLOCK_ARC / 2); ctx.stroke();
    }

    // Stun / stagger stars
    if (p.action === 'stun' || p.action === 'stagger') {
      ctx.fillStyle = p.action === 'stagger' ? '#ffd84e' : '#ffffff';
      for (let i = 0; i < 3; i++) {
        const a = now / 150 + (i * Math.PI * 2) / 3;
        circle(ctx, Math.cos(a) * 16, -r - 6 + Math.sin(a) * 5, 3);
      }
    }

    // Label + HP (HP bar above others; own HP lives in the HUD)
    this.label(isMe ? `${lp?.name ?? 'You'} (you)` : lp?.name ?? '?', 0, -r - (isMe ? 12 : 22), isMe ? '#fff' : '#e8e8e8');
    if (!isMe) {
      const w = 46, h = 6, y = -r - 16;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(-w / 2 - 1, y - 1, w + 2, h + 2);
      ctx.fillStyle = hpColor(p.hp / MAX_HP);
      ctx.fillRect(-w / 2, y, (w * p.hp) / MAX_HP, h);
    }
    ctx.restore();
  }

  private drawSword(p: PlayerSim, color: string): void {
    const ctx = this.ctx;
    let rel = 1.0; // angle relative to facing
    let len = 36;
    if (p.action === 'light') {
      const t = p.actionTick;
      const half = LIGHT.arc / 2;
      if (t < LIGHT.windup) rel = 1.0 + 0.4 * (t / LIGHT.windup);
      else if (t < LIGHT.windup + LIGHT.active) rel = half + 0.4 - ((t - LIGHT.windup + 1) / LIGHT.active) * (LIGHT.arc + 0.4);
      else rel = -half + ((t - LIGHT.windup - LIGHT.active) / (LIGHT_TOTAL - LIGHT.windup - LIGHT.active)) * (half + 1);
      len = 44;
    } else if (p.action === 'heavyCharge') {
      rel = 1.2 + 1.2 * Math.min(1, p.actionTick / HEAVY.charge);
      len = 50;
    } else if (p.action === 'heavy') {
      const t = p.actionTick;
      const half = HEAVY.arc / 2;
      rel = t < HEAVY.active ? half + 0.6 - ((t + 1) / HEAVY.active) * (HEAVY.arc + 0.6) : -half - 0.2 + ((t - HEAVY.active) / (HEAVY_TOTAL - HEAVY.active)) * (half + 1.2);
      len = 52;
    } else if (p.blocking) {
      rel = 0.35;
      len = 30;
    } else if (p.action === 'stun' || p.action === 'stagger') {
      rel = 2.2;
    }
    const a = p.facing + rel;
    const hx = Math.cos(p.facing + 0.9) * 14, hy = Math.sin(p.facing + 0.9) * 14;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx + Math.cos(a) * len, hy + Math.sin(a) * len); ctx.stroke();
    ctx.strokeStyle = '#e6edf5';
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(hx + Math.cos(a) * 6, hy + Math.sin(a) * 6); ctx.lineTo(hx + Math.cos(a) * len, hy + Math.sin(a) * len); ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(hx + Math.cos(a + Math.PI / 2) * 6, hy + Math.sin(a + Math.PI / 2) * 6);
    ctx.lineTo(hx + Math.cos(a - Math.PI / 2) * 6, hy + Math.sin(a - Math.PI / 2) * 6);
    ctx.stroke();
  }

  private drawEffects(now: number): void {
    const ctx = this.ctx;
    this.sparks = this.sparks.filter((s) => now - s.born < 350);
    for (const s of this.sparks) {
      const t = (now - s.born) / 1000;
      ctx.globalAlpha = 1 - (now - s.born) / 350;
      ctx.fillStyle = s.color;
      ctx.fillRect(s.x + s.vx * t - 2, s.y + s.vy * t - 2, 4, 4);
    }
    this.floaters = this.floaters.filter((f) => now - f.born < 900);
    ctx.textAlign = 'center';
    for (const f of this.floaters) {
      const k = (now - f.born) / 900;
      ctx.globalAlpha = 1 - k * k;
      ctx.font = `bold ${f.size}px system-ui, sans-serif`;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(f.text, f.x, f.y - k * 40);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y - k * 40);
    }
    ctx.globalAlpha = 1;
  }

  private drawHud(now: number, room: RoomInfo | null, snap: SnapshotMsg | null, me: PlayerSim | null, myId: string, rtt: number, info: Map<string, LobbyPlayer>): void {
    const ctx = this.ctx, v = this.view;
    ctx.textBaseline = 'middle';

    // Own bars (bottom-left)
    if (me) {
      const x = 20, y = v.cssH - 64, w = Math.min(280, v.cssW * 0.35);
      bar(ctx, x, y, w, 20, me.hp / MAX_HP, hpColor(me.hp / MAX_HP), `HP ${Math.ceil(me.hp)}`);
      bar(ctx, x, y + 26, w, 14, me.stamina / MAX_STAMINA, me.stamina < LIGHT.cost ? '#a06a2a' : '#3fc27a', `Stamina ${Math.floor(me.stamina)}`);
      const ready = me.dodgeCd === 0 && me.action !== 'dodge';
      ctx.fillStyle = ready ? '#bfe6ff' : '#55606f';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(ready ? 'Dodge ready' : `Dodge ${(me.dodgeCd / TICK_RATE).toFixed(1)}s`, x + w + 12, y + 33);
    }

    // Round / scores (top-centre)
    if (room && snap) {
      ctx.textAlign = 'center';
      ctx.font = 'bold 16px system-ui, sans-serif';
      ctx.fillStyle = '#ddd';
      ctx.fillText(`Round ${snap.round}  ·  first to ${ROUNDS_TO_WIN}`, v.cssW / 2, 18);
      const parts = room.players;
      const slot = 150;
      parts.forEach((p, i) => {
        const cx = v.cssW / 2 + (i - (parts.length - 1) / 2) * slot;
        ctx.fillStyle = PLAYER_COLORS[p.color % PLAYER_COLORS.length];
        circle(ctx, cx - 50, 42, 6);
        ctx.textAlign = 'left';
        ctx.font = `${p.id === myId ? 'bold ' : ''}14px system-ui, sans-serif`;
        ctx.fillStyle = p.connected ? '#eee' : '#777';
        ctx.fillText(trim(p.name, 9), cx - 40, 42);
        for (let w = 0; w < ROUNDS_TO_WIN; w++) {
          ctx.fillStyle = w < p.wins ? '#ffd84e' : 'rgba(255,255,255,0.15)';
          circle(ctx, cx + 38 + w * 12, 42, 4);
        }
      });
    }

    // Ping + FPS (top-right)
    ctx.textAlign = 'right';
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillStyle = rtt < 80 ? '#5fd38a' : rtt < 160 ? '#e7c35a' : '#e8665a';
    ctx.fillText(`Ping ${Math.round(rtt)} ms`, v.cssW - 16, 18);
    ctx.fillStyle = '#888';
    ctx.fillText(`${Math.round(this.fps)} fps`, v.cssW - 16, 36);

    // Centre messages
    let msg = '';
    let sub = '';
    if (snap?.phase === 'roundEnd') {
      const w = snap.roundWinner ? info.get(snap.roundWinner) : null;
      msg = w ? (w.id === myId ? 'You win the round!' : `${w.name} wins the round!`) : 'Draw!';
      sub = `Next round in ${Math.ceil(snap.phaseTicks / TICK_RATE)}…`;
    } else if (snap?.phase === 'playing' && me && !me.alive) {
      msg = 'Eliminated';
      sub = 'Spectating until the round ends';
    } else if (snap?.phase === 'playing' && !me && myId) {
      sub = 'Spectating — you will join next round';
    }
    const bannerAge = now - this.bannerAt;
    if (!msg && bannerAge < 1400) {
      ctx.globalAlpha = Math.min(1, (1400 - bannerAge) / 400);
      msg = this.bannerText;
    }
    if (msg || sub) {
      ctx.textAlign = 'center';
      if (msg) {
        ctx.font = 'bold 42px system-ui, sans-serif';
        ctx.lineWidth = 6;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.strokeText(msg, v.cssW / 2, v.cssH / 2 - 20);
        ctx.fillStyle = '#fff';
        ctx.fillText(msg, v.cssW / 2, v.cssH / 2 - 20);
      }
      if (sub) {
        ctx.font = '18px system-ui, sans-serif';
        ctx.fillStyle = '#ddd';
        ctx.fillText(sub, v.cssW / 2, v.cssH / 2 + 22);
      }
      ctx.globalAlpha = 1;
    }
    ctx.textBaseline = 'alphabetic';
  }

  private label(text: string, x: number, y: number, color: string): void {
    const ctx = this.ctx;
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }
}

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function wedge(ctx: CanvasRenderingContext2D, facing: number, radius: number, arc: number): void {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, radius, facing - arc / 2, facing + arc / 2);
  ctx.closePath();
  ctx.fill();
}

function bar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, frac: number, color: string, text: string): void {
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
  ctx.fillStyle = '#2b2f38';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w * Math.max(0, Math.min(1, frac)), h);
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.max(10, h - 6)}px system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillText(text, x + 6, y + h / 2 + 1);
}

function hpColor(f: number): string {
  return f > 0.6 ? '#4fcf6f' : f > 0.3 ? '#e7c35a' : '#e8554e';
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function trim(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
