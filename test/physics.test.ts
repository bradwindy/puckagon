import { describe, expect, it } from 'vitest';
import { goalPosts, insideConvex, makeLayout, MAX_SEATS, MIN_SEATS } from '../src/shared/geometry';
import {
  createWorld,
  MALLET_MAX_SPEED,
  placeMallet,
  serve,
  setTarget,
  step,
  type SimEvent,
  type World,
} from '../src/shared/physics';
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings';
import { add, norm, scale, type Vec } from '../src/shared/vec';

const DT = 1 / 60;

function world(seats: number, settings: Partial<Settings> = {}): World {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const w = createWorld(makeLayout(seats, s), s, () => 0.5);
  w.frozen = false;
  return w;
}

function run(w: World, seconds: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < seconds / DT; i++) {
    const e = step(w, DT);
    events.push(...e);
    if (e.some((x) => x.k === 'goal')) break;
  }
  return events;
}

function aimAtGoal(w: World, seat: number, speed: number): void {
  const side = w.layout.sides[w.layout.goalSide[seat]];
  w.puck = { x: 0, y: 0, vx: -side.normal.x * speed, vy: -side.normal.y * speed };
}

describe('step', () => {
  it('scores into the goal the puck enters', () => {
    const w = world(5);
    aimAtGoal(w, 3, 2);
    const goals = run(w, 2).filter((e) => e.k === 'goal');
    expect(goals).toEqual([expect.objectContaining({ k: 'goal', seat: 3 })]);
  });

  it('bounces off a closed goal instead of scoring', () => {
    const w = world(4);
    w.open[1] = false;
    aimAtGoal(w, 1, 2);
    const events = run(w, 1);
    expect(events.some((e) => e.k === 'goal')).toBe(false);
    expect(events.some((e) => e.k === 'wall')).toBe(true);
    const side = w.layout.sides[w.layout.goalSide[1]];
    expect(w.puck.vx * side.normal.x + w.puck.vy * side.normal.y).toBeGreaterThan(0);
  });

  it('a moving mallet launches a resting puck and records the hitter', () => {
    const w = world(3);
    w.puck = { x: 0, y: 0.25, vx: 0, vy: 0 };
    placeMallet(w, 0, { x: 0, y: 0.45 });
    w.mallets[0]!.tx = 0;
    w.mallets[0]!.ty = 0.2;
    const events = run(w, 0.2);
    expect(events.some((e) => e.k === 'hit' && e.seat === 0)).toBe(true);
    expect(w.lastHitter).toBe(0);
    expect(w.puck.vy).toBeLessThan(-1);
  });

  it.each(Array.from({ length: MAX_SEATS - MIN_SEATS + 1 }, (_, i) => i + MIN_SEATS))(
    'never lets a chaos-speed puck escape a closed %i-player table',
    (n) => {
      const w = world(n, { speed: 'chaos' });
      w.open = w.open.map(() => false);
      for (let shot = 0; shot < 24; shot++) {
        const a = (shot / 24) * Math.PI * 2 + 0.1;
        w.puck = { x: 0, y: 0, vx: Math.cos(a) * 10, vy: Math.sin(a) * 10 };
        for (let i = 0; i < 120; i++) {
          step(w, DT);
          expect(insideConvex(w.puck, w.layout.verts)).toBe(true);
        }
      }
    },
  );

  it.each([2, 3, 4, 5, 6])('never traps the puck inside a mallet pushed into a corner of a %i-player table', (n) => {
    for (const mallet of ['S', 'M', 'L'] as const) {
      const w = world(n, { mallet });
      const { puckR, malletR } = w.layout;
      const side = w.layout.sides[w.layout.goalSide[0]];
      for (const corner of [side.a, side.b]) {
        placeMallet(w, 0, { x: corner.x * 0.6, y: corner.y * 0.6 });
        const m = w.mallets[0]!;
        const dx = corner.x - m.x;
        const dy = corner.y - m.y;
        const dl = Math.hypot(dx, dy);
        const gap = puckR + malletR + 0.02;
        w.puck = { x: m.x + (dx / dl) * gap, y: m.y + (dy / dl) * gap, vx: 0, vy: 0 };
        setTarget(w, 0, { x: corner.x * 1.5, y: corner.y * 1.5 });
        let embeddedTicks = 0;
        for (let i = 0; i < 5 / DT; i++) {
          step(w, DT);
          if (puckR + malletR - Math.hypot(w.puck.x - m.x, w.puck.y - m.y) > 0.005) embeddedTicks++;
        }
        expect(embeddedTicks * DT).toBeLessThan(0.25);
      }
    }
  });

  it.each(
    (['wall', 'goal post', 'mallet'] as const).flatMap((holder) =>
      ([[2, 'free'], [3, 'wedge'], [12, 'wedge']] as const).map(([seats, zone]) => [holder, seats, zone] as const),
    ),
  )('never lets a mallet cover a puck it presses into a %s on a %i-seat %s table', (holder, seats, zone) => {
    for (const mallet of ['S', 'M', 'L'] as const) {
      for (const speed of [1, 8]) {
        const w = world(seats, { mallet, zone });
        const { puckR, malletR, goalHalf } = w.layout;
        const gap = puckR + malletR;
        const side = w.layout.sides[w.layout.goalSide[1]];
        // The puck rests against the holder at `spot` and seat 1 drives its mallet from `from` through the puck, along
        // `push`, until it reaches the holder. The wall spot is just beside seat 1's goal, where every zone lets the
        // mallet reach it head on.
        let push = scale(side.normal, -1);
        let spot: Vec = add(side.mid, scale(side.tangent, -goalHalf - 2 * puckR));
        if (holder === 'goal post') spot = goalPosts(w.layout, 1)[1];
        if (holder === 'mallet') {
          // A free mallet waits in front of seat 1's goal. A wedge one waits in the corner its wedge shares with seat 1's.
          if (zone === 'wedge') push = norm(side.a);
          placeMallet(w, 0, zone === 'free' ? add(side.mid, push) : side.a);
          spot = w.mallets[0]!;
        }
        const rest = holder === 'mallet' ? gap : puckR;
        w.puck = { ...add(spot, scale(push, -rest - 0.001)), vx: 0, vy: 0 };
        const from = add(w.puck, scale(push, -0.25));
        const to = add(spot, scale(push, 0.1));
        placeMallet(w, 1, from);
        const d = Math.hypot(to.x - from.x, to.y - from.y);
        for (let i = 1; i <= 60; i++) {
          const k = Math.min(1, (speed * i * DT) / d);
          setTarget(w, 1, { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k });
          if (step(w, DT).some((e) => e.k === 'goal')) break;
          for (const m of w.mallets) if (m) expect(gap - Math.hypot(w.puck.x - m.x, w.puck.y - m.y)).toBeLessThan(0.001);
        }
      }
    }
  });

  it('keeps a puck that a mallet holds against a wall still, instead of rattling between them', () => {
    const w = world(2, { zone: 'free' });
    w.puck = { x: 0.55 - w.layout.puckR - 0.001, y: 0.4, vx: 0, vy: 0 };
    placeMallet(w, 1, { x: 0.1, y: 0.4 });
    setTarget(w, 1, { x: 1, y: 0.4 });
    for (let i = 1; i <= 60; i++) {
      const walls = step(w, DT).filter((e) => e.k === 'wall');
      if (i > 30) expect(walls.length).toBeLessThanOrEqual(1);
    }
    expect(Math.hypot(w.puck.vx, w.puck.vy)).toBeLessThan(0.01);
  });

  it.each(['chill', 'normal', 'chaos'] as const)(
    'lets a hard swing beat the %s speed cap for a moment, so the puck flies off instead of riding the mallet',
    (speed) => {
      for (const hand of [3, 5, 8]) {
        const w = world(2, { speed });
        w.open = w.open.map(() => false);
        const { puckR, malletR } = w.layout;
        const max = w.speed.max;
        w.puck = { x: 0, y: 0.4, vx: 0, vy: 0 };
        placeMallet(w, 0, { x: 0, y: 0.75 });
        let contactTicks = 0;
        const speeds: number[] = [];
        for (let i = 1; i <= 30; i++) {
          setTarget(w, 0, { x: 0, y: Math.max(0.05, 0.75 - hand * i * DT) });
          step(w, DT);
          const m = w.mallets[0]!;
          if (Math.hypot(w.puck.x - m.x, w.puck.y - m.y) < puckR + malletR + 1e-6) contactTicks++;
          speeds.push(Math.hypot(w.puck.vx, w.puck.vy));
        }
        const peak = Math.max(...speeds);
        const fastTicks = speeds.filter((s) => s > max * 1.25).length;
        expect(contactTicks).toBeLessThanOrEqual(1);
        expect(peak).toBeGreaterThan(max * 1.25);
        expect(peak).toBeLessThanOrEqual(MALLET_MAX_SPEED * 1.05);
        expect(fastTicks * DT).toBeLessThan(0.35);
      }
    },
  );

  it('keeps wedge mallets apart where two zones meet, and a puck on the line can still be hit', () => {
    const w = world(2);
    const { malletR } = w.layout;
    w.puck = { x: 0.3, y: 0, vx: 0, vy: 0 };
    placeMallet(w, 0, { x: -0.3, y: 0.3 });
    placeMallet(w, 1, { x: -0.3, y: -0.3 });
    setTarget(w, 0, { x: -0.3, y: 0 });
    setTarget(w, 1, { x: -0.3, y: 0 });
    const events: SimEvent[] = [];
    for (let i = 0; i < 60; i++) {
      if (i === 30) setTarget(w, 0, { x: 0.5, y: 0 });
      events.push(...step(w, DT));
      const [a, b] = w.mallets;
      expect(Math.hypot(a!.x - b!.x, a!.y - b!.y)).toBeGreaterThan(2 * malletR - 0.001);
    }
    expect(events.some((e) => e.k === 'hit' && e.seat === 0)).toBe(true);
  });

  it('serves at rest inside the receiving seat’s own zone', () => {
    for (const n of [2, 3, 7, 12]) {
      const w = world(n);
      serve(w, n - 1);
      expect(w.puck.vx).toBe(0);
      expect(w.puck.vy).toBe(0);
      expect(insideConvex(w.puck, w.layout.wedges[n - 1])).toBe(true);
    }
  });

  it('nudges a puck that has stopped so play never stalls', () => {
    const w = world(2);
    w.puck = { x: 0.2, y: 0.3, vx: 0, vy: 0 };
    run(w, 3.2);
    expect(Math.hypot(w.puck.vx, w.puck.vy)).toBeGreaterThan(0.1);
  });
});
