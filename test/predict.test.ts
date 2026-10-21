import { describe, expect, it } from 'vitest';
import { predict, type Prediction, type PuckState } from '../src/client/predict';
import { GameState, type Predictor, type Snap } from '../src/client/state';
import { makeLayout } from '../src/shared/geometry';
import { TICK_HZ, type RoomMsg, type ServerMsg, type SnapMsg, type WireEvent } from '../src/shared/protocol';
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings';
import type { Vec } from '../src/shared/vec';
import { Room } from '../src/worker/room';

const TICK_MS = 1000 / TICK_HZ;
const LATENCY_MS = 50;

describe('predict', () => {
  it('matches the server tick for tick when it gets the same samples', () => {
    const sent: ServerMsg[] = [];
    let ids = 0;
    const room = new Room({ send: () => {}, broadcast: (m) => sent.push(m), random: () => 0.5, newId: () => `id${ids++}` });
    room.join('pid-0', 'Me');
    room.join('pid-1', 'You');
    room.start('pid-0');
    let now = 0;
    const tick = () => room.tick((now += TICK_MS));
    while (room.phase !== 'playing') tick();
    const world = room.world!;
    const home = { x: world.mallets[0]!.x, y: world.mallets[0]!.y };
    world.puck = { x: 0.3, y: 0.15, vx: -0.9, vy: 1.6 };
    room.input('pid-0', 0, [home.x, home.y]);
    tick();
    const snap = sent.filter((m): m is SnapMsg => m.t === 's').at(-1)!;
    const { puck, mallets } = room.world!;
    const exact: Snap = {
      k: snap.k,
      puck: [puck.x, puck.y, puck.vx, puck.vy],
      mallets: mallets.map((m) => (m ? [m.x, m.y] : 0)),
      hitter: -1,
      acks: snap.a,
    };
    // A swing up into the puck's path.
    const swing = Array.from({ length: 20 }, (_, i) => ({ x: home.x + 0.12 - i * 0.004, y: home.y - i * 0.03 }));
    const pred = predict({
      layout: room.world!.layout,
      settings: room.settings,
      seat: 0,
      open: [true, true],
      snap: exact,
      live: true,
      applied: home,
      next: swing,
      pointer: swing.at(-1)!,
      frac: 0,
    })!;
    const server: number[][] = [];
    swing.forEach((p, i) => {
      room.input('pid-0', i + 1, [p.x, p.y]);
      tick();
      const q = room.world!.puck;
      server.push([q.x, q.y, q.vx, q.vy]);
    });
    expect(snap.a[0]).toBe(0);
    expect(pred.events.some(({ e }) => e[0] === 0 && e[4] === 0)).toBe(true);
    expect(pred.puck.slice(1, swing.length + 1).map((s) => [s.x, s.y, s.vx, s.vy])).toEqual(server);
  });

  /** A puck drifting along x at y, with the other mallet at `other`, and `unacked` samples of yours still to apply. */
  function clearance(zone: Settings['zone'], y: number, other: Vec, unacked: number): number {
    const settings = { ...DEFAULT_SETTINGS, zone };
    const layout = makeLayout(2, settings);
    const me = { x: -0.3, y: 0.75 };
    const pred = predict({
      layout,
      settings,
      seat: 0,
      open: [true, true],
      snap: { k: 100, puck: [0, y, 0.2, 0], mallets: [[me.x, me.y], [other.x, other.y]], hitter: -1, acks: [0, -1] },
      live: true,
      applied: me,
      next: Array.from({ length: unacked }, () => me),
      pointer: me,
      frac: 0,
    })!;
    return Math.min(...pred.clear.slice(1));
  }

  it('in wedge mode keeps the puck out of reach while it is far enough from every other zone', () => {
    // The other mallet waits on the centre line, as close to your half as its zone allows.
    expect(clearance('wedge', 0.5, { x: 0, y: -0.01 }, 9)).toBeGreaterThan(0.1);
    expect(clearance('wedge', 0.08, { x: 0, y: -0.01 }, 9)).toBeLessThan(0);
    // Near the line but with the other mallet too far away to get there in time.
    expect(clearance('wedge', 0.08, { x: 0, y: -0.75 }, 2)).toBeGreaterThan(0);
  });

  it('in free mode counts how far other mallets could move before the puck gets there', () => {
    expect(clearance('free', 0.5, { x: 0, y: -0.7 }, 3)).toBeGreaterThan(0);
    expect(clearance('free', 0.5, { x: 0, y: -0.7 }, 12)).toBeLessThan(0);
    expect(clearance('free', 0.5, { x: 0.1, y: 0.3 }, 1)).toBeLessThan(0);
  });
});

const ROOM: RoomMsg = { t: 'room', phase: 'playing', host: '', settings: DEFAULT_SETTINGS, players: [], seats: 2, timer: 0, winner: null };
/** Units per second along x, so the drawn puck's x tells the tick it is drawn at. */
const SPEED = 1;
const xAt = (t: number) => (SPEED * t) / TICK_HZ;
const state = (t: number): PuckState => ({ t, x: xAt(t), y: 0, vx: SPEED, vy: 0, hitter: -1 });

function snap(k: number, e: WireEvent[] = []): SnapMsg {
  return { t: 's', k, p: [xAt(k), 0, SPEED, 0], m: [[0, 0.7], [0, -0.7]], h: -1, e, a: [k, -1] };
}

