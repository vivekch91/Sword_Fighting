// A single game room: lobby, authoritative simulation, rounds, rejoin.
// Transport-agnostic: talks to players through the `Conn` interface so it can
// be unit-tested without sockets.
import {
  ARENA_H, ARENA_W, MAX_INPUT_QUEUE, MAX_INPUTS_PER_TICK, MAX_PLAYERS, REJOIN_WINDOW_MS,
  ROUND_END_TICKS, ROUNDS_TO_WIN, SNAPSHOT_EVERY_N_TICKS, SPAWNS,
} from '../shared/constants';
import { resolveSwing } from '../shared/combat';
import { createPlayer, stepPlayer } from '../shared/sim';
import type { HitEvent, InputCmd, Phase, PlayerSim, RoomInfo, ServerMsg } from '../shared/types';

export interface Conn {
  send(msg: ServerMsg): void;
}

interface Member {
  id: string;
  name: string;
  color: number;
  ready: boolean;
  wins: number;
  rematch: boolean;
  conn: Conn | null; // null => disconnected, slot reserved for rejoin
  disconnectedAt: number;
  sim: PlayerSim | null;
  simRound: number;
  inputs: InputCmd[];
  lastSeq: number; // last input seq processed (acked)
  lastQueuedSeq: number;
  swingId: number;
  hitSet: Set<string>;
}

export type JoinResult = { ok: true; id: string; rejoined: boolean } | { ok: false; error: string };

let nextId = 1;

export class Room {
  readonly code: string;
  hostId = '';
  phase: Phase = 'lobby';
  round = 0;
  tickCount = 0;
  phaseTicks = 0;
  roundWinner: string | null = null;
  matchWinner: string | null = null;
  private members = new Map<string, Member>();
  private events: HitEvent[] = [];
  private now: () => number;

  constructor(code: string, now: () => number = Date.now) {
    this.code = code;
    this.now = now;
  }

  get size(): number { return this.members.size; }
  get connectedCount(): number { return [...this.members.values()].filter((m) => m.conn).length; }
  get isEmpty(): boolean { return this.members.size === 0; }
  memberName(id: string): string | undefined { return this.members.get(id)?.name; }

  // ── Membership ────────────────────────────────────────────────────────────
  join(name: string, conn: Conn): JoinResult {
    const existing = [...this.members.values()].find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (existing.conn) return { ok: false, error: 'That name is already taken in this room.' };
      // Rejoin within the window: restore slot, score and (if same round) fighter state.
      existing.conn = conn;
      existing.inputs = [];
      existing.lastSeq = -1;
      existing.lastQueuedSeq = -1;
      if (existing.sim && (existing.simRound !== this.round || this.phase === 'lobby')) {
        existing.sim.alive = false; // round moved on: spectate until next round
      }
      this.broadcastLobby();
      return { ok: true, id: existing.id, rejoined: true };
    }
    if (this.phase !== 'lobby') return { ok: false, error: 'Match already in progress in this room.' };
    if (this.members.size >= MAX_PLAYERS) return { ok: false, error: 'Room is full (3/3).' };

