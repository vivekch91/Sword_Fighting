import type { ClientMsg, ServerMsg } from '../shared/types';

/** Thin WebSocket wrapper. URL is derived from the page origin (ws:// or wss://). */
export class Net {
  private ws: WebSocket | null = null;
  onMessage: (m: ServerMsg) => void = () => {};
  onOpen: () => void = () => {};
  onClose: () => void = () => {};
  rtt = 0;
  private pingTimer = 0;

  static url(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    this.ws?.close();
    const ws = new WebSocket(Net.url());
    this.ws = ws;
    ws.onopen = () => {
      this.ping();
      window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.ping(), 1000);
      this.onOpen();
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data as string) as ServerMsg;
      } catch {
        return;
      }
      if (msg.t === 'pong') {
        const sample = performance.now() - msg.ct;
        this.rtt = this.rtt ? this.rtt * 0.7 + sample * 0.3 : sample;
        return;
      }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      window.clearInterval(this.pingTimer);
      this.ws = null;
      this.onClose();
    };
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private ping(): void {
    this.send({ t: 'ping', ct: performance.now() });
  }
}
