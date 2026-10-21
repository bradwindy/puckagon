import { insideConvex, type Layout } from '../shared/geometry';
import { createWorld, MALLET_MAX_SPEED, setTarget, step, type SimEvent, type World } from '../shared/physics';
import { round, TICK_HZ, type WireEvent } from '../shared/protocol';
import type { Settings } from '../shared/settings';
import { closestOnSegment, type Vec } from '../shared/vec';
import type { InputSampler } from './input';
import type { Predictor, Snap } from './state';

const DT = 1 / TICK_HZ;
/** With more of your samples than this still to apply, the server is not keeping up with them, so prediction stops. */
const MAX_UNACKED = 30;
/** A partial step shorter than this, as a share of a tick, is skipped. */
const MIN_FRAC = 1e-3;
/**
 * Ticks predicted past local time with the pointer held, so the puck can keep moving when local time steps back a
 * tick, as it does when the server drops a queued sample.
 */
const EXTRA_TICKS = 2;

export interface PuckState {
  /** Server tick, fractional for the partial step at the end. */
  t: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hitter: number;
}

export interface Prediction {
  seat: number;
  /** Tick of the snapshot it starts from. */
  k: number;
  /** Local time: the tick your current pointer will reach the server. */
  L: number;
  /** Puck states from tick k to a little past L. Empty when the puck is not in play. */
  puck: PuckState[];
  /** By puck state, how far the puck is outside every other mallet's reach, in table units. Negative is inside it. */
  clear: number[];
  /** Predicted events as the server would send them, each at the tick it falls in. */
  events: { k: number; e: WireEvent }[];
  /** Tick of a predicted goal, or Infinity. */
  goal: number;
  /** Your mallet at L. */
  mallet: Vec;
}

export interface PredictInput {
  layout: Layout;
  settings: Settings;
  seat: number;
  /** By seat, whether its goal is open. */
  open: boolean[];
  snap: Snap;
  /** Whether the puck is in play at the snapshot. Otherwise only your mallet moves. */
  live: boolean;
  /** The sample the server applied at the snapshot, which is still your mallet's target, or null when unknown. */
  applied: Vec | null;
  /** Your samples after it, oldest first, one per tick. */
  next: Vec[];
  /** Where the pointer puts your mallet now, and how far now is into the next sample interval, 0 to 1. */
  pointer: Vec;
  frac: number;
}

function wire(e: Exclude<SimEvent, { k: 'goal' }>): WireEvent {
  return e.k === 'hit' ? [0, round(e.x), round(e.y), round(e.s), e.seat] : [1, round(e.x), round(e.y), round(e.s), -1];
}

function distToConvex(p: Vec, poly: Vec[]): number {
  if (insideConvex(p, poly)) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const q = closestOnSegment(p, poly[i], poly[(i + 1) % poly.length]);
    best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
  }
  return best;
}

/**
 * How far a puck at `p`, `ticks` after the snapshot, is outside the reach of every mallet but yours. A mallet can be
 * anywhere it could have moved since the snapshot and, in wedge mode, inside its zone.
 */
function clearance(world: World, seat: number, snap: Snap, p: Vec, ticks: number): number {
  const { layout } = world;
  const reach = layout.puckR + layout.malletR;
  let clear = Infinity;
  snap.mallets.forEach((m, s) => {
    if (!m || s === seat) return;
    let c = Math.hypot(p.x - m[0], p.y - m[1]) - reach - MALLET_MAX_SPEED * ticks * DT;
    if (world.zone === 'wedge') c = Math.max(c, distToConvex(p, layout.wedges[s]) - reach);
    clear = Math.min(clear, c);
  });
  return clear;
}

/**
 * Runs the server's physics forward from a snapshot with your own samples, one per tick, then a partial tick toward the
 * pointer. Other mallets stay where the snapshot has them.
 */
export function predict(input: PredictInput): Prediction | null {
  const { layout, seat, snap } = input;
  if (!snap.mallets[seat]) return null;
  const world = createWorld(layout, input.settings);
  world.open = [...input.open];
  world.mallets = snap.mallets.map((m) => (m ? { x: m[0], y: m[1], tx: m[0], ty: m[1] } : null));
  if (input.applied) setTarget(world, seat, input.applied);
  const [x, y, vx, vy] = snap.puck;
  world.puck = { x, y, vx, vy };
  world.lastHitter = snap.hitter;
  world.frozen = !input.live;

  const out: Prediction = { seat, k: snap.k, L: snap.k, puck: [], clear: [], events: [], goal: Infinity, mallet: { x: 0, y: 0 } };
  const record = (t: number) => {
    if (!input.live) return;
    const { puck } = world;
    const prev = out.puck.at(-1);
    out.puck.push({ t, x: puck.x, y: puck.y, vx: puck.vx, vy: puck.vy, hitter: world.lastHitter });
    // Halfway between states the puck can be nearer a mallet than at either end.
    const between = prev ? Math.hypot(puck.x - prev.x, puck.y - prev.y) / 2 : 0;
    out.clear.push(clearance(world, seat, snap, puck, t - snap.k) - between);
  };
  const advance = (target: Vec, dt: number, t: number) => {
    setTarget(world, seat, target);
    for (const e of step(world, dt)) {
      if (e.k !== 'goal') {
        out.events.push({ k: Math.ceil(t), e: wire(e) });
      } else if (out.goal === Infinity) {
        out.goal = t;
        world.frozen = true;
      }
    }
    record(t);
  };

  record(snap.k);
  input.next.forEach((s, i) => advance(s, DT, snap.k + i + 1));
  out.L = snap.k + input.next.length;
  if (input.frac > MIN_FRAC) {
    out.L += input.frac;
    advance(input.pointer, input.frac * DT, out.L);
  }
  const mallet = world.mallets[seat]!;
  out.mallet = { x: mallet.x, y: mallet.y };
  if (input.live) for (let i = 1; i <= EXTRA_TICKS; i++) advance(input.pointer, DT, out.L + i);
  return out;
}

/** Predicts for `seat` from any snapshot, with the samples the server had still to apply at it and the pointer now. */
export function predictor(
  input: InputSampler,
  now: number,
  base: Omit<PredictInput, 'snap' | 'live' | 'applied' | 'next' | 'frac'>,
): Predictor {
  const frac = input.frac(now);
  return (snap, live) => {
    const { applied, next } = input.since(snap.acks[base.seat] ?? -1);
    if (next.length > MAX_UNACKED) return null;
    return predict({ ...base, snap, live, applied, next, frac });
  };
}