/** A prediction along the same line as the snapshots, `lead` ticks ahead, every state `clear` of other mallets. */
function line(s: Snap, lead: number, clear: number, events: { k: number; e: WireEvent }[] = []): Prediction {
  const L = s.k + lead;
  const puck = Array.from({ length: lead + 3 }, (_, i) => state(s.k + i));
  return { seat: 0, k: s.k, L, puck, clear: puck.map(() => clear), events: events.filter((e) => e.k > s.k), goal: Infinity, mallet: { x: 0, y: 0.7 } };
}

interface Frame {
  /** The newest snapshot. */
  k: number;
  /** The tick the puck is drawn at. */
  tick: number;
  past: number;
  /** Local time. */
  local: number;
  events: WireEvent[];
}

/**
 * Plays ticks [from, to): each snapshot arrives LATENCY_MS after its tick, with `events(k)`, and a frame is drawn every
 * tick with a predictor that runs `lead(k)` ticks ahead of the newest snapshot, is safe while `safe(k)`, and predicts
 * `guesses(k)`.
 */
function play(
  st: GameState,
  from: number,
  to: number,
  opts: {
    lead: (k: number) => number;
    safe: (k: number) => boolean;
    events?: (k: number) => WireEvent[];
    guesses?: (k: number) => { k: number; e: WireEvent }[];
  },
): Frame[] {
  const frames: Frame[] = [];
  let next = from;
  for (let now = from * TICK_MS + LATENCY_MS + 1; now < to * TICK_MS + LATENCY_MS; now += TICK_MS) {
    for (; next < to && next * TICK_MS + LATENCY_MS <= now; next++) st.onSnap(snap(next, opts.events?.(next)), next * TICK_MS + LATENCY_MS);
    const predictor: Predictor = (s) => line(s, opts.lead(s.k), opts.safe(s.k) ? 1 : -1, opts.guesses?.(s.k));
    const v = st.view(now, predictor);
    const events = v.due.flatMap((d) => (d.kind === 'event' ? [d.e] : []));
    const k = next - 1;
    if (v.puck) frames.push({ k, tick: (v.puck.x * TICK_HZ) / SPEED, past: st.renderTick(now), local: k + opts.lead(k), events });
  }
  return frames;
}

function playing(): GameState {
  const st = new GameState();
  st.onRoom(ROOM);
  return st;
}

describe('display timeline', () => {
  it('runs ahead to local time while safe and back to the past when not, never going back or past either end', () => {
    const st = playing();
    // Local time steps back a tick at 200, as when the server drops a queued sample, and five ticks at 250.
    const lead = (k: number) => (k < 200 ? 12 : k < 250 ? 10 : k < 400 ? 4 : 16);
    const frames = play(st, 1, 700, { lead, safe: (k) => k >= 100 && k < 300 });
    const held = (k: number) => k >= 250 && k < 258;
    const eps = 1e-6;
    for (const [i, f] of frames.entries()) {
      expect(f.tick).toBeGreaterThanOrEqual(f.past - eps);
      // After a small step back the puck carries on slowly into the two ticks predicted past local time. After a big
      // one it waits for local time to catch up.
      const over = f.tick - Math.max(f.past, f.local);
      expect(over).toBeLessThanOrEqual(f.k >= 200 && f.k < 206 ? 2 : held(f.k) ? 5 : eps);
      if (i === 0) continue;
      const rate = f.tick - frames[i - 1].tick;
      expect(rate).toBeGreaterThanOrEqual(-eps);
      // At 1 unit a second the puck may run at most 1.6 times as fast and no slower than 0.4, except to keep up with the past.
      expect(rate).toBeLessThanOrEqual(1.6 + 0.05);
      if (f.tick > f.past + eps && !held(f.k)) expect(rate).toBeGreaterThanOrEqual(0.4 - eps);
    }
    const at = (k: number) => frames.find((f) => f.k >= k)!;
    expect(at(95).tick - at(95).past).toBeLessThan(0.01);
    expect(at(240).local - at(240).tick).toBeLessThan(0.01);
    expect(at(290).local - at(290).tick).toBeLessThan(0.01);
    expect(at(690).tick - at(690).past).toBeLessThan(0.01);
  });
});

describe('effects on the display timeline', () => {
  const hit = (seat: number, x: number): WireEvent => [0, x, 0, 0.5, seat];
  const wall = (x: number): WireEvent => [1, x, 0.9, 0.5, -1];

  it('shows each event once, from the prediction or the server, including server events nobody predicted that come late', () => {
    const st = playing();
    // Ahead by 8 ticks from tick 100 to 300, then by 20.
    const lead = (k: number) => (k < 300 ? 8 : 20);
    // The second guess moves a little with each new snapshot, as a predicted bounce does.
    const guesses = (k: number) => [
      { k: 150, e: hit(0, 1.5) },
      { k: 250, e: [1, 2.5, 0.85 + (k % 2) * 0.05, 0.5, -1] as WireEvent },
    ];
    const events = (k: number): WireEvent[] => {
      if (k === 50) return [wall(0.5)];
      // The predicted hit, a tick later than predicted.
      if (k === 151) return [hit(0, 1.51)];
      // Nobody predicted these. The first comes about 8 ticks after the display passed it, the second about 20.
      if (k === 200) return [wall(2)];
      if (k === 400) return [wall(4)];
      return [];
    };
    const frames = play(st, 1, 500, { lead, safe: (k) => k >= 80, events, guesses });
    const shown = frames.flatMap((f) => f.events);
    expect(shown.filter((e) => e[1] !== 2.5)).toEqual([wall(0.5), hit(0, 1.5), wall(2), wall(4)]);
    expect(shown.filter((e) => e[1] === 2.5)).toHaveLength(1);
  });
});
