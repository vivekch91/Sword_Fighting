import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { attachGateway } from '../server/net';
import { RoomManager } from '../server/rooms';
import type { ServerMsg } from '../shared/types';

const rooms = new RoomManager();
const server = createServer();
let url = '';

beforeAll(async () => {
  attachGateway(server, rooms, { lagMs: 0, jitterMs: 0 });
  await new Promise<void>((r) => server.listen(0, r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function client(): Promise<{ ws: WebSocket; next: (t: ServerMsg['t']) => Promise<ServerMsg> }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const inbox: ServerMsg[] = [];
    const waiters: { t: string; fn: (m: ServerMsg) => void }[] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as ServerMsg;
      const w = waiters.findIndex((x) => x.t === m.t);
      if (w >= 0) waiters.splice(w, 1)[0].fn(m);
      else inbox.push(m);
    });
    const next = (t: ServerMsg['t']) => new Promise<ServerMsg>((res) => {
      const i = inbox.findIndex((m) => m.t === t);
      if (i >= 0) res(inbox.splice(i, 1)[0]);
      else waiters.push({ t, fn: res });
    });
    ws.on('open', () => resolve({ ws, next }));
  });
}

describe('websocket gateway', () => {
  it('survives malformed messages and handles create/join/errors', async () => {
    const a = await client();
    a.ws.send('not json');
    a.ws.send(JSON.stringify({ t: 'input', seq: 'x' }));
    a.ws.send(JSON.stringify({ t: 'create', name: '  <b>Al</b>  ' }));
    const joined = await a.next('joined');
    expect(joined.t === 'joined' && joined.code).toMatch(/^[A-Z0-9]{5}$/);
    const code = joined.t === 'joined' ? joined.code : '';

    const b = await client();
    b.ws.send(JSON.stringify({ t: 'join', code: 'ZZZZZ', name: 'Bo' }));
    expect(await b.next('error')).toMatchObject({ msg: expect.stringMatching(/not found/) });
    b.ws.send(JSON.stringify({ t: 'join', code: code.toLowerCase(), name: 'Bo' }));
    expect(await b.next('joined')).toMatchObject({ code });
    expect(rooms.get(code)?.size).toBe(2);

    a.ws.close();
    b.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    rooms.sweep();
    expect(rooms.get(code)).toBeUndefined(); // empty lobby room cleaned up
  });
});
