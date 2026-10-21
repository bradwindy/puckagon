import { homePosition, makeLayout } from '../shared/geometry';
import { createWorld, placeMallet, resetPuck, serve, setTarget, step, type World } from '../shared/physics';
import {
  COUNTDOWN_MS,
  MAX_SAMPLES,
  RECONNECT_GRACE_MS,
  round,
  SCORED_MS,
  SNAP_EVERY,
  TICK_HZ,
  type BotLevel,
  type HostMsg,
  type MatchMsg,
  type Phase,
  type SeatState,
  type WireEvent,
} from '../shared/protocol';
import { HIT_EVENT_GAP, resolveGoal, SAME_SPOT, SAME_SPOT_TICKS } from '../shared/rules';
import type { Settings } from '../shared/settings';
import type { Vec } from '../shared/vec';
import { botTarget, newBrain, type BotBrain } from './bot';
import type { MatchInit } from './messages';

export interface MatchIO {
  /** To every guest and to the host's own page. `reliable` picks the channel. */
  send(msg: HostMsg, reliable: boolean): void;
  /** To the party server. */
  report(msg: MatchMsg): void;
  random(): number;
}

type MatchPhase = Exclude<Phase, 'lobby'>;

interface Seated {
  id: string;
  seat: number;
  bot: BotLevel | null;
  score: number;
  lives: number;
  out: boolean;
  linked: boolean;
  /** While unlinked, when the player's game link went down, or when the match began if it was never up (ms). */
  downAt: number;
}

interface Sample extends Vec {
  seq: number;
}

interface Inputs {
  queue: Sample[];
  /** Highest sequence number taken so far. Guests repeat every unacked sample, so anything at or below it is a repeat. */
  high: number;
  /** Sequence number of the last sample a tick applied, or -1. */
  applied: number;
  /** The fewest samples left waiting after a tick, over the ticks since the last check. */
  spare: number;
  watched: number;
}

const STEP_MS = 1000 / TICK_HZ;
const ticks = (ms: number) => Math.round(ms / STEP_MS);
const COUNTDOWN_TICKS = ticks(COUNTDOWN_MS);
const SCORED_TICKS = ticks(SCORED_MS);
/** Pointer samples a player may have waiting. More would add lag after a burst of late messages. */
const INPUT_QUEUE = 4;
/**
 * A player who always had a sample to spare over this many ticks skips one, so the wait a burst of messages leaves
 * behind drains away instead of adding lag for the rest of the match.
 */
const DRAIN_TICKS = 8;
const SPOTS_KEPT = 4;

/**
 * One match's game rules, run by the party host's page. Players are keyed by public id.
 * Time only moves through tick(), one fixed physics step per call. `now` arguments only drive the link grace.
 */
export class Match {
  phase: MatchPhase = 'countdown';
  readonly settings: Settings;
  world: World | null;

  private readonly match: number;
  private readonly seats: number;
  private readonly host: string;
  private players: Seated[];
  private winner: string | null = null;
  private v = 0;
  /** Tick the current phase began on, and the ticks its pause had left then. */
  private phaseTick = 0;
  private phaseTimer = COUNTDOWN_TICKS;
  private timer = COUNTDOWN_TICKS;
  private lastConceded = -1;
  private tickCount = 0;
  private brains = new Map<string, BotBrain>();
  private inputs = new Map<string, Inputs>();
  private spots = new Map<number, { k: number; x: number; y: number }[]>();

  constructor(
    private io: MatchIO,
    init: MatchInit,
    now: number,
  ) {
    this.match = init.match;
    this.settings = init.settings;
    this.seats = init.seats;
    this.host = init.host;
    const linked = new Set([init.host, ...init.linked]);
    this.players = init.players
      .filter((p) => p.seat >= 0 && p.seat < init.seats)
      .map((p) => ({
        id: p.id,
        seat: p.seat,
        bot: p.bot,
        score: 0,
        lives: init.settings.target,
        out: false,
        linked: p.bot !== null || linked.has(p.id),
        downAt: now,
      }));
    const layout = makeLayout(this.seats, this.settings);
    this.world = createWorld(layout, this.settings, io.random);
    for (const p of this.players) placeMallet(this.world, p.seat, homePosition(layout, p.seat, this.settings.zone));
    this.publish();
  }

  get over(): boolean {
    return this.phase === 'over';
  }

