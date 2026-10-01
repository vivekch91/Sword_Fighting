// Deterministic per-player simulation step. Runs on the server (authoritative)
// and on the client (prediction of the local player). Must stay pure: same
// state + same input => same result on every machine.
import {
  ARENA_H, ARENA_W, BLOCK_DRAIN, BLOCK_SPEED_MULT, DODGE, DT, HEAVY, HEAVY_CHARGE_SPEED_MULT,
  HEAVY_SPEED_MULT, KNOCKBACK_DECAY, LIGHT, LIGHT_SPEED_MULT, MAX_HP, MAX_STAMINA, MOVE_SPEED,
  OBSTACLES, PLAYER_RADIUS, STAMINA_REGEN, STAMINA_REGEN_DELAY, type Rect,
} from './constants';
import type { InputCmd, PlayerSim } from './types';

export function createPlayer(id: string, x: number, y: number, facing = 0): PlayerSim {
  return {
    id, x, y, facing, hp: MAX_HP, stamina: MAX_STAMINA,
    action: 'idle', actionTick: 0, actionDur: 0, swingId: 0,
    dodgeCd: 0, dodgeDx: 0, dodgeDy: 0, regenDelay: 0, kx: 0, ky: 0,
    blocking: false, alive: true,
  };
}

export function clonePlayer(p: PlayerSim): PlayerSim {
  return { ...p };
}

export const EMPTY_INPUT: Omit<InputCmd, 'seq'> = {
  mx: 0, my: 0, aim: 0, light: false, heavy: false, block: false, dodge: false,
};

/** Validate / sanitise an untrusted input. Returns null if malformed. */
export function sanitizeInput(raw: unknown): InputCmd | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const seq = r.seq;
  const aim = r.aim;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return null;
  if (typeof aim !== 'number' || !Number.isFinite(aim)) return null;
  const axis = (v: unknown) => (v === 1 || v === -1 ? v : 0);
  return {
    seq,
    mx: axis(r.mx),
    my: axis(r.my),
    aim: Math.atan2(Math.sin(aim), Math.cos(aim)), // normalise to (-π, π]
    light: r.light === true,
    heavy: r.heavy === true,
    block: r.block === true,
    dodge: r.dodge === true,
  };
}

function spend(p: PlayerSim, amount: number): void {
  p.stamina = Math.max(0, p.stamina - amount);
  p.regenDelay = STAMINA_REGEN_DELAY;
}

export const LIGHT_TOTAL = LIGHT.windup + LIGHT.active + LIGHT.recovery;
export const HEAVY_TOTAL = HEAVY.active + HEAVY.recovery;

