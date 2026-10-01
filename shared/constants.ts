// ─────────────────────────────────────────────────────────────────────────────
// Gameplay & network tuning. Shared by server (authoritative sim) and client
// (prediction) so both run identical math. Durations are in simulation ticks.
// ─────────────────────────────────────────────────────────────────────────────

export const TICK_RATE = 30; // Hz, fixed server simulation step
export const DT = 1 / TICK_RATE;
export const SNAPSHOT_EVERY_N_TICKS = 1; // 30 Hz snapshots
export const INTERP_DELAY_MS = 100; // client render delay for remote players
export const MAX_INPUTS_PER_TICK = 2; // server consumes at most this many inputs/player/tick
export const MAX_INPUT_QUEUE = 8; // older inputs are dropped beyond this

// Arena (world units ≈ pixels at scale 1)
export const ARENA_W = 1200;
export const ARENA_H = 800;
export const PLAYER_RADIUS = 20;

export interface Rect { x: number; y: number; w: number; h: number }

export const OBSTACLES: readonly Rect[] = [
  { x: 540, y: 340, w: 120, h: 120 }, // centre pillar
  { x: 250, y: 560, w: 180, h: 40 }, // lower-left wall
  { x: 800, y: 180, w: 40, h: 180 }, // upper-right wall
];

export const SPAWNS: readonly { x: number; y: number }[] = [
  { x: 150, y: 150 },
  { x: 1050, y: 650 },
  { x: 150, y: 680 },
];

export const PLAYER_COLORS = ['#e8554e', '#4ea3e8', '#f2c14e'] as const;

// Movement
export const MOVE_SPEED = 210; // units/s
export const BLOCK_SPEED_MULT = 0.45;
export const LIGHT_SPEED_MULT = 0.55;
export const HEAVY_CHARGE_SPEED_MULT = 0.35;
export const HEAVY_SPEED_MULT = 0.2;
export const KNOCKBACK_DECAY = 0.8; // per tick multiplier on knockback velocity

// Stats
export const MAX_HP = 100;
export const MAX_STAMINA = 100;
export const STAMINA_REGEN = 30; // per second
export const STAMINA_REGEN_DELAY = 15; // ticks after spending before regen resumes

// Light attack (left click)
export const LIGHT = {
  cost: 12,
  damage: 10,
  windup: 3, // ticks before hitbox is active
  active: 3, // ticks hitbox is active
  recovery: 5,
  range: 72, // reach measured from attacker centre (target radius added)
  arc: (110 * Math.PI) / 180, // full arc width
  knockback: 260, // units/s impulse
  stun: 6, // ticks of hit-stun on target
} as const;

// Heavy attack (hold right click). Charge = telegraphed wind-up.
export const HEAVY = {
  cost: 30,
  damage: 30,
  charge: 15, // ticks right-click must be held (0.5 s)
  active: 4,
  recovery: 12,
  range: 90,
  arc: (150 * Math.PI) / 180,
  knockback: 520,
  stun: 14,
} as const;

// Block (Shift)
export const BLOCK_DAMAGE_MULT = 0.2; // 80 % reduction
export const BLOCK_ARC = (140 * Math.PI) / 180; // frontal arc covered by block
export const BLOCK_DRAIN = 12; // stamina per second while holding block
export const BLOCK_HIT_STAMINA_MULT = 1.0; // stamina lost per point of damage blocked (pre-reduction)
export const BLOCK_KNOCKBACK_MULT = 0.4;
export const STAGGER_TICKS = 24; // attacker stagger when heavy is blocked

// Dodge (Space)
export const DODGE = {
  cost: 22,
  duration: 8, // ticks
  iframes: 6, // first N ticks are invulnerable
  speed: 620,
  cooldown: 24, // ticks after dodge ends (~0.8 s)
} as const;

// Match flow
export const ROUNDS_TO_WIN = 2; // "best of 3" → first to 2 round wins
export const ROUND_END_TICKS = 3 * TICK_RATE; // pause before next round
export const REJOIN_WINDOW_MS = 30_000;
export const MAX_PLAYERS = 3;
export const NAME_MAX = 16;
export const ROOM_CODE_LEN = 5;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
