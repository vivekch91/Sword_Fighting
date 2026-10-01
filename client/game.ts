// Client-side netcode: prediction + reconciliation for the local fighter,
// snapshot interpolation for everyone else.
import { DT, INTERP_DELAY_MS } from '../shared/constants';
import { angleDiff } from '../shared/combat';
import { clonePlayer, stepPlayer } from '../shared/sim';
import type { HitEvent, InputCmd, Phase, PlayerSim, SnapshotMsg } from '../shared/types';

const TICK_MS = DT * 1000;
const MAX_BUFFER = 60;

interface TimedSnap { time: number; snap: SnapshotMsg; byId: Map<string, PlayerSim> }

export class ClientGame {
  myId = '';
  phase: Phase = 'lobby';
  latest: SnapshotMsg | null = null;
  predicted: PlayerSim | null = null;
  prevPredicted: PlayerSim | null = null;
  pending: InputCmd[] = [];
  seq = 0;
  /** Visual-only offset that smooths out reconciliation corrections. */
  errX = 0;
  errY = 0;
  private buffer: TimedSnap[] = [];
  private clockOffset: number | null = null; // local ms - server ms
  private pendingEvents: { at: number; ev: HitEvent }[] = [];

  reset(): void {
    this.latest = null;
    this.predicted = this.prevPredicted = null;
    this.pending = [];
    this.buffer = [];
    this.clockOffset = null;
    this.pendingEvents = [];
    this.errX = this.errY = 0;
  }

  get simulating(): boolean {
    return this.phase === 'playing' || this.phase === 'roundEnd';
  }

  onSnapshot(snap: SnapshotMsg, now: number): void {
    const serverMs = snap.tick * TICK_MS;
    const sample = now - serverMs;
    if (this.clockOffset === null || sample < this.clockOffset) this.clockOffset = sample;
    else this.clockOffset += (sample - this.clockOffset) * 0.01; // track slow drift / latency increases

    const roundChanged = this.latest && this.latest.round !== snap.round;
    this.latest = snap;
    this.phase = snap.phase;
    const byId = new Map(snap.players.map((p) => [p.id, p]));
    this.buffer.push({ time: serverMs, snap, byId });
    if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
    for (const ev of snap.events) this.pendingEvents.push({ at: serverMs, ev });

    // ── Reconciliation ──
    this.pending = this.pending.filter((i) => i.seq > snap.ack);
    const me = byId.get(this.myId);
    if (!me) {
      this.predicted = this.prevPredicted = null;
      return;
    }
    const before = this.predicted;
    const p = clonePlayer(me);
    if (this.simulating) for (const input of this.pending) stepPlayer(p, input);
    if (before && !roundChanged) {
      const dx = before.x - p.x, dy = before.y - p.y;
      if (Math.hypot(dx, dy) < 120) { this.errX += dx; this.errY += dy; } else { this.errX = this.errY = 0; }
    } else {
      this.errX = this.errY = 0;
      this.prevPredicted = clonePlayer(p);
    }
    this.predicted = p;
  }

  /** Apply one locally sampled input (prediction). */
  applyLocalInput(input: InputCmd): void {
    this.pending.push(input);
    if (this.pending.length > 120) this.pending.shift();
    if (!this.predicted) return;
    this.prevPredicted = clonePlayer(this.predicted);
    if (this.simulating) stepPlayer(this.predicted, input);
  }

  decayError(dtMs: number): void {
    const k = Math.exp(-dtMs / 80);
    this.errX *= k;
    this.errY *= k;
    if (Math.abs(this.errX) < 0.05) this.errX = 0;
    if (Math.abs(this.errY) < 0.05) this.errY = 0;
  }

  /** Server time (ms) at which remote entities are rendered. */
  renderTime(now: number): number {
    return now - (this.clockOffset ?? now) - INTERP_DELAY_MS;
  }

  /** Interpolated states of all players (local one excluded). */
  remotePlayers(now: number): PlayerSim[] {
    const out: PlayerSim[] = [];
    if (!this.buffer.length) return out;
    const t = this.renderTime(now);
    let a = this.buffer[0], b = this.buffer[0];
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (this.buffer[i].time <= t) {
        a = this.buffer[i];
        b = this.buffer[Math.min(i + 1, this.buffer.length - 1)];
        break;
      }
    }
    // Drop snapshots that are fully in the past (keep `a`).
    while (this.buffer.length > 2 && this.buffer[1].time <= t) this.buffer.shift();
    const span = b.time - a.time;
    const alpha = span > 0 ? Math.min(1, Math.max(0, (t - a.time) / span)) : 1;
    for (const pb of b.snap.players) {
      if (pb.id === this.myId) continue;
      const pa = a.byId.get(pb.id) ?? pb;
      const base = alpha < 0.5 ? pa : pb;
      out.push({
        ...base,
        x: pa.x + (pb.x - pa.x) * alpha,
        y: pa.y + (pb.y - pa.y) * alpha,
        facing: pa.facing + angleDiff(pb.facing, pa.facing) * alpha,
      });
    }
    return out;
  }

  /** Local fighter interpolated between the last two prediction steps. */
  localPlayer(alpha: number): PlayerSim | null {
    const p = this.predicted;
    if (!p) return null;
    const q = this.prevPredicted ?? p;
    return {
      ...p,
      x: q.x + (p.x - q.x) * alpha + this.errX,
      y: q.y + (p.y - q.y) * alpha + this.errY,
    };
  }

  /** Hit events become visible when the interpolated timeline reaches them. */
  takeDueEvents(now: number): HitEvent[] {
    const t = this.renderTime(now);
    const due: HitEvent[] = [];
    while (this.pendingEvents.length && this.pendingEvents[0].at <= t) due.push(this.pendingEvents.shift()!.ev);
    return due;
  }
}
