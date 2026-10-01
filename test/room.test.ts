import { describe, expect, it } from 'vitest';
import { MAX_INPUTS_PER_TICK, REJOIN_WINDOW_MS, ROUND_END_TICKS } from '../shared/constants';
import type { ServerMsg, SnapshotMsg } from '../shared/types';
import { Room, type Conn } from '../server/room';

class FakeConn implements Conn {
  msgs: ServerMsg[] = [];
  send(m: ServerMsg) { this.msgs.push(m); }
  lastSnap(): SnapshotMsg | undefined {
    for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].t === 'snap') return this.msgs[i] as SnapshotMsg;
  }
}

function setup(n = 3) {
  let clock = 0;
  const room = new Room('ABCDE', () => clock);
  const conns = Array.from({ length: n }, () => new FakeConn());
  const ids = conns.map((c, i) => {
    const r = room.join(`P${i}`, c);
    if (!r.ok) throw new Error(r.error);
    return r.id;
  });
  return { room, conns, ids, advance: (ms: number) => { clock += ms; } };
}

function input(seq: number, over: Record<string, unknown> = {}) {
  return { seq, mx: 0, my: 0, aim: 0, light: false, heavy: false, block: false, dodge: false, ...over };
}

describe('room lobby', () => {
  it('rejects a 4th player and duplicate names', () => {
    const { room } = setup(3);
    expect(room.join('Late', new FakeConn())).toMatchObject({ ok: false, error: expect.stringMatching(/full/i) });
    const { room: r2 } = setup(1);
    expect(r2.join('p0', new FakeConn())).toMatchObject({ ok: false });
  });

  it('starts when all 3 are ready', () => {
    const { room, ids } = setup(3);
    room.setReady(ids[0], true);
    room.setReady(ids[1], true);
    expect(room.phase).toBe('lobby');
    room.setReady(ids[2], true);
    expect(room.phase).toBe('playing');
  });

  it('host-only start with 2', () => {
    const { room, ids } = setup(2);
    expect(room.startWithTwo(ids[1])).toMatch(/host/i);
    expect(room.startWithTwo(ids[0])).toBeNull();
    expect(room.phase).toBe('playing');
  });

  it('rejects joins once the match is in progress', () => {
    const { room, ids } = setup(2);
    room.startWithTwo(ids[0]);
    expect(room.join('New', new FakeConn())).toMatchObject({ ok: false, error: expect.stringMatching(/in progress/i) });
  });

  it('lobby disconnect removes the player and passes host', () => {
    const { room, ids } = setup(2);
    room.disconnect(ids[0]);
    expect(room.size).toBe(1);
    expect(room.hostId).toBe(ids[1]);
  });
});

describe('server-authoritative simulation', () => {
  it('caps input consumption per tick (no speed hacks by flooding)', () => {
    const { room, ids } = setup(2);
    room.startWithTwo(ids[0]);
    const start = { ...room.simOf(ids[0])! };
    for (let s = 0; s < 50; s++) room.queueInput(ids[0], input(s, { mx: 1 }));
    room.tick();
    const moved = Math.abs(room.simOf(ids[0])!.x - start.x);
    expect(moved).toBeLessThanOrEqual((210 / 30) * MAX_INPUTS_PER_TICK + 1e-6);
  });

  it('ignores replayed sequence numbers', () => {
    const { room, ids } = setup(2);
    room.startWithTwo(ids[0]);
    room.queueInput(ids[0], input(5, { mx: 1 }));
    room.tick();
    const x = room.simOf(ids[0])!.x;
    room.queueInput(ids[0], input(5, { mx: 1 }));
    room.queueInput(ids[0], input(3, { mx: 1 }));
    room.tick();
    expect(room.simOf(ids[0])!.x).toBe(x);
  });

  it('acks processed inputs in snapshots', () => {
    const { room, ids, conns } = setup(2);
    room.startWithTwo(ids[0]);
    room.queueInput(ids[0], input(7));
    room.tick();
    expect(conns[0].lastSnap()!.ack).toBe(7);
  });
});

describe('rounds and match', () => {
  function killAllBut(room: Room, ids: string[], keep: string) {
    for (const id of ids) if (id !== keep) { const s = room.simOf(id)!; s.hp = 0; s.alive = false; }
    room.tick();
  }

  it('first to 2 round wins takes the match, then rematch restarts', () => {
    const { room, ids } = setup(3);
    ids.forEach((id) => room.setReady(id, true));
    killAllBut(room, ids, ids[1]);
    expect(room.phase).toBe('roundEnd');
    expect(room.roundWinner).toBe(ids[1]);
    for (let i = 0; i < ROUND_END_TICKS; i++) room.tick();
    expect(room.phase).toBe('playing');
    expect(room.round).toBe(2);
    expect(room.simOf(ids[0])!.alive).toBe(true);
    killAllBut(room, ids, ids[1]);
    expect(room.phase).toBe('matchEnd');
    expect(room.matchWinner).toBe(ids[1]);
    ids.forEach((id) => room.voteRematch(id));
    expect(room.phase).toBe('playing');
    expect(room.round).toBe(1);
    expect(room.info().players.every((p) => p.wins === 0)).toBe(true);
  });
});

describe('disconnect / rejoin', () => {
  it('restores a player who rejoins with same name within 30 s', () => {
    const { room, ids, advance } = setup(3);
    ids.forEach((id) => room.setReady(id, true));
    room.simOf(ids[2])!.hp = 55;
    room.disconnect(ids[2]);
    expect(room.phase).toBe('playing');
    advance(10_000);
    room.sweep();
    const c = new FakeConn();
    const r = room.join('P2', c);
    expect(r).toMatchObject({ ok: true, id: ids[2], rejoined: true });
    expect(room.simOf(ids[2])!.hp).toBe(55);
  });

  it('drops the reservation after 30 s', () => {
    const { room, ids, advance } = setup(3);
    ids.forEach((id) => room.setReady(id, true));
    room.disconnect(ids[2]);
    advance(REJOIN_WINDOW_MS + 1);
    room.sweep();
    expect(room.size).toBe(2);
    expect(room.join('P2', new FakeConn())).toMatchObject({ ok: false });
  });

  it('ends the match when fewer than 2 players remain', () => {
    const { room, ids } = setup(2);
    room.startWithTwo(ids[0]);
    room.disconnect(ids[1]);
    expect(room.phase).toBe('matchEnd');
    expect(room.matchWinner).toBe(ids[0]);
  });

  it('room reports empty for cleanup once everyone has left', () => {
    const { room, ids } = setup(2);
    ids.forEach((id) => room.disconnect(id));
    expect(room.sweep()).toBe(true);
  });
});