  /**
   * Queues pointer samples, flattened oldest first as [x0, y0, x1, y1, ...] and numbered from `s`. tick() applies one per
   * step and snapshots report the number of the last one applied. Samples already taken are skipped.
   */
  input(id: string, s: unknown, q: unknown): void {
    const p = this.find(id);
    if (!this.world || !p || p.bot || p.out) return;
    if (typeof s !== 'number' || !Number.isSafeInteger(s) || s < 0) return;
    if (!Array.isArray(q) || q.length % 2 !== 0 || q.length > MAX_SAMPLES * 2 || !q.every(Number.isFinite)) return;
    let inputs = this.inputs.get(id);
    if (!inputs) this.inputs.set(id, (inputs = { queue: [], high: -1, applied: -1, spare: Infinity, watched: 0 }));
    const clamp = (n: number) => Math.max(-2, Math.min(2, n));
    for (let i = 0; i < q.length; i += 2) {
      const seq = s + i / 2;
      if (seq <= inputs.high) continue;
      inputs.queue.push({ x: clamp(q[i] as number), y: clamp(q[i + 1] as number), seq });
      inputs.high = seq;
    }
    inputs.queue = inputs.queue.slice(-INPUT_QUEUE);
  }

  /**
   * A guest's game link opened or closed. A new link may come from a reloaded page that numbers its samples from 0
   * again, so it starts that player's inputs over.
   */
  link(id: string, up: boolean, now: number): void {
    const p = this.find(id);
    if (this.over || !p || p.bot || id === this.host) return;
    if (up) this.inputs.delete(id);
    if (p.linked === up) return;
    p.linked = up;
    p.downAt = now;
    this.publish();
  }

  /** The player pressed Leave, so their goal closes at once. */
  quit(id: string): void {
    const p = this.find(id);
    if (this.over || !p || p.out) return;
    this.knockOut(p);
    if (!this.checkWinner()) this.publish();
  }

  /** One fixed physics step of 1/TICK_HZ seconds. */
  tick(now: number): void {
    const world = this.world;
    if (!world || this.over) return;
    this.tickCount++;
    this.expireLinks(now);
    if (this.over) return;
    this.driveBots(world);
    this.drivePeople(world);

    if (this.phase === 'countdown' || this.phase === 'scored') {
      this.timer--;
      if (this.timer <= 0) {
        serve(world, this.phase === 'scored' ? this.lastConceded : -1);
        this.enter('playing', 0);
      }
    }

    const events: WireEvent[] = [];
    for (const e of step(world, 1 / TICK_HZ)) {
      if (e.k === 'goal') {
        if (this.phase === 'playing') this.goal(e.seat, e.x, e.y);
      } else {
        const seat = e.k === 'hit' ? e.seat : -1;
        if (this.quiet(seat, e.x, e.y, e.k === 'hit')) continue;
        events.push([e.k === 'hit' ? 0 : 1, round(e.x), round(e.y), round(e.s), seat]);
      }
    }

    if (this.over) return;
    if (events.length) this.io.send({ t: 'e', n: this.match, k: this.tickCount, e: events }, true);
    if (this.tickCount % SNAP_EVERY === 0) this.sendSnap(world);
  }

  private find(id: string): Seated | undefined {
    return this.players.find((p) => p.id === id);
  }

  private seatPlayer(seat: number): Seated | undefined {
    return this.players.find((p) => p.seat === seat);
  }

  private seatState(seat: number): SeatState {
    const p = this.seatPlayer(seat);
    if (!p) return { score: 0, lives: 0, out: true, linked: true };
    return { score: p.score, lives: p.lives, out: p.out, linked: p.linked };
  }

  /** Bumps the version and tells everyone, guests and the party server alike. */
  private publish(): void {
    const msg: MatchMsg = {
      t: 'match',
      match: this.match,
      v: ++this.v,
      phase: this.phase,
      k: this.phaseTick,
      timer: Math.round(this.phaseTimer * STEP_MS),
      seats: Array.from({ length: this.seats }, (_, s) => this.seatState(s)),
      winner: this.winner,
    };
    this.io.send(msg, true);
    this.io.report(msg);
  }

  /** Starts a phase on this tick, with a pause of `pause` ticks, and publishes it. */
  private enter(phase: MatchPhase, pause: number): void {
    this.phase = phase;
    this.phaseTick = this.tickCount;
    this.phaseTimer = this.timer = pause;
    this.publish();
  }

