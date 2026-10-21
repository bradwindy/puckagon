import { PING_MS, type GuestMsg, type HostMsg, type IceCandidate, type IceServer, type SignalData } from '../shared/protocol';
import { after, delayLine, type DelayLine } from './lag';

/** `?relay=1` in the page URL sends game links only through a TURN relay, to try the path strict networks need. */
export const RELAY = new URLSearchParams(location.search).get('relay') === '1';

export const hasRelay = (servers: IceServer[]): boolean =>
  servers.some((s) => [s.urls].flat().some((url) => /^turns?:/.test(url)));

/** A link that hasn't opened this long after it was made is given up on, as when a signal was lost. */
const CONNECT_MS = 10000;
/** A connection that stays disconnected this long is given up on, long before ICE would call it failed. */
const DISCONNECTED_MS = 4000;
/** An unreliable send is skipped while more than this waits on its channel, so stale state never piles up. */
const MAX_BUFFERED = 1024;
/** How long a leaving link waits for its control channel to finish closing. */
const CLOSE_MS = 500;
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 4000;
const RTT_SAMPLES = 5;
/** A ping this many behind the newest with no pong yet counts as lost. */
const PINGS_KEPT = 10;

export interface LinkEvents {
  /** A signal for the other end, to go through the party server. */
  signal(d: SignalData): void;
  /** Both channels opened. */
  open(): void;
  message(data: string): void;
  /** The link failed or the other end closed it. Never called after close() or leave(). */
  dead(): void;
}

/**
 * One end of a game link: an RTCPeerConnection with two channels both ends make themselves, `control` (reliable,
 * ordered) and `state` (unordered, never resent). The guest offers and the host only answers.
 */
export class Link {
  private pc: RTCPeerConnection;
  private control: RTCDataChannel;
  private state: RTCDataChannel;
  /** Signals from the other end, handled one at a time in order. */
  private chain: Promise<void> = Promise.resolve();
  /** Remote candidates that came before the remote description. */
  private held: (IceCandidate | null)[] = [];
  /** Local candidates found before our description went out, or null once it has. */
  private early: SignalData[] | null = [];
  private opened = false;
  private ended = false;
  private connectTimer: ReturnType<typeof setTimeout>;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private upControl = delayLine(true);
  private upState = delayLine(false);
  private downControl = delayLine(true);
  private downState = delayLine(false);

  constructor(
    /** The guest's number for this attempt, so signals for an attempt that was replaced are dropped. */
    readonly l: number,
    offer: boolean,
    iceServers: IceServer[],
    private on: LinkEvents,
  ) {
    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: RELAY ? 'relay' : 'all' });
    this.pc = pc;
    this.control = this.channel(pc.createDataChannel('control', { negotiated: true, id: 0 }), this.downControl);
    this.state = this.channel(
      pc.createDataChannel('state', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 }),
      this.downState,
    );
    pc.onicecandidate = ({ candidate: c }) =>
      this.local({
        candidate: c && { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, usernameFragment: c.usernameFragment },
      });
    pc.onconnectionstatechange = () => this.onConnection();
    this.connectTimer = setTimeout(() => this.fail(), CONNECT_MS);
    if (offer) {
      this.step(async () => {
        await pc.setLocalDescription(await pc.createOffer());
        this.describe();
      });
    }
  }

  get up(): boolean {
    return !this.ended && this.control.readyState === 'open' && this.state.readyState === 'open';
  }

  signal(d: SignalData): void {
    const pc = this.pc;
    if ('sdp' in d) {
      this.step(async () => {
        await pc.setRemoteDescription(d.sdp);
        if (d.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          this.describe();
        }
        for (const c of this.held.splice(0)) await pc.addIceCandidate(c).catch((err: unknown) => this.warn(err));
      });
      return;
    }
    this.step(async () => {
      if (pc.remoteDescription) await pc.addIceCandidate(d.candidate);
      else this.held.push(d.candidate);
    });
  }

  send(data: string, reliable: boolean): void {
    if (this.ended) return;
    const ch = reliable ? this.control : this.state;
    // A send queued before leave() still goes, so it is checked when it leaves the line rather than against `ended`.
    after(reliable ? this.upControl : this.upState, () => {
      if (ch.readyState !== 'open' || (!reliable && ch.bufferedAmount > MAX_BUFFERED)) return;
      try {
        ch.send(data);
      } catch (err) {
        this.warn(err);
      }
    });
  }

  close(): void {
    if (this.ended) return;
    this.end();
    this.upControl?.clear();
    this.pc.close();
  }

  /**
   * Sends `bye` and closes once it has gone. Closing the connection drops what its channels still hold, so the control
   * channel closes first, which sends what is queued, and the connection follows.
   */
  leave(bye: string): void {
    if (this.ended) return;
    this.send(bye, true);
    this.end();
    after(this.upControl, () => {
      const done = () => this.pc.close();
      this.control.onclose = done;
      this.control.close();
      setTimeout(done, CLOSE_MS);
    });
  }

  private channel(ch: RTCDataChannel, down: DelayLine | null): RTCDataChannel {
    ch.onopen = () => {
      if (this.opened || !this.up) return;
      this.opened = true;
      clearTimeout(this.connectTimer);
      this.on.open();
    };
    // The close comes down the control line, so it lands after the messages sent before it, such as a `bye`.
    ch.onclose = () => after(this.downControl, () => this.fail());
    ch.onmessage = (ev: MessageEvent) => {
      const data: unknown = ev.data;
      if (typeof data !== 'string') return;
      after(down, () => {
        if (!this.ended) this.on.message(data);
      });
    };
    return ch;
  }

  private onConnection(): void {
    const state = this.pc.connectionState;
    if (state === 'failed' || state === 'closed') {
      this.fail();
    } else if (state === 'disconnected') {
      this.disconnectTimer ??= setTimeout(() => this.fail(), DISCONNECTED_MS);
    } else if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  /** Each step catches its own error, so one bad candidate can't stall the signals after it. */
  private step(run: () => Promise<void>): void {
    this.chain = this.chain
      .then(() => (this.ended ? undefined : run()))
      .catch((err: unknown) => this.warn(err));
  }

  private describe(): void {
    const desc = this.pc.localDescription;
    if (!desc || this.ended) return;
    this.on.signal({ sdp: { type: desc.type === 'offer' ? 'offer' : 'answer', sdp: desc.sdp } });
    const early = this.early ?? [];
    this.early = null;
    for (const d of early) this.on.signal(d);
  }

  /** The other end only takes candidates for a link it knows about, so they wait for the description. */
  private local(d: SignalData): void {
    if (this.ended) return;
    if (this.early) this.early.push(d);
    else this.on.signal(d);
  }

  private fail(): void {
    if (this.ended) return;
    this.end();
    this.pc.close();
    this.on.dead();
  }

  private end(): void {
    this.ended = true;
    clearTimeout(this.connectTimer);
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.upState?.clear();
    this.downControl?.clear();
    this.downState?.clear();
  }

  private warn(err: unknown): void {
    if (!this.ended) console.warn('Game link', err);
  }
}

