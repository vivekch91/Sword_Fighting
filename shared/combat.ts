// Pure combat helpers. Only the server calls applyHit/resolveSwing; the client
// uses the query helpers for rendering (e.g. drawing active swing arcs).
import {
  BLOCK_ARC, BLOCK_DAMAGE_MULT, BLOCK_HIT_STAMINA_MULT, BLOCK_KNOCKBACK_MULT, DODGE, HEAVY, LIGHT,
  PLAYER_RADIUS, STAGGER_TICKS, STAMINA_REGEN_DELAY,
} from './constants';
import { setAction } from './sim';
import type { HitEvent, PlayerSim } from './types';

export type SwingSpec = typeof LIGHT | typeof HEAVY;

/** Smallest signed difference between two angles, in (-π, π]. */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Returns the swing spec if the player's hitbox is live this tick. */
export function activeSwing(p: PlayerSim): { spec: SwingSpec; heavy: boolean } | null {
  if (!p.alive) return null;
  if (p.action === 'light' && p.actionTick >= LIGHT.windup && p.actionTick < LIGHT.windup + LIGHT.active) {
    return { spec: LIGHT, heavy: false };
  }
  if (p.action === 'heavy' && p.actionTick < HEAVY.active) return { spec: HEAVY, heavy: true };
  return null;
}

/** Arc hitbox: target circle within reach and centre inside the swing cone. */
export function inSwingArc(attacker: { x: number; y: number; facing: number }, target: { x: number; y: number }, range: number, arc: number): boolean {
  const dx = target.x - attacker.x, dy = target.y - attacker.y;
  const dist = Math.hypot(dx, dy);
  if (dist > range + PLAYER_RADIUS) return false;
  if (dist < PLAYER_RADIUS) return true; // overlapping: always connects
  // Widen the cone slightly by the angular size of the target's body.
  const bodyAngle = Math.asin(Math.min(1, PLAYER_RADIUS / dist));
  return Math.abs(angleDiff(Math.atan2(dy, dx), attacker.facing)) <= arc / 2 + bodyAngle;
}

export function isInvulnerable(p: PlayerSim): boolean {
  return p.action === 'dodge' && p.actionTick < DODGE.iframes;
}

/** True if `target` is blocking and the attacker is inside its frontal arc. */
export function isBlockingFrom(target: PlayerSim, ax: number, ay: number): boolean {
  if (!target.blocking) return false;
  const toAttacker = Math.atan2(ay - target.y, ax - target.x);
  return Math.abs(angleDiff(toAttacker, target.facing)) <= BLOCK_ARC / 2;
}

export interface HitResult {
  damage: number;
  blocked: boolean;
  staggerAttacker: boolean;
  knockback: number;
  stun: number;
}

/** Compute (but do not apply) the outcome of a connecting swing. */
export function computeHit(attacker: PlayerSim, target: PlayerSim, heavy: boolean): HitResult {
  const spec = heavy ? HEAVY : LIGHT;
  const blocked = isBlockingFrom(target, attacker.x, attacker.y);
  return {
    damage: blocked ? spec.damage * BLOCK_DAMAGE_MULT : spec.damage,
    blocked,
    staggerAttacker: blocked && heavy,
    knockback: spec.knockback * (blocked ? BLOCK_KNOCKBACK_MULT : 1),
    stun: blocked ? 0 : spec.stun,
  };
}

/** Mutates attacker + target according to a HitResult. */
export function applyHit(attacker: PlayerSim, target: PlayerSim, r: HitResult, heavy: boolean): void {
  const spec = heavy ? HEAVY : LIGHT;
  target.hp = Math.max(0, Math.round((target.hp - r.damage) * 10) / 10);
  const ang = Math.atan2(target.y - attacker.y, target.x - attacker.x);
  target.kx = Math.cos(ang) * r.knockback;
  target.ky = Math.sin(ang) * r.knockback;
  if (r.blocked) {
    target.stamina = Math.max(0, target.stamina - spec.damage * BLOCK_HIT_STAMINA_MULT);
    target.regenDelay = STAMINA_REGEN_DELAY;
    if (target.stamina <= 0) target.blocking = false; // guard broken
  } else {
    target.blocking = false;
    setAction(target, 'stun', r.stun); // interrupts whatever they were doing
  }
  if (r.staggerAttacker) setAction(attacker, 'stagger', STAGGER_TICKS);
  if (target.hp <= 0) {
    target.alive = false;
    target.blocking = false;
  }
}

/**
 * Resolve an attacker's live hitbox against all targets. `alreadyHit` holds the
 * target ids hit by the attacker's current swing (one hit per swing per target).
 */
export function resolveSwing(attacker: PlayerSim, targets: PlayerSim[], alreadyHit: Set<string>): HitEvent[] {
  const swing = activeSwing(attacker);
  if (!swing) return [];
  const events: HitEvent[] = [];
  for (const t of targets) {
    if (t.id === attacker.id || !t.alive || alreadyHit.has(t.id)) continue;
    if (isInvulnerable(t)) continue;
    if (!inSwingArc(attacker, t, swing.spec.range, swing.spec.arc)) continue;
    alreadyHit.add(t.id);
    const r = computeHit(attacker, t, swing.heavy);
    applyHit(attacker, t, r, swing.heavy);
    events.push({
      attacker: attacker.id, target: t.id, damage: r.damage, blocked: r.blocked, heavy: swing.heavy,
      stagger: r.staggerAttacker, killed: !t.alive, x: t.x, y: t.y,
    });
    if (r.staggerAttacker) break; // swing interrupted
  }
  return events;
}