    const used = new Set([...this.members.values()].map((m) => m.color));
    let color = 0;
    while (used.has(color)) color++;
    const id = `p${nextId++}`;
    this.members.set(id, {
      id, name, color, ready: false, wins: 0, rematch: false, conn, disconnectedAt: 0,
      sim: null, simRound: 0, inputs: [], lastSeq: -1, lastQueuedSeq: -1, swingId: -1, hitSet: new Set(),
    });
    if (!this.hostId) this.hostId = id;
    this.broadcastLobby();
    return { ok: true, id, rejoined: false };
  }

  /** Socket dropped. In lobby the player is removed; mid-match the slot is reserved. */
  disconnect(id: string): void {
    const m = this.members.get(id);
    if (!m) return;
    if (this.phase === 'lobby') {
      this.remove(id);
      return;
    }
    m.conn = null;
    m.disconnectedAt = this.now();
    m.inputs = [];
    this.afterPresenceChange();
  }

  /** Explicit leave: no reservation. */
  leave(id: string): void {
    if (!this.members.has(id)) return;
    this.remove(id);
  }

  private remove(id: string): void {
    this.members.delete(id);
    if (this.hostId === id) this.hostId = this.members.keys().next().value ?? '';
    if (this.phase !== 'lobby') this.afterPresenceChange();
    else this.broadcastLobby();
  }

  private afterPresenceChange(): void {
    if ((this.phase === 'playing' || this.phase === 'roundEnd') && this.connectedCount < 2) {
      const remaining = [...this.members.values()].find((m) => m.conn);
      this.endMatch(remaining?.id ?? null);
    } else if (this.phase === 'playing') {
      this.checkRoundEnd();
    }
    if (this.hostId && !this.members.get(this.hostId)?.conn) {
      const next = [...this.members.values()].find((m) => m.conn);
      if (next) this.hostId = next.id;
    }
    this.broadcastLobby();
  }

  /** Expire stale reservations. Returns true if the room should be deleted. */
  sweep(): boolean {
    const t = this.now();
    for (const m of [...this.members.values()]) {
      if (!m.conn && t - m.disconnectedAt > REJOIN_WINDOW_MS) {
        this.members.delete(m.id);
        if (this.hostId === m.id) this.hostId = [...this.members.values()].find((x) => x.conn)?.id ?? '';
        this.broadcastLobby();
      }
    }
    return this.members.size === 0;
  }

  // ── Lobby actions ─────────────────────────────────────────────────────────
  setReady(id: string, ready: boolean): void {
    const m = this.members.get(id);
    if (!m || this.phase !== 'lobby') return;
    m.ready = ready;
    this.broadcastLobby();
    const all = [...this.members.values()];
    if (all.length === MAX_PLAYERS && all.every((x) => x.ready)) this.startMatch();
  }

  startWithTwo(id: string): string | null {
    if (this.phase !== 'lobby') return 'Match already started.';
    if (id !== this.hostId) return 'Only the host can do that.';
    if (this.members.size < 2) return 'Need at least 2 players.';
    this.startMatch();
    return null;
  }

  voteRematch(id: string): void {
    const m = this.members.get(id);
    if (!m || this.phase !== 'matchEnd') return;
    m.rematch = true;
    this.broadcastLobby();
    const present = [...this.members.values()].filter((x) => x.conn);
    if (present.length >= 2 && present.every((x) => x.rematch)) this.startMatch();
  }

  // ── Match flow ────────────────────────────────────────────────────────────
  private startMatch(): void {
    for (const m of [...this.members.values()]) if (!m.conn) this.members.delete(m.id);
    for (const m of this.members.values()) { m.wins = 0; m.rematch = false; m.ready = false; }
    this.matchWinner = null;
    this.round = 0;
    this.startRound();
  }

  private startRound(): void {
    this.round++;
    this.phase = 'playing';
    this.phaseTicks = 0;
    this.roundWinner = null;
    for (const m of this.members.values()) {
      const s = SPAWNS[m.color % SPAWNS.length];
      m.sim = createPlayer(m.id, s.x, s.y, Math.atan2(ARENA_H / 2 - s.y, ARENA_W / 2 - s.x));
      m.simRound = this.round;
      m.hitSet.clear();
      m.swingId = -1;
    }
    this.broadcastLobby();
  }

  private checkRoundEnd(): void {
    const fighters = [...this.members.values()].filter((m) => m.conn && m.sim);
    const alive = fighters.filter((m) => m.sim!.alive);
    if (alive.length > 1) return;
    const winner = alive[0] ?? null; // null => simultaneous KO, round is a draw
    this.roundWinner = winner?.id ?? null;
    if (winner) winner.wins++;
    if (winner && winner.wins >= ROUNDS_TO_WIN) this.endMatch(winner.id);
    else {
      this.phase = 'roundEnd';
      this.phaseTicks = ROUND_END_TICKS;
    }
    this.broadcastLobby();
  }

  private endMatch(winnerId: string | null): void {
    this.phase = 'matchEnd';
    this.phaseTicks = 0;
    this.matchWinner = winnerId;
    for (const m of this.members.values()) m.rematch = false;
    this.broadcastLobby();
  }

  // ── Input & simulation ────────────────────────────────────────────────────
  queueInput(id: string, input: InputCmd): void {
    const m = this.members.get(id);
    if (!m || !m.conn) return;
    if (input.seq <= m.lastQueuedSeq) return; // replayed / out-of-order: ignore
    m.lastQueuedSeq = input.seq;
    m.inputs.push(input);
    // Flooding can't speed anyone up: the queue is capped and drained at a fixed rate.
    while (m.inputs.length > MAX_INPUT_QUEUE) m.lastSeq = m.inputs.shift()!.seq;
  }

  tick(): void {
    if (this.phase === 'lobby') return;
    this.tickCount++;
    const simulating = this.phase === 'playing' || this.phase === 'roundEnd';
    const active = [...this.members.values()].filter((m) => m.conn);

    for (const m of active) {
      const n = Math.min(MAX_INPUTS_PER_TICK, m.inputs.length);
      for (let i = 0; i < n; i++) {
        const input = m.inputs.shift()!;
        m.lastSeq = input.seq;
        if (!simulating || !m.sim) continue;
        stepPlayer(m.sim, input);
        if (this.phase === 'playing') this.resolveAttacks(m, active);
      }
    }

    if (this.phase === 'playing') this.checkRoundEnd();
    else if (this.phase === 'roundEnd' && --this.phaseTicks <= 0) this.startRound();

    if (this.tickCount % SNAPSHOT_EVERY_N_TICKS === 0) this.broadcastSnapshot();
  }

  private resolveAttacks(attacker: Member, active: Member[]): void {
    const sim = attacker.sim!;
    if (attacker.swingId !== sim.swingId) {
      attacker.swingId = sim.swingId;
      attacker.hitSet.clear();
    }
    const targets = active.filter((o) => o !== attacker && o.sim).map((o) => o.sim!);
    const evs = resolveSwing(sim, targets, attacker.hitSet);
    if (evs.length) this.events.push(...evs);
  }

  // ── Outgoing ──────────────────────────────────────────────────────────────
  info(): RoomInfo {
    return {
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      players: [...this.members.values()].map((m) => ({
        id: m.id, name: m.name, ready: m.ready, color: m.color, connected: !!m.conn, wins: m.wins, rematch: m.rematch,
      })),
    };
  }

  broadcastLobby(): void {
    const msg: ServerMsg = { t: 'lobby', room: this.info() };
    for (const m of this.members.values()) m.conn?.send(msg);
  }

  private broadcastSnapshot(): void {
    const players = [...this.members.values()].filter((m) => m.conn && m.sim).map((m) => m.sim!);
    const events = this.events;
    this.events = [];
    for (const m of this.members.values()) {
      m.conn?.send({
        t: 'snap', tick: this.tickCount, ack: m.lastSeq, phase: this.phase, round: this.round,
        phaseTicks: this.phaseTicks, roundWinner: this.roundWinner, matchWinner: this.matchWinner,
        players, events,
      });
    }
  }

  /** Test helper. */
  simOf(id: string): PlayerSim | null { return this.members.get(id)?.sim ?? null; }
}
