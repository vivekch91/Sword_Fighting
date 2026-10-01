// Keyboard + mouse sampling. Produces one InputCmd per simulation tick.
import type { InputCmd } from '../shared/types';

const BUFFER_TICKS = 5; // presses are remembered briefly so they fire when the current action ends

export class InputSampler {
  private keys = new Set<string>();
  private rightDown = false;
  private lightBuf = 0;
  private dodgeBuf = 0;
  /** Mouse position in CSS pixels relative to the canvas. */
  mouseX = 0;
  mouseY = 0;
  enabled = false;

  constructor(canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (!this.enabled || isTyping(e)) return;
      if (e.code === 'Space') { if (!e.repeat) this.dodgeBuf = BUFFER_TICKS; e.preventDefault(); }
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.rightDown = false; });
    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.mouseX = e.clientX - r.left;
      this.mouseY = e.clientY - r.top;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (e.button === 0) this.lightBuf = BUFFER_TICKS;
      if (e.button === 2) this.rightDown = true;
      e.preventDefault();
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 2) this.rightDown = false; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  sample(seq: number, aim: number): InputCmd {
    const k = this.keys;
    const mx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const my = (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0);
    return {
      seq, mx, my, aim,
      light: this.lightBuf > 0,
      heavy: this.rightDown,
      block: k.has('ShiftLeft') || k.has('ShiftRight'),
      dodge: this.dodgeBuf > 0,
    };
  }

  /** Called after prediction: clear buffered presses once consumed, else age them. */
  consume(startedLight: boolean, startedDodge: boolean): void {
    this.lightBuf = startedLight ? 0 : Math.max(0, this.lightBuf - 1);
    this.dodgeBuf = startedDodge ? 0 : Math.max(0, this.dodgeBuf - 1);
  }
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
}
