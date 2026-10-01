// Shared types and wire message schemas.

export type Action = 'idle' | 'light' | 'heavyCharge' | 'heavy' | 'dodge' | 'stun' | 'stagger';

/** Full simulation state of one fighter. Sent verbatim in snapshots. */
export interface PlayerSim {
  id: string;
  x: number;
  y: number;
  facing: number; // radians
  hp: number;
  stamina: number;
  action: Action;
  actionTick: number; // ticks elapsed in current action
  actionDur: number; // only used by stun/stagger
  swingId: number; // increments every swing -> "one hit per swing per target"
  dodgeCd: number; // ticks until dodge available
  dodgeDx: number;
  dodgeDy: number;
  regenDelay: number;
  kx: number; // knockback velocity
  ky: number;
  blocking: boolean;
  alive: boolean;
}

/** One sampled input. Clients never send positions or hit claims. */
export interface InputCmd {
  seq: number;
  mx: number; // -1, 0, 1
  my: number; // -1, 0, 1
  aim: number; // radians
  light: boolean; // edge: start a light attack
  heavy: boolean; // held: charge heavy
  block: boolean; // held
  dodge: boolean; // edge
}

export type Phase = 'lobby' | 'playing' | 'roundEnd' | 'matchEnd';

export interface LobbyPlayer {
  id: string;
  name: string;
  ready: boolean;
  color: number; // index into PLAYER_COLORS
  connected: boolean;
  wins: number;
  rematch: boolean;
}

export interface RoomInfo {
  code: string;
  hostId: string;
  phase: Phase;
  players: LobbyPlayer[];
}

export interface HitEvent {
  attacker: string;
  target: string;
  damage: number;
  blocked: boolean;
  heavy: boolean;
  stagger: boolean;
  killed: boolean;
  x: number;
  y: number;
}

// ── Client → Server ─────────────────────────────────────────────────────────
export type ClientMsg =
  | { t: 'create'; name: string }
  | { t: 'join'; code: string; name: string }
  | { t: 'ready'; ready: boolean }
  | { t: 'start2' }
  | ({ t: 'input' } & InputCmd)
  | { t: 'rematch' }
  | { t: 'leave' }
  | { t: 'ping'; ct: number };

// ── Server → Client ─────────────────────────────────────────────────────────
export interface SnapshotMsg {
  t: 'snap';
  tick: number;
  ack: number; // last input seq processed for the receiving client
  phase: Phase;
  round: number;
  phaseTicks: number; // ticks remaining in roundEnd (0 otherwise)
  roundWinner: string | null;
  matchWinner: string | null;
  players: PlayerSim[];
  events: HitEvent[];
}

export type ServerMsg =
  | { t: 'joined'; you: string; code: string; rejoined: boolean }
  | { t: 'lobby'; room: RoomInfo }
  | { t: 'error'; msg: string }
  | { t: 'left' }
  | SnapshotMsg
  | { t: 'pong'; ct: number };
