import { describe, expect, it } from 'vitest';
import { GameState } from '../src/client/state';
import { TICK_HZ, type SnapMsg } from '../src/shared/protocol';
import { DEFAULT_SETTINGS } from '../src/shared/settings';

const TICK_MS = 1000 / TICK_HZ;
const BASE_MS = 30;

function playing(): GameState {
  const st = new GameState();
  st.onRoom({ t: 'room', phase: 'playing', host: '', settings: DEFAULT_SETTINGS, players: [], seats: 2, timer: 0, winner: null });
  return st;
}

/** Each snapshot carries one wall event that records its tick. */
const snap = (k: number): SnapMsg => ({ t: 's', k, p: [0, 0, 0, 0], m: [0, 0], h: -1, e: [[1, k, 0, 0.5, -1]], a: [-1, -1] });

function rng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

interface Frame {
  delay: number;
  /** The frame ran past the newest snapshot. */
  late: boolean;
  /** Ticks of the events that came due. */
  events: number[];
}

/**
 * Sends one snapshot per tick for ticks [from, to), each arriving BASE_MS plus `extra(k)` after it was made but never
 * before the one ahead of it, as on one TCP stream. Renders a frame every tick.
 */
function stream(st: GameState, from: number, to: number, extra: (k: number) => number): Frame[] {
  const arrivals: number[] = [];
  for (let k = from, last = -Infinity; k < to; k++) arrivals.push((last = Math.max(last, k * TICK_MS + BASE_MS + extra(k))));
  const frames: Frame[] = [];
  let next = 0;
  for (let now = from * TICK_MS + 0.5; now < to * TICK_MS; now += TICK_MS) {
    for (; next < arrivals.length && arrivals[next] <= now; next++) st.onSnap(snap(from + next), arrivals[next]);
    if (next === 0) continue;
    const tick = st.renderTick(now);
    const events = st.view(now).due.map((d) => (d.kind === 'event' ? d.e[1] : -1));
    frames.push({ delay: now - BASE_MS - tick * TICK_MS, late: tick > from + next - 1, events });
  }
  return frames;
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1];

describe('GameState clock', () => {
  it('never moves the render clock back when one snapshot is late', () => {
    const st = playing();
    stream(st, 1, 240, () => 0);
    const at = 240 * TICK_MS + BASE_MS + 150;
    const before = st.renderTick(at);
    st.onSnap(snap(240), at);
    expect(st.renderTick(at)).toBeGreaterThanOrEqual(before);
  });

  it('drifts instead of jumping when the route gets slower or faster', () => {
    const st = playing();
    stream(st, 1, 300, () => 0);
    const frames = [...stream(st, 300, 600, () => 20), ...stream(st, 600, 900, () => -20)];
    const steps = frames.slice(1).map((f, i) => Math.abs(f.delay - frames[i].delay));
    expect(Math.max(...steps)).toBeLessThan(2);
  });

  it('shows every event through a server stall and soon plays behind the snapshots again', () => {
    const st = playing();
    // From tick 300 the server has skipped 250 ms of ticks, so every snapshot arrives 250 ms later than the clock expects.
    const frames = stream(st, 1, 600, (k) => (k >= 300 ? 250 : 0));
    const events = frames.flatMap((f) => f.events);
    const dropped = Array.from({ length: events.at(-1)! - events[0] }, (_, i) => events[0] + i).filter((k) => !events.includes(k));
    expect(dropped).toEqual([]);
    // The clock never goes back, so the puck holds still for about the skipped time before playback catches up.
    expect(frames.filter((f) => f.late).length).toBeLessThan(45);
  });

  it('covers recurring spikes, and neither they nor a single hitch hold the delay up afterwards', () => {
    const st = playing();
    const rand = rng(1);
    const spiky = stream(st, 1, 1200, () => rand() * 15 + (rand() < 0.02 ? rand() * 80 : 0)).slice(300);
    const clean = stream(st, 1200, 1800, () => 0);
    expect(spiky.filter((f) => f.late).length / spiky.length).toBeLessThan(0.01);
    expect(median(clean.slice(-60).map((f) => f.delay))).toBeLessThan(40);
    const hitch = stream(st, 1800, 2200, (k) => (k === 1810 ? 150 : 0));
    expect(Math.max(...hitch.slice(-60).map((f) => f.delay))).toBeLessThan(40);
  });
});
