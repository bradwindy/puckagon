import { makeLayout, type Layout } from '../shared/geometry';
import { TICK_HZ, type GoalInfo, type PublicPlayer, type RoomMsg, type SnapMsg, type WireEvent } from '../shared/protocol';
import type { Vec } from '../shared/vec';

const TICK_MS = 1000 / TICK_HZ;
const DELAY_MS = 75;
const TELEPORT = 0.25;
const MAX_EXTRAPOLATE_MS = 100;

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
  private offset = Infinity;
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

  onRoom(msg: RoomMsg): void {
    const prev = this.room;
    this.room = msg;
    const key = `${msg.seats}:${msg.settings.goal}:${msg.settings.mallet}`;
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      this.layout = makeLayout(msg.seats, msg.settings);
    }
    if (msg.phase === 'lobby') {
      this.snaps = [];
      this.queue = [];
      this.hiddenFrom = this.showFrom = Infinity;
    }
    if (msg.phase === 'playing' && prev?.phase !== 'playing') {
      this.hiddenFrom = -Infinity;
      this.showFrom = (this.snaps.at(-1)?.k ?? 0) + 1;
    }
  }

  /** True once per serve, on the first frame the served puck is visible. */
  takeServe(): boolean {
    const served = this.served;
    this.served = false;
    return served;
  }

  onSnap(msg: SnapMsg, now: number): void {
    const lastK = this.snaps.at(-1)?.k ?? -1;
    if (msg.k <= lastK) {
      this.snaps = [];
      this.queue = [];
      this.offset = Infinity;
    }
    this.offset = Math.min(this.offset + 0.02, now - msg.k * TICK_MS);
    this.snaps.push({ k: msg.k, puck: msg.p, mallets: msg.m, hitter: msg.h });
    if (this.snaps.length > 40) this.snaps.shift();
    for (const e of msg.e) this.queue.push({ k: msg.k, due: { kind: 'event', e } });
  }

  onGoal(k: number, goal: GoalInfo): void {
    this.queue.push({ k, due: { kind: 'goal', goal } });
  }

  renderTick(now: number): number {
    return Number.isFinite(this.offset) ? (now - this.offset - DELAY_MS) / TICK_MS : 0;
  }

  /** Events whose tick the rendered timeline has reached. */
  takeDue(now: number): Due[] {
    const tick = this.renderTick(now);
    const due: Due[] = [];
    this.queue = this.queue.filter((q) => {
      if (q.k > tick) return true;
      if (q.due.kind === 'goal') {
        this.hiddenFrom = q.k;
        this.showFrom = Infinity;
      }
      due.push(q.due);
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
    const hidden = this.room?.phase === 'countdown' || (tick >= this.hiddenFrom && tick < this.showFrom);
    return {
      puck: hidden ? null : { x: px, y: py },
      speed: Math.hypot(a.puck[2], a.puck[3]),
      mallets,
      hitter: a.hitter,
    };
  }
}
