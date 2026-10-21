import type { FromWorker, MatchInit, ToWorker } from '../host/messages';
import {
  MATCH_PHASES,
  type ClientMsg,
  type GuestMsg,
  type HostMsg,
  type IceServer,
  type MatchMsg,
  type Phase,
  type RoomMsg,
  type SignalData,
} from '../shared/protocol';
import { Link } from './peer';

/** The match a message from the worker belongs to. The worker never sends pongs. */
const matchOf = (msg: HostMsg): number => (msg.t === 'match' ? msg.match : 'n' in msg ? msg.n : 0);
/** Under a guest's shortest retry, so only a page flooding the host with offers is slowed. */
const OFFER_GAP_MS = 400;

export interface HostIO {
  send(msg: ClientMsg): void;
  /** A message from the match for this page, as guests get it over their links. */
  deliver(msg: HostMsg): void;
  /** Pings the party socket. Comes from the worker, whose timers keep time in a hidden tab. */
  beat(): void;
}

/**
 * The party host's side of the game, which exists while this page is the party host. It answers every guest's game
 * link, runs the match in a worker, and relays between the two.
 */
export class HostRuntime {
  private worker: Worker | null = null;
  private ice: IceServer[] | null = null;
  /** Signals that came before the first ice servers. */
  private queued: { from: string; l: number; d: SignalData }[] = [];
  private links = new Map<string, Link>();
  private offeredAt = new Map<string, number>();
  /** The phase of the last room this runtime saw, or null before the first. */
  private seen: Phase | null = null;
  private linked = new Set<string>();
  /** The match this runtime is running or last ran, or 0. */
  private match = 0;
  /** Whether the worker has `match`, from its start until the room moves on. */
  private active = false;
  private over = false;
  private aborted = 0;
  /** The match state as last sent, again for links that open mid-match and to the party whenever the socket opens. */
  private last: MatchMsg | null = null;
  private wake: WakeLockSentinel | null = null;
  private wantWake = false;
  private waking = false;

  constructor(
    readonly id: string,
    private io: HostIO,
  ) {
    document.addEventListener('visibilitychange', this.onVisible);
  }

  /** True while a match runs on this page and isn't over. */
  get hosting(): boolean {
    return this.active && !this.over;
  }

  setIce(servers: IceServer[]): void {
    this.ice = servers;
    for (const s of this.queued.splice(0)) this.signal(s.from, s.l, s.d);
  }

  /** A signal from a guest. An offer with a new attempt number replaces that guest's link. */
  signal(from: string, l: number, d: SignalData): void {
    if (!this.ice) {
      this.queued.push({ from, l, d });
      return;
    }
    let link = this.links.get(from);
    if ('sdp' in d && d.sdp.type === 'offer' && link?.l !== l) {
      // A guest retries no sooner than this, so faster offers are a page flooding the host with connections.
      if (performance.now() - (this.offeredAt.get(from) ?? -Infinity) < OFFER_GAP_MS) return;
      this.offeredAt.set(from, performance.now());
      if (link) this.drop(from, link);
      link = this.connect(from, l, this.ice);
    }
    if (link?.l === l) link.signal(d);
  }

  /**
   * Starts, stops or aborts the match to fit the party's room. Only a page that saw the room go from lobby to a match
   * starts it. A match this page never started (it reloaded) can't go on, so the party is told to end it.
   */
  onRoom(room: RoomMsg): void {
    const before = this.seen;
    this.seen = room.phase;
    if (this.active && (room.phase === 'lobby' || room.match !== this.match)) this.end();
    if (!MATCH_PHASES.includes(room.phase) || room.match === this.match) return;
    if (before !== null && !MATCH_PHASES.includes(before) && room.match > this.match) {
      this.start(room);
    } else if (room.match !== this.aborted) {
      this.aborted = room.match;
      this.io.send({ t: 'abort', match: room.match });
    }
  }

  /** This page's own pointer samples. */
  input(s: number, q: number[]): void {
    if (this.active) this.post({ t: 'input', id: this.id, s, q });
  }

  /** A seated player pressed Leave, so their goal closes at once. */
  quit(id: string): void {
    if (this.active) this.post({ t: 'quit', id });
  }

  /**
   * The party socket opened again. A report or abort sent while it was down was lost. The party ignores a report it
   * has, and the room it sends next shows whether an abort is still needed.
   */
  resend(): void {
    this.aborted = 0;
    if (this.last) this.io.send(this.last);
  }

  /** This page left or stopped being host. */
  stop(): void {
    this.worker?.terminate();
    this.worker = null;
    this.active = false;
    for (const link of this.links.values()) link.close();
    this.links.clear();
    this.linked.clear();
    this.queued = [];
    this.lock(false);
    document.removeEventListener('visibilitychange', this.onVisible);
  }