/** Advance one player by one tick using one input. Mutates `p`. */
export function stepPlayer(p: PlayerSim, input: Omit<InputCmd, 'seq'>, obstacles: readonly Rect[] = OBSTACLES): void {
  if (!p.alive) return;

  if (p.dodgeCd > 0) p.dodgeCd--;

  // ── Action state machine ────────────────────────────────────────────────
  switch (p.action) {
    case 'stun':
    case 'stagger':
      p.actionTick++;
      if (p.actionTick >= p.actionDur) setAction(p, 'idle');
      break;
    case 'light':
      p.actionTick++;
      if (p.actionTick >= LIGHT_TOTAL) setAction(p, 'idle');
      break;
    case 'heavyCharge':
      p.actionTick++;
      if (!input.heavy) setAction(p, 'idle'); // released early: cancel, no cost
      else if (p.actionTick >= HEAVY.charge) {
        if (p.stamina >= HEAVY.cost) {
          spend(p, HEAVY.cost);
          p.swingId++;
          setAction(p, 'heavy');
        } else setAction(p, 'idle');
      }
      break;
    case 'heavy':
      p.actionTick++;
      if (p.actionTick >= HEAVY_TOTAL) setAction(p, 'idle');
      break;
    case 'dodge':
      p.actionTick++;
      if (p.actionTick >= DODGE.duration) {
        setAction(p, 'idle');
        p.dodgeCd = DODGE.cooldown;
      }
      break;
    case 'idle':
      break;
  }

  // Facing follows the mouse unless committed to a swing / dodge / stun.
  if (p.action === 'idle' || p.action === 'heavyCharge') p.facing = input.aim;

  // Start new actions (only from idle). Stamina gating: must afford full cost.
  if (p.action === 'idle') {
    if (input.dodge && p.dodgeCd === 0 && p.stamina >= DODGE.cost) {
      spend(p, DODGE.cost);
      let dx = input.mx, dy = input.my;
      if (dx === 0 && dy === 0) { dx = Math.cos(p.facing); dy = Math.sin(p.facing); }
      const len = Math.hypot(dx, dy);
      p.dodgeDx = dx / len;
      p.dodgeDy = dy / len;
      setAction(p, 'dodge');
    } else if (input.light && p.stamina >= LIGHT.cost) {
      spend(p, LIGHT.cost);
      p.swingId++;
      setAction(p, 'light');
    } else if (input.heavy && p.stamina >= HEAVY.cost) {
      setAction(p, 'heavyCharge');
    }
  }

  // Block: only while idle, held, and with stamina left.
  p.blocking = p.action === 'idle' && input.block && p.stamina > 0;
  if (p.blocking) spend(p, BLOCK_DRAIN * DT);

  // ── Movement ────────────────────────────────────────────────────────────
  let vx = 0, vy = 0;
  if (p.action === 'dodge') {
    vx = p.dodgeDx * DODGE.speed;
    vy = p.dodgeDy * DODGE.speed;
  } else if (p.action !== 'stun' && p.action !== 'stagger') {
    let mult = 1;
    if (p.blocking) mult = BLOCK_SPEED_MULT;
    else if (p.action === 'light') mult = LIGHT_SPEED_MULT;
    else if (p.action === 'heavyCharge') mult = HEAVY_CHARGE_SPEED_MULT;
    else if (p.action === 'heavy') mult = HEAVY_SPEED_MULT;
    const len = Math.hypot(input.mx, input.my);
    if (len > 0) {
      vx = (input.mx / len) * MOVE_SPEED * mult;
      vy = (input.my / len) * MOVE_SPEED * mult;
    }
  }
  vx += p.kx;
  vy += p.ky;
  p.kx *= KNOCKBACK_DECAY;
  p.ky *= KNOCKBACK_DECAY;
  if (Math.abs(p.kx) < 1) p.kx = 0;
  if (Math.abs(p.ky) < 1) p.ky = 0;

  p.x += vx * DT;
  p.y += vy * DT;
  resolveCollisions(p, obstacles);

  // ── Stamina regen ───────────────────────────────────────────────────────
  if (p.regenDelay > 0) p.regenDelay--;
  else p.stamina = Math.min(MAX_STAMINA, p.stamina + STAMINA_REGEN * DT);
}

export function setAction(p: PlayerSim, a: PlayerSim['action'], dur = 0): void {
  p.action = a;
  p.actionTick = 0;
  p.actionDur = dur;
}

/** Push a circle out of arena walls and rectangular obstacles. */
export function resolveCollisions(p: { x: number; y: number }, obstacles: readonly Rect[]): void {
  const r = PLAYER_RADIUS;
  for (const o of obstacles) {
    const cx = Math.max(o.x, Math.min(p.x, o.x + o.w));
    const cy = Math.max(o.y, Math.min(p.y, o.y + o.h));
    const dx = p.x - cx, dy = p.y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 < r * r) {
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2);
        p.x = cx + (dx / d) * r;
        p.y = cy + (dy / d) * r;
      } else {
        // Centre inside the rect: push out along the shallowest axis.
        const left = p.x - o.x, right = o.x + o.w - p.x, top = p.y - o.y, bottom = o.y + o.h - p.y;
        const m = Math.min(left, right, top, bottom);
        if (m === left) p.x = o.x - r;
        else if (m === right) p.x = o.x + o.w + r;
        else if (m === top) p.y = o.y - r;
        else p.y = o.y + o.h + r;
      }
    }
  }
  p.x = Math.max(r, Math.min(ARENA_W - r, p.x));
  p.y = Math.max(r, Math.min(ARENA_H - r, p.y));
}
