import { describe, expect, it } from 'vitest';
import { DODGE, HEAVY, LIGHT, MAX_STAMINA, MOVE_SPEED, DT, STAGGER_TICKS, BLOCK_DAMAGE_MULT } from '../shared/constants';
import { activeSwing, angleDiff, computeHit, inSwingArc, isInvulnerable, resolveSwing } from '../shared/combat';
import { createPlayer, EMPTY_INPUT, sanitizeInput, stepPlayer } from '../shared/sim';
import type { PlayerSim } from '../shared/types';

const NO_OBS: never[] = [];
const idle = (over: Partial<typeof EMPTY_INPUT> = {}) => ({ ...EMPTY_INPUT, ...over });

/** Step a player until its light swing hitbox becomes active. */
function toActiveLight(p: PlayerSim, aim = 0) {
  stepPlayer(p, idle({ light: true, aim }), NO_OBS);
  while (!activeSwing(p)) stepPlayer(p, idle({ aim }), NO_OBS);
}

describe('hit arc', () => {
  const a = { x: 0, y: 0, facing: 0 };
  it('hits a target straight ahead within range', () => {
    expect(inSwingArc(a, { x: 60, y: 0 }, LIGHT.range, LIGHT.arc)).toBe(true);
  });
  it('misses a target behind the attacker', () => {
    expect(inSwingArc(a, { x: -60, y: 0 }, LIGHT.range, LIGHT.arc)).toBe(false);
  });
  it('misses a target out of range', () => {
    expect(inSwingArc(a, { x: LIGHT.range + 40, y: 0 }, LIGHT.range, LIGHT.arc)).toBe(false);
  });
  it('respects arc width (heavy is wider than light)', () => {
    const side = { x: 18, y: 68 }; // ~75° off-axis
    expect(inSwingArc(a, side, LIGHT.range, LIGHT.arc)).toBe(false);
    expect(inSwingArc(a, side, HEAVY.range, HEAVY.arc)).toBe(true);
  });
  it('angleDiff wraps around ±π', () => {
    expect(angleDiff(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(-0.2);
  });
});

describe('swing resolution', () => {
  it('light swing damages once per swing per target', () => {
    const atk = createPlayer('a', 100, 100);
    const tgt = createPlayer('b', 150, 100);
    toActiveLight(atk);
    const hit = new Set<string>();
    const ev1 = resolveSwing(atk, [tgt], hit);
    stepPlayer(atk, idle(), NO_OBS); // still in active frames
    expect(activeSwing(atk)).not.toBeNull();
    const ev2 = resolveSwing(atk, [tgt], hit);
    expect(ev1).toHaveLength(1);
    expect(ev2).toHaveLength(0);
    expect(tgt.hp).toBe(100 - LIGHT.damage);
    expect(tgt.action).toBe('stun');
  });

  it('hitbox is inactive during wind-up', () => {
    const atk = createPlayer('a', 100, 100);
    stepPlayer(atk, idle({ light: true }), NO_OBS);
    expect(atk.action).toBe('light');
    expect(activeSwing(atk)).toBeNull();
  });

  it('heavy requires holding for the full charge; release cancels', () => {
    const p = createPlayer('a', 100, 100);
    stepPlayer(p, idle({ heavy: true }), NO_OBS);
    expect(p.action).toBe('heavyCharge');
    stepPlayer(p, idle({ heavy: false }), NO_OBS);
    expect(p.action).toBe('idle');
    expect(p.stamina).toBe(MAX_STAMINA); // no cost when cancelled
    for (let i = 0; i < HEAVY.charge + 1; i++) stepPlayer(p, idle({ heavy: true }), NO_OBS);
    expect(p.action).toBe('heavy');
    expect(activeSwing(p)?.heavy).toBe(true);
  });
});

describe('blocking', () => {
  it('reduces frontal damage by ~80%', () => {
    const atk = createPlayer('a', 100, 100);
    const tgt = createPlayer('b', 150, 100);
    tgt.facing = Math.PI; // facing the attacker
    tgt.blocking = true;
    const r = computeHit(atk, tgt, false);
    expect(r.blocked).toBe(true);
    expect(r.damage).toBeCloseTo(LIGHT.damage * BLOCK_DAMAGE_MULT);
    expect(r.stun).toBe(0);
  });
  it('does not protect from behind', () => {
    const atk = createPlayer('a', 100, 100);
    const tgt = createPlayer('b', 150, 100);
    tgt.facing = 0; // back turned to attacker
    tgt.blocking = true;
    const r = computeHit(atk, tgt, false);
    expect(r.blocked).toBe(false);
    expect(r.damage).toBe(LIGHT.damage);
  });
  it('blocked heavy staggers the attacker; blocked light does not', () => {
    const atk = createPlayer('a', 100, 100);
    const tgt = createPlayer('b', 150, 100);
    tgt.facing = Math.PI;
    tgt.blocking = true;
    expect(computeHit(atk, tgt, false).staggerAttacker).toBe(false);
    atk.action = 'heavy'; atk.actionTick = 0; atk.swingId = 1;
    const ev = resolveSwing(atk, [tgt], new Set());
    expect(ev[0].stagger).toBe(true);
    expect(atk.action).toBe('stagger');
    expect(atk.actionDur).toBe(STAGGER_TICKS);
    expect(tgt.hp).toBeCloseTo(100 - HEAVY.damage * BLOCK_DAMAGE_MULT);
  });
  it('block slows movement and drains stamina', () => {
    const p = createPlayer('a', 300, 300);
    stepPlayer(p, idle({ mx: 1, block: true }), NO_OBS);
    expect(p.blocking).toBe(true);
    expect(p.x - 300).toBeLessThan(MOVE_SPEED * DT * 0.5);
    expect(p.stamina).toBeLessThan(MAX_STAMINA);
  });
});

describe('dodge i-frames', () => {
  it('a dodging player cannot be hit during i-frames but can be afterwards', () => {
    const atk = createPlayer('a', 100, 100);
    const tgt = createPlayer('b', 150, 100);
    stepPlayer(tgt, idle({ dodge: true, my: 1 }), NO_OBS);
    expect(tgt.action).toBe('dodge');
    expect(isInvulnerable(tgt)).toBe(true);
    toActiveLight(atk);
    tgt.x = 150; tgt.y = 100; // keep in range for the test
    expect(resolveSwing(atk, [tgt], new Set())).toHaveLength(0);
    tgt.actionTick = DODGE.iframes; // past the i-frame window
    expect(isInvulnerable(tgt)).toBe(false);
    expect(resolveSwing(atk, [tgt], new Set())).toHaveLength(1);
  });
  it('dodge has a cooldown', () => {
    const p = createPlayer('a', 300, 300);
    stepPlayer(p, idle({ dodge: true, mx: 1 }), NO_OBS);
    for (let i = 0; i < DODGE.duration; i++) stepPlayer(p, idle(), NO_OBS);
    expect(p.action).toBe('idle');
    expect(p.dodgeCd).toBeGreaterThan(0);
    stepPlayer(p, idle({ dodge: true, mx: 1 }), NO_OBS);
    expect(p.action).toBe('idle');
  });
});

describe('stamina gating', () => {
  it('cannot attack, dodge or block without stamina', () => {
    const p = createPlayer('a', 300, 300);
    p.stamina = 0;
    p.regenDelay = 100;
    stepPlayer(p, idle({ light: true }), NO_OBS);
    expect(p.action).toBe('idle');
    stepPlayer(p, idle({ dodge: true }), NO_OBS);
    expect(p.action).toBe('idle');
    stepPlayer(p, idle({ heavy: true }), NO_OBS);
    expect(p.action).toBe('idle');
    stepPlayer(p, idle({ block: true }), NO_OBS);
    expect(p.blocking).toBe(false);
  });
  it('requires the full action cost', () => {
    const p = createPlayer('a', 300, 300);
    p.stamina = LIGHT.cost - 1;
    p.regenDelay = 100;
    stepPlayer(p, idle({ light: true }), NO_OBS);
    expect(p.action).toBe('idle');
    p.stamina = LIGHT.cost;
    stepPlayer(p, idle({ light: true }), NO_OBS);
    expect(p.action).toBe('light');
    expect(p.stamina).toBe(0);
  });
  it('stamina regenerates after a delay', () => {
    const p = createPlayer('a', 300, 300);
    stepPlayer(p, idle({ light: true }), NO_OBS);
    const after = p.stamina;
    for (let i = 0; i < 60; i++) stepPlayer(p, idle(), NO_OBS);
    expect(p.stamina).toBeGreaterThan(after);
  });
});

describe('input validation', () => {
  it('clamps movement axes and rejects junk', () => {
    expect(sanitizeInput({ seq: 1, aim: 0, mx: 50, my: -1 })).toMatchObject({ mx: 0, my: -1 });
    expect(sanitizeInput({ seq: -1, aim: 0 })).toBeNull();
    expect(sanitizeInput({ seq: 1, aim: NaN })).toBeNull();
    expect(sanitizeInput('x')).toBeNull();
  });
  it('max speed per input is bounded regardless of input', () => {
    const p = createPlayer('a', 300, 300);
    stepPlayer(p, idle({ mx: 1, my: 1 }), NO_OBS);
    expect(Math.hypot(p.x - 300, p.y - 300)).toBeCloseTo(MOVE_SPEED * DT);
  });
});
