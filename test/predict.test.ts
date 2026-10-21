import { describe, expect, it } from 'vitest';
import { predict, type Prediction, type PuckState } from '../src/client/predict';
import { GameState, type Predictor, type Snap } from '../src/client/state';
import { makeLayout } from '../src/shared/geometry';
import { TICK_HZ, type RoomMsg, type ServerMsg, type SnapMsg, type WireEvent } from '../src/shared/protocol';
import { DEFAULT_SETTINGS } from '../src/shared/settings';
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
      motion: mallets.map(() => 0),
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

  it('guesses other mallets carry on as they last moved, slowing to a stop', () => {
    const settings = { ...DEFAULT_SETTINGS, zone: 'free' as const };
    const me = { x: -0.3, y: 0.6 };
    const run = (ticks: number) =>
      predict({
        layout: makeLayout(2, settings),
        settings,
        seat: 0,
        open: [true, true],
        snap: { k: 100, puck: [0, 0, 0, 0], mallets: [[me.x, me.y], [0, -0.5]], hitter: -1, acks: [0, -1], motion: [0, [0.02, 0]] },
        live: true,
        applied: me,
        next: Array.from({ length: ticks }, () => me),
        pointer: me,
        frac: 0,
      })!.mallets[1]!;
    expect(run(2).x).toBeGreaterThan(0.02);
    expect(run(30).x).toBeGreaterThan(run(5).x);
    expect(run(30).x).toBeLessThan(0.02 * 3 + 1e-9);
    expect(run(30).y).toBeCloseTo(-0.5);
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

/** A prediction along the same line as the snapshots, `lead` ticks ahead. */
function line(s: Snap, lead: number, events: { k: number; e: WireEvent }[] = []): Prediction {
  const L = s.k + lead;
  const puck = Array.from({ length: lead + 3 }, (_, i) => state(s.k + i));
  return { seat: 0, k: s.k, L, puck, events: events.filter((e) => e.k > s.k), goal: Infinity, mallet: { x: 0, y: 0.7 }, mallets: [], steps: puck.map((p) => ({ t: p.t, mallets: [] })) };
}

interface Frame {
  /** The newest snapshot. */
  k: number;
  /** The tick the puck is drawn at, read from where it is drawn. */
  tick: number;
  past: number;
  /** Local time. */
  local: number;
  events: WireEvent[];
}

/**
 * Plays ticks [from, to): each snapshot arrives LATENCY_MS after its tick, with `events(k)`, and a frame is drawn every
 * tick with a predictor that runs `lead(k)` ticks ahead of the newest snapshot while `predicting(k)`, and predicts
 * `guesses(k)`.
 */
function play(
  st: GameState,
  from: number,
  to: number,
  opts: {
    lead: (k: number) => number;
    predicting: (k: number) => boolean;
    events?: (k: number) => WireEvent[];
    guesses?: (k: number) => { k: number; e: WireEvent }[];
  },
): Frame[] {
  const frames: Frame[] = [];
  let next = from;
  for (let now = from * TICK_MS + LATENCY_MS + 1; now < to * TICK_MS + LATENCY_MS; now += TICK_MS) {
    for (; next < to && next * TICK_MS + LATENCY_MS <= now; next++) st.onSnap(snap(next, opts.events?.(next)), next * TICK_MS + LATENCY_MS);
    const predictor: Predictor = (s) => (opts.predicting(s.k) ? line(s, opts.lead(s.k), opts.guesses?.(s.k)) : null);
    const v = st.view(now, predictor);
    const events = v.due.flatMap((d) => (d.kind === 'event' ? [d.e] : []));
    const k = next - 1;
    if (v.puck) frames.push({ k, tick: (v.puck.x * TICK_HZ) / SPEED, past: st.renderTick(now), local: k + opts.lead(k), events });
  }
  return frames;
}

function playing(aheadMs?: number): GameState {
  const st = new GameState(aheadMs);
  st.onRoom(ROOM);
  return st;
}

describe('display timeline', () => {
  it('draws the puck in local time at a steady speed, never going back or jumping', () => {
    const st = playing();
    // Local time steps back a tick at 200 and 250, as when the server skips a queued sample, and jumps ahead twelve at
    // 400, as when the connection gets slower.
    const lead = (k: number) => (k < 200 ? 12 : k < 250 ? 11 : k < 400 ? 10 : 22);
    const frames = play(st, 1, 700, { lead, predicting: (k) => k >= 100 });
    const eps = 1e-6;
    for (const [i, f] of frames.entries()) {
      if (i === 0) continue;
      const rate = f.tick - frames[i - 1].tick;
      expect(rate).toBeGreaterThanOrEqual(-eps);
      // Following local time changes the speed by at most a fifth. Catching up after a jump fades in over a few frames.
      const settling = (f.k >= 100 && f.k < 115) || (f.k >= 400 && f.k < 415);
      expect(rate).toBeLessThanOrEqual(settling ? 4 : 1.2 + 0.05);
    }
    const at = (k: number) => frames.find((f) => f.k >= k)!;
    expect(at(95).tick - at(95).past).toBeLessThan(0.01);
    expect(Math.abs(at(240).local - at(240).tick)).toBeLessThan(0.01);
    expect(Math.abs(at(390).local - at(390).tick)).toBeLessThan(0.01);
    expect(Math.abs(at(500).local - at(500).tick)).toBeLessThan(0.01);
  });

  it('with ?ahead= draws no further ahead of the server than asked', () => {
    // Snapshots arrive LATENCY_MS after their tick, so the newest one is the server's latest state.
    const frames = play(playing(50), 1, 400, { lead: () => 12, predicting: (k) => k >= 100 });
    const f = frames.find((f) => f.k >= 300)!;
    expect(Math.abs(f.tick - (f.k + 50 / TICK_MS))).toBeLessThan(1);
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
    const frames = play(st, 1, 500, { lead, predicting: (k) => k >= 80, events, guesses });
    const shown = frames.flatMap((f) => f.events);
    expect(shown.filter((e) => e[1] !== 2.5)).toEqual([wall(0.5), hit(0, 1.5), wall(2), wall(4)]);
    expect(shown.filter((e) => e[1] === 2.5)).toHaveLength(1);
  });
});