export interface GuestLinkEvents {
  signal(l: number, d: SignalData): void;
  message(msg: HostMsg): void;
  change(up: boolean): void;
  /** The median round trip to the host changed. */
  rtt(ms: number): void;
}

/** A guest's game link to the host. A link that fails or never opens is replaced by a new attempt, with backoff. */
export class GuestLink {
  /** Median round trip of the last few pongs in ms, or -1 until one comes back on this link. */
  rtt = -1;
  private link: Link | null = null;
  private attempts = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private pings = new Map<number, number>();
  private pingId = 0;
  private rtts: number[] = [];

  constructor(
    readonly host: string,
    private iceServers: () => IceServer[],
    private on: GuestLinkEvents,
  ) {
    this.build();
  }

  get up(): boolean {
    return this.link?.up ?? false;
  }

  signal(l: number, d: SignalData): void {
    if (this.link?.l === l) this.link.signal(d);
  }

  send(msg: GuestMsg): void {
    this.link?.send(JSON.stringify(msg), msg.t === 'bye');
  }

  /** Tells the host we left, so it closes our goal at once, then closes the link. */
  leave(): void {
    this.stop();
    this.link?.leave(JSON.stringify({ t: 'bye' } satisfies GuestMsg));
    this.link = null;
  }

  close(): void {
    this.stop();
    this.link?.close();
    this.link = null;
  }

  private stop(): void {
    if (this.retry) clearTimeout(this.retry);
    if (this.pinger) clearInterval(this.pinger);
    this.retry = this.pinger = null;
  }

  private build(): void {
    this.retry = null;
    const l = crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;
    const link: Link = new Link(l, true, this.iceServers(), {
      signal: (d) => this.on.signal(l, d),
      open: () => {
        this.attempts = 0;
        this.ping();
        this.pinger = setInterval(() => this.ping(), PING_MS);
        this.on.change(true);
      },
      message: (data) => this.onData(data),
      dead: () => {
        if (this.link !== link) return;
        const wasUp = this.pinger !== null;
        this.stop();
        this.link = null;
        this.rtt = -1;
        this.rtts = [];
        this.pings.clear();
        if (wasUp) this.on.change(false);
        this.retry = setTimeout(() => this.build(), Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** this.attempts++));
      },
    });
    this.link = link;
  }

  private onData(data: string): void {
    try {
      const msg = JSON.parse(data) as HostMsg;
      if (msg.t === 'pong') this.onPong(msg.i);
      else this.on.message(msg);
    } catch (err) {
      console.error('Bad message from host', err);
    }
  }

  private ping(): void {
    const i = this.pingId++;
    this.pings.set(i, performance.now());
    this.pings.delete(i - PINGS_KEPT);
    this.send({ t: 'ping', i });
  }

  private onPong(i: number): void {
    const at = this.pings.get(i);
    if (at === undefined) return;
    this.pings.delete(i);
    this.rtts.push(performance.now() - at);
    if (this.rtts.length > RTT_SAMPLES) this.rtts.shift();
    this.rtt = Math.round([...this.rtts].sort((a, b) => a - b)[this.rtts.length >> 1]);
    this.on.rtt(this.rtt);
  }
}
