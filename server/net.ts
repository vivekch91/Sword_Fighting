// WebSocket gateway: parses + validates client messages, routes them to rooms,
// and optionally simulates network latency/jitter for testing.
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { sanitizeInput } from '../shared/sim';
import type { ClientMsg, ServerMsg } from '../shared/types';
import type { Conn, Room } from './room';
import { normalizeCode, RoomManager, sanitizeName } from './rooms';

export interface LagOptions { lagMs: number; jitterMs: number }

const MAX_MSGS_PER_SEC = 120;

/** Delays a stream of callbacks by lag/2 ± jitter while preserving order (like TCP). */
class DelayLine {
  private last = 0;
  constructor(private opts: LagOptions) {}
  run(fn: () => void): void {
    if (!this.opts.lagMs && !this.opts.jitterMs) return fn();
    const delay = this.opts.lagMs / 2 + Math.random() * this.opts.jitterMs;
    const at = Math.max(this.last, Date.now() + delay);
    this.last = at;
    setTimeout(fn, at - Date.now());
  }
}

export function attachGateway(server: HttpServer, rooms: RoomManager, lag: LagOptions): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

  wss.on('connection', (ws: WebSocket) => {
    const out = new DelayLine(lag);
    const inbound = new DelayLine(lag);
    let room: Room | null = null;
    let playerId = '';
    let msgCount = 0;
    let windowStart = Date.now();

    const conn: Conn = {
      send(msg: ServerMsg) {
        const data = JSON.stringify(msg);
        out.run(() => { if (ws.readyState === ws.OPEN) ws.send(data); });
      },
    };

    const detach = (explicit: boolean) => {
      if (!room) return;
      if (explicit) room.leave(playerId);
      else room.disconnect(playerId);
      room = null;
      playerId = '';
    };

    const enter = (r: Room, name: string) => {
      const res = r.join(name, conn);
      if (!res.ok) return conn.send({ t: 'error', msg: res.error });
      room = r;
      playerId = res.id;
      conn.send({ t: 'joined', you: res.id, code: r.code, rejoined: res.rejoined });
      r.broadcastLobby();
    };

    const handle = (msg: ClientMsg) => {
      switch (msg.t) {
        case 'ping':
          if (typeof msg.ct === 'number') conn.send({ t: 'pong', ct: msg.ct });
          return;
        case 'create': {
          if (room) return;
          const name = sanitizeName(msg.name);
          if (!name) return conn.send({ t: 'error', msg: 'Please enter a name.' });
          const r = rooms.create();
          enter(r, name);
          if (!room) rooms.sweep();
          return;
        }
        case 'join': {
          if (room) return;
          const name = sanitizeName(msg.name);
          const code = normalizeCode(msg.code);
          if (!name) return conn.send({ t: 'error', msg: 'Please enter a name.' });
          if (!code) return conn.send({ t: 'error', msg: 'Room codes are 4–6 letters/numbers.' });
          const r = rooms.get(code);
          if (!r) return conn.send({ t: 'error', msg: `Room ${code} not found.` });
          return enter(r, name);
        }
        case 'leave':
          detach(true);
          conn.send({ t: 'left' });
          return;
      }
      if (!room) return;
      switch (msg.t) {
        case 'ready': room.setReady(playerId, msg.ready === true); break;
        case 'start2': {
          const err = room.startWithTwo(playerId);
          if (err) conn.send({ t: 'error', msg: err });
          break;
        }
        case 'rematch': room.voteRematch(playerId); break;
        case 'input': {
          const input = sanitizeInput(msg);
          if (input) room.queueInput(playerId, input);
          break;
        }
      }
    };

    ws.on('message', (data) => {
      const now = Date.now();
      if (now - windowStart > 1000) { windowStart = now; msgCount = 0; }
      if (++msgCount > MAX_MSGS_PER_SEC) return; // drop floods
      let msg: ClientMsg;
      try {
        msg = JSON.parse(data.toString()) as ClientMsg;
      } catch {
        return;
      }
      if (typeof msg !== 'object' || msg === null || typeof msg.t !== 'string') return;
      inbound.run(() => handle(msg));
    });

    ws.on('close', () => inbound.run(() => detach(false)));
    ws.on('error', () => ws.close());
  });

  return wss;
}
