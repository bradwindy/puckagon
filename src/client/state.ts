import { makeLayout, type Layout } from '../shared/geometry';
import { SNAP_EVERY, TICK_HZ, type GoalInfo, type PublicPlayer, type RoomMsg, type SnapMsg, type WireEvent } from '../shared/protocol';
import type { Vec } from '../shared/vec';

const TICK_MS = 1000 / TICK_HZ;
const SNAP_MS = SNAP_EVERY * TICK_MS;
/** Snapshots this recent set the clock. It drifts toward the least delayed one. */
const WINDOW_MS = 1000;
/**
 * The delay covers the second widest of the per-second spreads above that seen this recently. Spikes that keep coming
 * are covered, and a single hitch doesn't hold the delay up.
 */
const SPREAD_MS = 5000;
/** When every snapshot this recent came too late to play, the clock moves to them at once instead of drifting. */
const REANCHOR_MS = 200;
/** The recent snapshots must span at least this long, so one burst can't move the clock. */
const REANCHOR_SPAN_MS = 150;
const START_DELAY_MS = 75;
const MARGIN_PAD_MS = 8;
const MIN_MARGIN_MS = 10;
const MAX_MARGIN_MS = 200;
/** The most the clock and the delay change per ms of real time, so playback never runs more than a few % fast or slow while they adapt. */
const SLEW = 0.03;
/** A longer gap between snapshots slews no further, so the clock never steps by more than a few ms at once. */
const MAX_SLEW_GAP_MS = 100;
const TELEPORT = 0.25;
const MAX_EXTRAPOLATE_MS = 50;
/** Time constant of the late-frame average. */
const LATE_MS = 1000;
/**
 * Events this many ticks older than the newest snapshot when they come due are dropped, so a tab coming back from the
 * background doesn't replay them all at once. It allows for the longest delay.
 */
const STALE_TICKS = Math.ceil((SNAP_MS + MAX_MARGIN_MS) / TICK_MS) + 10;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

interface Snap {
  k: number;
  puck: [number, number, number, number];
  mallets: ([number, number] | 0)[];
  hitter: number;
}

export interface Sample {
  puck: Vec | null;
  speed: number;
  mallets: (Vec | null)[];
  hitter: number;
}

export type Due = { kind: 'event'; e: WireEvent } | { kind: 'goal'; goal: GoalInfo };

export class GameState {
  room: RoomMsg | null = null;
  myId = '';
  layout: Layout | null = null;
  private layoutKey = '';
  private snaps: Snap[] = [];
  private arrivals: { at: number; estimate: number }[] = [];
  private spreads: { at: number; ms: number }[] = [];
  private offset = Infinity;
  private delay = START_DELAY_MS;
  private late = 0;
  private sampledAt = -Infinity;
  private shownTick = -Infinity;
  private queue: { k: number; due: Due }[] = [];
  /** The puck is hidden for render ticks in [hiddenFrom, showFrom): from a goal until the next serve. */
  private hiddenFrom = Infinity;
  private showFrom = Infinity;
  private served = false;

  get me(): PublicPlayer | undefined {
    return this.room?.players.find((p) => p.id === this.myId);
  }

  get isHost(): boolean {
    return !!this.room && this.room.host === this.myId;
  }

  bySeat(seat: number): PublicPlayer | undefined {
    return this.room?.players.find((p) => p.seat === seat);
  }

  /** Share of recent match frames that ran past the newest snapshot and had to extrapolate. */
  get lateRate(): number {
    return this.late;
  }

  private resetClock(): void {
    this.snaps = [];
    this.queue = [];
    this.arrivals = [];
    this.spreads = [];
    this.offset = Infinity;
    this.delay = START_DELAY_MS;
    this.late = 0;
    this.shownTick = -Infinity;
  }

