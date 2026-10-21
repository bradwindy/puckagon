import { CLOSE, KEEPALIVE_MS, PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '../shared/protocol';
import { after, delayLine } from './lag';

export type NetStatus = 'connecting' | 'open' | 'reconnecting' | 'replaced' | 'outdated' | 'full';

const RETRY_MAX_MS = 4000;
/** While this page hosts a match, the party ends it if the socket stays down past HOST_GRACE_MS, so retries stay quick. */
const HOSTING_RETRY_MAX_MS = 1000;

/** The party socket: lobby, signalling and match reports. Gameplay goes over the game links. */
export class Net {
  status: NetStatus = 'connecting';
  private ws: WebSocket | null = null;
  private attempts = 0;
  private stopped = false;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  /** Simulated lag on what we send and what we receive, or null to pass everything straight through. */
  private up = delayLine(true);
  private down = delayLine(true);

  constructor(
    private code: string,
    private hello: () => ClientMsg,
    private onMessage: (msg: ServerMsg) => void,
    private onStatus: (status: NetStatus) => void,
    private hosting: () => boolean = () => false,
  ) {}

  connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/party/${this.code}/ws?v=${PROTOCOL_VERSION}`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.transmit(ws, JSON.stringify(this.hello()));
      this.keepaliveTimer = setInterval(() => this.keepalive(), KEEPALIVE_MS);
      this.setStatus('open');
    };
    ws.onmessage = (ev) =>
      after(this.down, () => {
        if (typeof ev.data !== 'string' || ev.data === 'pong') return;
        try {
          this.onMessage(JSON.parse(ev.data) as ServerMsg);
        } catch (err) {
          console.error('Bad message from server', err);
        }
      });
    // The close comes down the same line, so it lands after the messages sent before it.
    ws.onclose = (ev) =>
      after(this.down, () => {
        this.stopKeepalive();
        if (this.stopped || this.ws !== ws) return;
        const final = { [CLOSE.replaced]: 'replaced', [CLOSE.outdated]: 'outdated', [CLOSE.full]: 'full' } as const;
        if (ev.code in final) {
          this.setStatus(final[ev.code as keyof typeof final]);
          return;
        }
        this.setStatus('reconnecting');
        const delay = Math.min(this.hosting() ? HOSTING_RETRY_MAX_MS : RETRY_MAX_MS, 250 * 2 ** this.attempts++);
        this.retry = setTimeout(() => this.connect(), delay);
      });
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.transmit(this.ws, JSON.stringify(msg));
  }

  /** Pings the party server, which answers by itself, so it knows this page still runs. */
  keepalive(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.transmit(this.ws, 'ping');
  }

  close(): void {
    this.stopped = true;
    this.up?.clear();
    this.down?.clear();
    if (this.retry) clearTimeout(this.retry);
    this.stopKeepalive();
    this.ws?.close(CLOSE.left, 'Left the party');
  }

  /** The socket may close while a lagged message waits, so it is checked again when it goes. */
  private transmit(ws: WebSocket, data: string): void {
    after(this.up, () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  private setStatus(status: NetStatus): void {
    this.status = status;
    this.onStatus(status);
  }
}
