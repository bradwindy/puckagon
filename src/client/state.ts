import { makeLayout, type Layout } from '../shared/geometry';
import { SNAP_EVERY, TICK_HZ, type GoalInfo, type PublicPlayer, type RoomMsg, type SnapMsg, type WireEvent } from '../shared/protocol';
import type { Vec } from '../shared/vec';
import type { Prediction, PuckState } from './predict';

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
/**
 * While the puck's timeline moves toward local time or back, the puck looks at most this much faster or slower, in units a
 * second. Higher catches up sooner at high ping, and the speed change shows more.
 */
export const WARP_SPEED = 0.6;
const MAX_RATE = 3;
const MIN_RATE = 0.4;
/** How far outside every other mallet's reach the predicted puck must stay to be drawn in local time, and the extra it needs to go there. */
const SAFE_MARGIN = 0.02;
const SAFE_ENTER = 0.05;
/** Time constant of the offset that hides corrections to the predicted puck. A bigger correction is a jump. */
const CORRECTION_MS = 80;
const MAX_CORRECTION = 0.5;
/** A server event is the same as a shown predicted one of its kind and seat this many ticks either side. */
const MATCH_TICKS = 3;
/** How long shown events are remembered, so a late server copy of a predicted one is still recognised. */
const MEMORY_TICKS = 60;
/** The room's rules for which events reach clients (see room.ts), applied to predicted ones. */
const HIT_EVENT_GAP = 4;
const SAME_SPOT = 0.02;
const SAME_SPOT_TICKS = 30;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

export interface Snap {
  k: number;
  puck: [number, number, number, number];
  mallets: ([number, number] | 0)[];
  hitter: number;
  /** By seat, the sequence number of the last pointer sample the server applied, or -1. */
  acks: number[];
}

/** Predicts from a snapshot with your input as it is now. `live` says whether the puck is in play at that snapshot. */
export type Predictor = (snap: Snap, live: boolean) => Prediction | null;

export interface View {
  puck: Vec | null;
  speed: number;
  mallets: (Vec | null)[];
  hitter: number;
  /** Your mallet in local time, when there is a prediction. */
  mallet: Vec | null;
  due: Due[];
  /** True once per serve, on the first frame the served puck is visible. */
  served: boolean;
}

export type Due = { kind: 'event'; e: WireEvent } | { kind: 'goal'; goal: GoalInfo };