  onRoom(msg: RoomMsg): void {
    const prev = this.room;
    this.room = msg;
    const key = `${msg.seats}:${msg.settings.goal}:${msg.settings.mallet}`;
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      this.layout = makeLayout(msg.seats, msg.settings);
    }
    if (msg.phase === 'lobby') {
      // The server tick doesn't advance between matches, so the clock estimate must start again.
      this.resetClock();
      this.hiddenFrom = this.showFrom = Infinity;
    }
    if (!prev && msg.phase === 'scored') this.hiddenFrom = -Infinity;
    if (msg.phase === 'playing' && prev?.phase !== 'playing') {
      this.hiddenFrom = -Infinity;
      // The serve happens on the tick after the last snap we have, and shows up in the next snap.
      this.showFrom = (this.snaps.at(-1)?.k ?? 0) + SNAP_EVERY;
    }
  }

  /** True once per serve, on the first frame the served puck is visible. */
  takeServe(): boolean {
    const served = this.served;
    this.served = false;
    return served;
  }

  onSnap(msg: SnapMsg, now: number): void {
    if (msg.k <= (this.snaps.at(-1)?.k ?? -1)) this.resetClock();
    const prevAt = this.arrivals.at(-1)?.at;
    const estimate = now - msg.k * TICK_MS;
    this.arrivals.push({ at: now, estimate });
    while (this.arrivals[0].at < now - WINDOW_MS) this.arrivals.shift();
    const recent = this.arrivals.filter((a) => a.at >= now - REANCHOR_MS);
    const reanchor = recent[0].at <= now - REANCHOR_SPAN_MS && recent.every((a) => a.estimate > this.offset + this.delay);
    if (reanchor) {
      // Every recent snapshot came too late to play, so the server skipped ticks or the route got slower. Drifting there
      // would leave playback ahead of the snapshots for up to a second. Spreads measured against the old clock no longer apply.
      this.arrivals = recent;
      this.spreads = [];
    }
    const min = Math.min(...this.arrivals.map((a) => a.estimate));
    this.spreads.push({ at: now, ms: estimate - min });
    while (this.spreads[0].at < now - SPREAD_MS) this.spreads.shift();
    const peaks = new Map<number, number>();
    for (const s of this.spreads) {
      const second = Math.floor(s.at / 1000);
      peaks.set(second, Math.max(peaks.get(second) ?? 0, s.ms));
    }
    const widest = [...peaks.values()].sort((a, b) => b - a);
    const target = SNAP_MS + clamp((widest[1] ?? widest[0]) + MARGIN_PAD_MS, MIN_MARGIN_MS, MAX_MARGIN_MS);
    const step = SLEW * Math.min(MAX_SLEW_GAP_MS, now - (prevAt ?? now));
    this.offset = prevAt === undefined || reanchor ? min : this.offset + clamp(min - this.offset, -step, step);
    this.delay += clamp(target - this.delay, -step, step);
    this.snaps.push({ k: msg.k, puck: msg.p, mallets: msg.m, hitter: msg.h });
    if (this.snaps.length > 40) this.snaps.shift();
    for (const e of msg.e) this.queue.push({ k: msg.k, due: { kind: 'event', e } });
  }

  onGoal(k: number, goal: GoalInfo): void {
    this.queue.push({ k, due: { kind: 'goal', goal } });
    // Set on arrival rather than when due, so a later serve message always wins even if frames were paused.
    this.hiddenFrom = k;
    this.showFrom = Infinity;
  }

  /**
   * The server tick on screen. It never goes back, so when the clock re-anchors or slews back the puck pauses instead
   * of rewinding.
   */
  renderTick(now: number): number {
    if (!Number.isFinite(this.offset)) return 0;
    this.shownTick = Math.max(this.shownTick, (now - this.offset - this.delay) / TICK_MS);
    return this.shownTick;
  }

  /** Events whose tick the rendered timeline has reached. */
  takeDue(now: number): Due[] {
    const tick = this.renderTick(now);
    const newest = this.snaps.at(-1)?.k ?? 0;
    const due: Due[] = [];
    this.queue = this.queue.filter((q) => {
      if (q.k > tick) return true;
      if (newest - q.k <= STALE_TICKS) due.push(q.due);
      return false;
    });
    return due;
  }

  sample(now: number): Sample | null {
    const snaps = this.snaps;
    if (snaps.length === 0) return null;
    const tick = this.renderTick(now);
    let a = snaps[0];
    let b = snaps[0];
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].k <= tick) {
        a = snaps[i];
        b = snaps[i + 1] ?? snaps[i];
        break;
      }
    }

    const span = b.k - a.k;
    const t = span > 0 ? Math.min(1, Math.max(0, (tick - a.k) / span)) : 0;
    const jump = Math.hypot(b.puck[0] - a.puck[0], b.puck[1] - a.puck[1]) > TELEPORT;
    let px: number;
    let py: number;
    if (span > 0 && !jump) {
      px = a.puck[0] + (b.puck[0] - a.puck[0]) * t;
      py = a.puck[1] + (b.puck[1] - a.puck[1]) * t;
    } else {
      const extra = Math.min(MAX_EXTRAPOLATE_MS, Math.max(0, (tick - a.k) * TICK_MS)) / 1000;
      const base = jump && t >= 1 ? b : a;
      px = base.puck[0] + (jump ? 0 : base.puck[2] * extra);
      py = base.puck[1] + (jump ? 0 : base.puck[3] * extra);
    }

    const mallets = a.mallets.map((ma, seat) => {
      const mb = b.mallets[seat];
      if (!ma) return null;
      if (!mb || span === 0) return { x: ma[0], y: ma[1] };
      return { x: ma[0] + (mb[0] - ma[0]) * t, y: ma[1] + (mb[1] - ma[1]) * t };
    });

    if (tick >= this.showFrom) {
      this.hiddenFrom = this.showFrom = Infinity;
      this.served = true;
    }
    const phase = this.room?.phase;
    if (phase === 'countdown' || phase === 'playing' || phase === 'scored') {
      const late = tick > snaps[snaps.length - 1].k ? 1 : 0;
      this.late += (late - this.late) * (1 - Math.exp(-Math.max(0, now - this.sampledAt) / LATE_MS));
    }
    this.sampledAt = now;
    const hidden = phase === 'countdown' || (tick >= this.hiddenFrom && tick < this.showFrom);
    return {
      puck: hidden ? null : { x: px, y: py },
      speed: Math.hypot(a.puck[2], a.puck[3]),
      mallets,
      hitter: a.hitter,
    };
  }
}
