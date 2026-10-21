import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '../shared/protocol';

export type NetStatus = 'connecting' | 'open' | 'reconnecting' | 'replaced' | 'outdated';

const PING_MS = 20000;

export class Net {
  status: NetStatus = 'connecting';
  private ws: WebSocket | null = null;
  private attempts = 0;
  private stopped = false;
  private ping: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private code: string,
    private hello: () => ClientMsg,
    private onMessage: (msg: ServerMsg) => void,
    private onStatus: (status: NetStatus) => void,
  ) {}

  connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/party/${this.code}/ws?v=${PROTOCOL_VERSION}`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      ws.send(JSON.stringify(this.hello()));
      this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), PING_MS);
      this.setStatus('open');
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string' || ev.data === 'pong') return;
      try {
        this.onMessage(JSON.parse(ev.data) as ServerMsg);
      } catch (err) {
        console.error('Bad message from server', err);
      }
    };
    ws.onclose = (ev) => {
      if (this.ping) clearInterval(this.ping);
      this.ping = null;
      if (this.stopped || this.ws !== ws) return;
      if (ev.code === 4000 || ev.code === 4001) {
        this.setStatus(ev.code === 4000 ? 'replaced' : 'outdated');
        return;
      }
      this.setStatus('reconnecting');
      const delay = Math.min(4000, 250 * 2 ** this.attempts++);
      this.retry = setTimeout(() => this.connect(), delay);
    };
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.ping) clearInterval(this.ping);
    this.ws?.close(1000, 'Left the party');
  }

  private setStatus(status: NetStatus): void {
    this.status = status;
    this.onStatus(status);
  }
}