interface Fired {
  k: number;
  e: WireEvent;
  predicted: boolean;
  /** A predicted event the server has since confirmed. */
  matched: boolean;
  /** Last tick this spot was touched, which keeps a held puck quiet. */
  seen: number;
}

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
  /** The puck is hidden for display ticks in [hiddenFrom, showFrom): from a goal until the next serve. */
  private hiddenFrom = Infinity;
  private showFrom = Infinity;
  /** The last frame hid the puck at a predicted goal. */
  private guessedGoal = false;
  /**
   * The tick the puck is drawn at. It runs between the interpolated past and local time, never goes back, and moves
   * between the two slowly enough that the puck never jumps.
   */
  private puckTick = -Infinity;
  private viewedAt = -Infinity;
  private ahead = false;
  /** What the last frame drew the puck from. */
  private base: { snap: Snap; live: boolean; predicted: boolean; lead: Prediction | null } | null = null;
  /** Added to the drawn puck so a correction from a new snapshot fades in instead of jumping. */
  private offsetX = 0;
  private offsetY = 0;
  private fired: Fired[] = [];
  /** Recent ticks the puck was drawn past in local time, ahead of the snapshots. */
  private guessed: number[] = [];

  /** `warp` is WARP_SPEED unless the page asks for another, to compare how catching up looks. */
  constructor(private warp = WARP_SPEED) {}

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

  /** The sequence number of the last sample the server applied for a seat, as of the newest snapshot. */
  ack(seat: number): number {
    return this.snaps.at(-1)?.acks[seat] ?? -1;
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
    this.puckTick = -Infinity;
    this.viewedAt = -Infinity;
    this.ahead = false;
    this.base = null;
    this.offsetX = this.offsetY = 0;
    this.fired = [];
    this.guessed = [];
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
    this.snaps.push({ k: msg.k, puck: msg.p, mallets: msg.m, hitter: msg.h, acks: msg.a });
    if (this.snaps.length > 40) this.snaps.shift();
    for (const e of msg.e) this.arrive(msg.k, e);
  }

  onGoal(k: number, goal: GoalInfo): void {
    this.queue.push({ k, due: { kind: 'goal', goal } });
    // Set on arrival rather than when due, so a later serve message always wins even if frames were paused. A puck
    // already hidden at a predicted goal stays hidden.
    this.hiddenFrom = this.guessedGoal ? Math.min(k, this.puckTick) : k;
    this.showFrom = Infinity;
  }

  /**
   * The interpolated past: the server tick other mallets are drawn at. It never goes back, so when the clock re-anchors
   * or slews back they pause instead of rewinding.
   */
  renderTick(now: number): number {
    if (!Number.isFinite(this.offset)) return 0;
    this.shownTick = Math.max(this.shownTick, (now - this.offset - this.delay) / TICK_MS);
    return this.shownTick;
  }

  /**
   * Everything one frame draws. With a predictor the puck runs ahead into local time while no other mallet can reach it,
   * and your mallet is drawn in local time.
   */
  view(now: number, predict: Predictor | null = null): View {
    const newest = this.snaps.at(-1);
    if (!newest) return { puck: null, speed: 0, mallets: [], hitter: -1, mallet: null, due: [], served: false };
    const past = this.renderTick(now);
    const dt = Number.isFinite(this.viewedAt) ? Math.max(0, now - this.viewedAt) : 0;
    this.viewedAt = now;
    const phase = this.room?.phase;
    const live = phase === 'playing' && this.visibleAt(newest.k);
    // While acks stop coming, keep drawing from the last prediction instead of falling back to a stale snapshot.
    const pred = predict?.(newest, live) ?? (predict && live && this.base?.snap === newest ? this.base.lead : null);
    const lead = pred && pred.puck.length > 0 ? pred : null;

    const from = Number.isFinite(this.puckTick) ? this.puckTick : past;
    this.puckTick = this.advance(from, past, newest, lead, dt / TICK_MS);
    const tick = this.puckTick;

    const decay = Math.exp(-dt / CORRECTION_MS);
    this.offsetX *= decay;
    this.offsetY *= decay;
    const base = this.base;
    if (base && (base.predicted || lead) && (base.snap !== newest || base.predicted !== !!lead)) {
      // Your own input is the same in both, so only what the server changed is smoothed.
      const old = base.predicted ? (predict?.(base.snap, base.live) ?? base.lead) : null;
      const was = this.puckAt(tick, base.snap, old && old.puck.length > 0 ? old : null);
      const is = this.puckAt(tick, newest, lead);
      this.offsetX += was.x - is.x;
      this.offsetY += was.y - is.y;
    }
    this.base = { snap: newest, live, predicted: !!lead, lead };

    let served = false;
    if (tick >= this.showFrom) {
      this.hiddenFrom = this.showFrom = Infinity;
      served = true;
    }
    this.guessedGoal = !!lead && tick >= lead.goal;
    const hidden = phase === 'countdown' || (tick >= this.hiddenFrom && tick < this.showFrom) || this.guessedGoal;
    if (hidden || served || Math.hypot(this.offsetX, this.offsetY) > MAX_CORRECTION) this.offsetX = this.offsetY = 0;

    const due = this.fire(from, tick, newest.k, lead);

    if (phase === 'countdown' || phase === 'playing' || phase === 'scored') {
      const late = past > newest.k ? 1 : 0;
      this.late += (late - this.late) * (1 - Math.exp(-Math.max(0, now - this.sampledAt) / LATE_MS));
    }
    this.sampledAt = now;
    const state = this.puckAt(tick, newest, lead);
    return {
      puck: hidden ? null : { x: state.x + this.offsetX, y: state.y + this.offsetY },
      speed: Math.hypot(state.vx, state.vy),
      mallets: this.malletsAt(past),
      hitter: state.hitter,
      mallet: pred?.mallet ?? null,
      due,
      served,
    };
  }

  private visibleAt(k: number): boolean {
    return k < this.hiddenFrom || k >= this.showFrom;
  }

  /**
   * Moves the puck's tick toward local time when the predicted path stays out of every other mallet's reach, and back
   * toward the past otherwise. The rate limit keeps the change in the puck's apparent speed under WARP_SPEED.
   */
  private advance(from: number, past: number, newest: Snap, lead: Prediction | null, ticks: number): number {
    const speedAt = (t: number) => {
      const s = this.puckAt(t, newest, lead);
      return Math.hypot(s.vx, s.vy);
    };
    // The puck may speed up within the frame, so the limits hold for the faster end of it.
    const speed = Math.max(speedAt(from), speedAt(from + MAX_RATE * ticks));
    const fast = Math.min(MAX_RATE, 1 + this.warp / speed);
    const slow = Math.max(MIN_RATE, 1 - this.warp / speed);
    const need = SAFE_MARGIN + (this.ahead ? 0 : SAFE_ENTER);
    // The first state is the snapshot itself, which no mallet can change.
    this.ahead = !!lead && lead.clear.every((c, i) => i === 0 || c > need);
    const target = this.ahead ? lead!.L : past;
    const next = clamp(target, from + (this.ahead ? slow : MIN_RATE) * ticks, from + fast * ticks);
    // When local time steps back a tick the puck carries on slowly into the extra predicted ticks instead of stopping.
    const top = lead ? Math.max(past, Math.min(lead.puck.at(-1)!.t, Math.max(lead.L, from + slow * ticks))) : Infinity;
    return Math.max(from, clamp(next, past, top));
  }

  /** The events of every tick the puck's timeline crossed this frame: the server's up to the newest snapshot, predicted ones after it. */
  private fire(from: number, to: number, newest: number, lead: Prediction | null): Due[] {
    const due: Due[] = [];
    this.queue = this.queue.filter((q) => {
      if (q.k > to) return true;
      if (newest - q.k <= STALE_TICKS) {
        due.push(q.due);
        if (q.due.kind === 'event') this.fired.push({ k: q.k, e: q.due.e, predicted: false, matched: false, seen: q.k });
      }
      return false;
    });
    if (lead) {
      const end = Math.min(to, lead.puck.at(-1)!.t);
      for (let k = Math.max(Math.floor(from), newest) + 1; k <= end; k++) this.guessed.push(k);
      for (const { k, e } of lead.events) {
        if (k <= from || k > to || (e[0] === 0 && e[4] !== lead.seat) || this.quiet(k, e)) continue;
        due.push({ kind: 'event', e });
        this.fired.push({ k, e, predicted: true, matched: false, seen: k });
      }
    }
    const keep = to - Math.max(SAME_SPOT_TICKS, MEMORY_TICKS);
    this.fired = this.fired.filter((f) => f.seen > keep);
    this.guessed = this.guessed.filter((k) => k > keep);
    return due;
  }

  /** Queues a server event, unless a predicted one already showed it, or its tick was shown in local time too long ago. */
  private arrive(k: number, e: WireEvent): void {
    const twin = this.fired.find(
      (f) => f.predicted && !f.matched && f.e[0] === e[0] && f.e[4] === e[4] && Math.abs(f.k - k) <= MATCH_TICKS,
    );
    if (twin) {
      twin.matched = true;
      return;
    }

    this.queue.push({ k, due: { kind: 'event', e } });
  }

  /** True for a predicted event a client wouldn't get from the server, or one the server already sent. */
  private quiet(k: number, e: WireEvent): boolean {
    for (const f of this.fired) {
      if (f.e[4] !== e[4]) continue;
      if (!f.predicted && f.e[0] === e[0] && Math.abs(f.k - k) <= MATCH_TICKS) return true;
      if (k - f.seen < SAME_SPOT_TICKS && Math.hypot(f.e[1] - e[1], f.e[2] - e[2]) < SAME_SPOT) {
        f.seen = k;
        return true;
      }
      if (e[0] === 0 && k - f.k < HIT_EVENT_GAP) return true;
    }
    return false;
  }

  /** The puck at a tick: from snapshots up to `base`, then from the prediction made from it, extrapolating a little past both. */
  private puckAt(t: number, base: Snap, lead: Prediction | null): PuckState {
    if (!lead || t <= base.k) return this.snapAt(t, base.k);
    const s = lead.puck;
    const end = s[s.length - 1];
    if (t >= end.t) {
      const extra = Math.min(MAX_EXTRAPOLATE_MS, (t - end.t) * TICK_MS) / 1000;
      return { ...end, t, x: end.x + end.vx * extra, y: end.y + end.vy * extra };
    }
    let i = 0;
    while (i < s.length - 2 && s[i + 1].t <= t) i++;
    const a = s[i];
    const b = s[i + 1] ?? a;
    const f = b.t > a.t ? clamp((t - a.t) / (b.t - a.t), 0, 1) : 0;
    return {
      t,
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      vx: a.vx + (b.vx - a.vx) * f,
      vy: a.vy + (b.vy - a.vy) * f,
      hitter: f < 1 ? a.hitter : b.hitter,
    };
  }

  /** The puck at a tick from the snapshots up to tick `upTo`, extrapolating a little past them. */
  private snapAt(t: number, upTo: number): PuckState {
    const snaps = this.snaps;
    let i = snaps.length - 1;
    while (i > 0 && (snaps[i].k > t || snaps[i].k > upTo)) i--;
    const a = snaps[i];
    const b = snaps[i + 1] && snaps[i + 1].k <= upTo ? snaps[i + 1] : a;
    const span = b.k - a.k;
    const f = span > 0 ? clamp((t - a.k) / span, 0, 1) : 0;
    const jump = Math.hypot(b.puck[0] - a.puck[0], b.puck[1] - a.puck[1]) > TELEPORT;
    const [ax, ay, avx, avy] = a.puck;
    if (span > 0 && !jump) {
      return { t, x: ax + (b.puck[0] - ax) * f, y: ay + (b.puck[1] - ay) * f, vx: avx, vy: avy, hitter: a.hitter };
    }
    const extra = Math.min(MAX_EXTRAPOLATE_MS, Math.max(0, (t - a.k) * TICK_MS)) / 1000;
    const c = jump && f >= 1 ? b : a;
    const [x, y, vx, vy] = c.puck;
    return { t, x: x + (jump ? 0 : vx * extra), y: y + (jump ? 0 : vy * extra), vx, vy, hitter: c.hitter };
  }

  private malletsAt(t: number): (Vec | null)[] {
    const snaps = this.snaps;
    let i = snaps.length - 1;
    while (i > 0 && snaps[i].k > t) i--;
    const a = snaps[i];
    const b = snaps[i + 1] ?? a;
    const span = b.k - a.k;
    const f = span > 0 ? clamp((t - a.k) / span, 0, 1) : 0;
    return a.mallets.map((ma, seat) => {
      const mb = b.mallets[seat];
      if (!ma) return null;
      if (!mb || span === 0) return { x: ma[0], y: ma[1] };
      return { x: ma[0] + (mb[0] - ma[0]) * f, y: ma[1] + (mb[1] - ma[1]) * f };
    });
  }
}
