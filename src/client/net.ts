import { CLOSE, PING_MS, PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '../shared/protocol';

export type NetStatus = 'connecting' | 'open' | 'reconnecting' | 'replaced' | 'outdated' | 'full';

const RTT_SAMPLES = 5;
const MAX_LAG_MS = 2000;

interface Lag {
  lag: number;
  jitter: number;
}

/** `?lag=MS&jitter=MS` adds MS to the round trip, plus up to `jitter` each way, so high ping can be felt on purpose. */
function lagFromQuery(search: string): Lag | null {
  const params = new URLSearchParams(search);
  const ms = (key: string): number => {
    const n = Number(params.get(key) ?? 0);
    return Number.isFinite(n) ? Math.min(MAX_LAG_MS, Math.max(0, n)) : 0;
  };
  const lag = ms('lag');
  const jitter = ms('jitter');
  return lag > 0 || jitter > 0 ? { lag, jitter } : null;
}

/** Runs each job half the lag plus some jitter later, but never before an earlier one, as on one TCP stream. */
class DelayLine {
  private queue: { at: number; run: () => void }[] = [];
  private last = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private sim: Lag) {}

  push(run: () => void): void {
    this.last = Math.max(this.last, performance.now() + this.sim.lag / 2 + Math.random() * this.sim.jitter);
    this.queue.push({ at: this.last, run });
    this.timer ??= this.arm();
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
  }

  private arm(): ReturnType<typeof setTimeout> {
    return setTimeout(this.flush, Math.max(0, Math.ceil(this.queue[0].at - performance.now())));
  }

  private flush = (): void => {
    const now = performance.now();
    // The timer was set for the first job, so that one runs even if the clock reads a hair early.
    let n = 1;
    while (n < this.queue.length && this.queue[n].at <= now) n++;
    const due = this.queue.splice(0, n);
    this.timer = this.queue.length ? this.arm() : null;
    for (const job of due) job.run();
  };
}

const after = (line: DelayLine | null, job: () => void): void => (line ? line.push(job) : job());

/** Read once at load, because creating or joining a party replaces the URL. */
const SIM = lagFromQuery(location.search);

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
  /** Simulated lag on what we send and what we receive, or null to pass everything straight through. */
  private up = SIM && new DelayLine(SIM);
  private down = SIM && new DelayLine(SIM);

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
      this.transmit(ws, JSON.stringify(this.hello()));
      this.ping(ws);
      this.timers = [setInterval(() => this.ping(ws), PING_MS)];
      this.setStatus('open');
    };
    ws.onmessage = (ev) =>
      after(this.down, () => {
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
      });
    // The close comes down the same line, so it lands after the messages sent before it.
    ws.onclose = (ev) =>
      after(this.down, () => {
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
      });
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.transmit(this.ws, JSON.stringify(msg));
  }

  close(): void {
    this.stopped = true;
    this.up?.clear();
    this.down?.clear();
    if (this.retry) clearTimeout(this.retry);
    this.stopTimers();
    this.ws?.close(CLOSE.left, 'Left the party');
  }

  /** The socket may close while a lagged message waits, so it is checked again when it goes. */
  private transmit(ws: WebSocket, data: string): void {
    after(this.up, () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });
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
    this.transmit(ws, 'ping');
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
