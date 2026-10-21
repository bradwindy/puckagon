import { CLOSE, PING_MS, PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '../shared/protocol';

export type NetStatus = 'connecting' | 'open' | 'reconnecting' | 'replaced' | 'outdated' | 'full';

const RTT_SAMPLES = 5;

export class Net {
  status: NetStatus = 'connecting';
  /** Median round trip of the last few pings in ms, or -1 until one comes back on this connection. */
  rtt = -1;
  /** The ping last told to the room on this connection, or -1. */
  private reported = -1;
  private rtts: number[] = [];
  private pingAt: number | null = null;
  private inFlight = 0;
  private ws: WebSocket | null = null;
  private attempts = 0;
  private stopped = false;
  private timers: ReturnType<typeof setInterval>[] = [];
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
      this.ping(ws);
      this.timers = [setInterval(() => this.ping(ws), PING_MS)];
      this.setStatus('open');
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      if (ev.data === 'pong') {
        this.onPong();
        return;
      }
      try {
        this.onMessage(JSON.parse(ev.data) as ServerMsg);
      } catch (err) {
        console.error('Bad message from server', err);
      }
    };
    ws.onclose = (ev) => {
      this.stopTimers();
      this.rtt = this.reported = -1;
      this.rtts = [];
      this.pingAt = null;
      this.inFlight = 0;
      if (this.stopped || this.ws !== ws) return;
      const final = { [CLOSE.replaced]: 'replaced', [CLOSE.outdated]: 'outdated', [CLOSE.full]: 'full' } as const;
      if (ev.code in final) {
        this.setStatus(final[ev.code as keyof typeof final]);
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
    this.stopTimers();
    this.ws?.close(CLOSE.left, 'Left the party');
  }

  private stopTimers(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Doubles as the keepalive. Pongs come back in order, so only a ping sent with none outstanding is timed. */
  private ping(ws: WebSocket): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (this.inFlight === 0) this.pingAt = performance.now();
    this.inFlight++;
    ws.send('ping');
  }

  private onPong(): void {
    if (this.inFlight === 0) return;
    this.inFlight--;
    if (this.pingAt === null) return;
    this.rtts.push(performance.now() - this.pingAt);
    this.pingAt = null;
    if (this.rtts.length > RTT_SAMPLES) this.rtts.shift();
    this.rtt = Math.round([...this.rtts].sort((a, b) => a - b)[this.rtts.length >> 1]);
    // The room only shows a change this big, so smaller ones aren't worth a message.
    if (this.reported >= 0 && Math.abs(this.rtt - this.reported) < Math.max(20, this.reported * 0.2)) return;
    this.reported = this.rtt;
    this.send({ t: 'rtt', ms: this.rtt });
  }

  private setStatus(status: NetStatus): void {
    this.status = status;
    this.onStatus(status);
  }
}