  /** Knocks out seated people whose game link has been down for the whole grace. */
  private expireLinks(now: number): void {
    let changed = false;
    for (const p of this.players) {
      if (p.linked || p.out || now - p.downAt < RECONNECT_GRACE_MS) continue;
      this.knockOut(p);
      changed = true;
    }
    if (changed && !this.checkWinner()) this.publish();
  }

  /** True for an event clients shouldn't get: a repeat of a held contact, or a hit too soon after the seat's last one. */
  private quiet(seat: number, x: number, y: number, hit: boolean): boolean {
    const spots = (this.spots.get(seat) ?? []).filter((p) => this.tickCount - p.k < SAME_SPOT_TICKS);
    this.spots.set(seat, spots);
    const same = spots.find((p) => Math.hypot(x - p.x, y - p.y) < SAME_SPOT);
    if (same) {
      same.k = this.tickCount;
      return true;
    }
    const last = spots.at(-1);
    if (hit && last && this.tickCount - last.k < HIT_EVENT_GAP) return true;
    spots.push({ k: this.tickCount, x, y });
    if (spots.length > SPOTS_KEPT) spots.shift();
    return false;
  }

  private driveBots(world: World): void {
    for (const p of this.players) {
      if (!p.bot || p.out) continue;
      let brain = this.brains.get(p.id);
      if (!brain) this.brains.set(p.id, (brain = newBrain()));
      const target = botTarget(world, p.seat, p.bot, brain, this.io.random, 1 / TICK_HZ);
      if (target) setTarget(world, p.seat, target);
    }
  }

  /** Moves each person's mallet to their next queued sample. With nothing queued it holds its last target. */
  private drivePeople(world: World): void {
    for (const p of this.players) {
      const inputs = this.inputs.get(p.id);
      if (p.bot || p.out || !inputs) continue;
      if (inputs.watched >= DRAIN_TICKS) {
        if (inputs.spare > 0) inputs.queue.shift();
        inputs.spare = Infinity;
        inputs.watched = 0;
      }
      const next = inputs.queue.shift();
      if (next) {
        setTarget(world, p.seat, next);
        inputs.applied = next.seq;
      }
      inputs.spare = Math.min(inputs.spare, inputs.queue.length);
      inputs.watched++;
    }
  }

  private sendSnap(world: World): void {
    const { puck } = world;
    const acks = world.mallets.map(() => -1);
    for (const p of this.players) {
      const applied = this.inputs.get(p.id)?.applied;
      if (applied !== undefined) acks[p.seat] = applied;
    }
    this.io.send(
      {
        t: 's',
        n: this.match,
        k: this.tickCount,
        p: [round(puck.x), round(puck.y), round(puck.vx), round(puck.vy)],
        m: world.mallets.map((m) => (m ? [round(m.x), round(m.y)] : 0)),
        h: world.lastHitter,
        a: acks,
      },
      false,
    );
  }

  private goal(seat: number, x: number, y: number): void {
    const world = this.world;
    if (!world) return;
    const { scorer, kind } = resolveGoal(this.settings.mode, seat, world.touches);
    const conceder = this.seatPlayer(seat);
    if (kind === 'score') {
      const p = this.seatPlayer(scorer);
      if (p) p.score++;
    }
    if (kind === 'life' && conceder) {
      conceder.lives = Math.max(0, conceder.lives - 1);
      if (conceder.lives === 0) this.knockOut(conceder);
    }
    resetPuck(world);
    this.lastConceded = seat;
    this.io.send({ t: 'goal', n: this.match, k: this.tickCount, seat, scorer, kind, x: round(x), y: round(y) }, true);
    if (!this.checkWinner()) this.enter('scored', SCORED_TICKS);
  }

  private knockOut(p: Seated): void {
    p.out = true;
    if (!this.world) return;
    this.world.open[p.seat] = false;
    this.world.mallets[p.seat] = null;
    this.world.touches = this.world.touches.filter((s) => s !== p.seat);
    if (this.world.lastHitter === p.seat) this.world.lastHitter = -1;
  }

  /** Ends the match once one player is left standing, or someone reaches the target in points mode. */
  private checkWinner(): boolean {
    const alive = this.players.filter((p) => !p.out);
    let winner: Seated | undefined;
    if (alive.length <= 1) winner = alive[0];
    else if (this.settings.mode === 'points') winner = alive.find((p) => p.score >= this.settings.target);
    if (!winner && alive.length > 1) return false;
    this.winner = winner?.id ?? null;
    this.world = null;
    this.enter('over', 0);
    return true;
  }
}
