import { NAME_MAX, ROOM_CODE_ALPHABET, ROOM_CODE_LEN } from '../shared/constants';
import { Room } from './room';

export function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[^\p{L}\p{N} _\-.]/gu, '').trim().slice(0, NAME_MAX);
  return name.length ? name : null;
}

export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z0-9]{4,6}$/.test(code) ? code : null;
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  constructor(private now: () => number = Date.now) {}

  create(): Room {
    let code = '';
    do {
      code = '';
      for (let i = 0; i < ROOM_CODE_LEN; i++) code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
    } while (this.rooms.has(code));
    const room = new Room(code, this.now);
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  tickAll(): void {
    for (const r of this.rooms.values()) r.tick();
  }

  /** Expire reservations and delete empty rooms. */
  sweep(): void {
    for (const [code, r] of this.rooms) if (r.sweep()) this.rooms.delete(code);
  }
}