  private start(room: RoomMsg): void {
    this.match = room.match;
    this.active = true;
    this.over = false;
    this.last = null;
    if (!this.worker) {
      const worker = new Worker(new URL('../host/worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (ev: MessageEvent<FromWorker>) => this.onWorker(ev.data);
      worker.onerror = (ev) => this.onWorkerError(worker, ev);
      this.worker = worker;
    }
    const init: MatchInit = {
      match: room.match,
      settings: room.settings,
      seats: room.seats,
      players: room.players.filter((p) => p.seat >= 0).map((p) => ({ id: p.id, seat: p.seat, bot: p.bot })),
      host: this.id,
      linked: [...this.linked],
    };
    this.post({ t: 'start', init });
    this.lock(true);
  }

  /** The room moved on from the match. */
  private end(): void {
    this.post({ t: 'stop' });
    this.active = false;
    this.last = null;
    this.lock(false);
  }

  private post(msg: ToWorker): void {
    this.worker?.postMessage(msg);
  }

  /** Messages from a match the worker has since stopped can still be on their way, so they are checked against this one. */
  private onWorker(msg: FromWorker): void {
    if (!this.active) return;
    switch (msg.t) {
      case 'send': {
        const parsed = JSON.parse(msg.data) as HostMsg;
        if (matchOf(parsed) !== this.match) return;
        if (parsed.t === 'match') {
          this.last = parsed;
          this.over = parsed.phase === 'over';
          if (this.over) this.lock(false);
        }
        for (const [id, link] of this.links) if (this.linked.has(id)) link.send(msg.data, msg.reliable);
        this.io.deliver(parsed);
        break;
      }
      case 'report':
        if (msg.msg.match !== this.match) return;
        this.io.send(msg.msg);
        break;
      case 'beat':
        this.io.beat();
        break;
    }
  }

  /** An exception stops the worker's tick loop, so the match can't go on. A new worker runs the next one. */
  private onWorkerError(worker: Worker, ev: Event): void {
    console.error('Match worker failed', ev);
    worker.terminate();
    if (this.worker === worker) this.worker = null;
    if (this.active) this.io.send({ t: 'abort', match: this.match });
  }

  private connect(id: string, l: number, ice: IceServer[]): Link {
    const link: Link = new Link(l, false, ice, {
      signal: (d) => this.io.send({ t: 'signal', to: id, l, d }),
      open: () => {
        this.linked.add(id);
        if (!this.active) return;
        this.post({ t: 'link', id, up: true });
        if (this.last) link.send(JSON.stringify(this.last), true);
      },
      message: (data) => this.onGuest(id, link, data),
      dead: () => {
        if (this.links.get(id) === link) this.drop(id, link);
      },
    });
    this.links.set(id, link);
    return link;
  }

  private drop(id: string, link: Link): void {
    link.close();
    this.links.delete(id);
    if (this.linked.delete(id) && this.active) this.post({ t: 'link', id, up: false });
  }

  private onGuest(id: string, link: Link, data: string): void {
    let msg: GuestMsg;
    try {
      msg = JSON.parse(data) as GuestMsg;
    } catch {
      return;
    }
    switch (msg?.t) {
      case 'p':
        if (this.active) this.post({ t: 'input', id, s: msg.s, q: msg.q });
        break;
      case 'ping':
        link.send(JSON.stringify({ t: 'pong', i: msg.i } satisfies HostMsg), false);
        break;
      case 'bye':
        this.quit(id);
        break;
    }
  }

  /**
   * Keeps a phone's screen on while hosting, since a phone stops running the page soon after it locks. The browser
   * drops the lock whenever the page hides.
   */
  private lock(on: boolean): void {
    this.wantWake = on && matchMedia('(pointer: coarse)').matches;
    if (this.wantWake) {
      void this.requestWake();
      return;
    }
    void this.wake?.release().catch(() => {});
    this.wake = null;
  }

  private onVisible = (): void => {
    if (document.visibilityState === 'visible') void this.requestWake();
  };

  private async requestWake(): Promise<void> {
    if (!this.wantWake || this.wake || this.waking || document.visibilityState !== 'visible') return;
    this.waking = true;
    try {
      const wake = await navigator.wakeLock.request('screen');
      if (this.wantWake && !this.wake) {
        this.wake = wake;
        wake.onrelease = () => {
          if (this.wake === wake) this.wake = null;
        };
      } else {
        void wake.release().catch(() => {});
      }
    } catch {
      // Refused (power saving) or not supported. The match runs anyway.
    } finally {
      this.waking = false;
    }
  }
}
