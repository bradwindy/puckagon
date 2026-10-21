import { describe, expect, it } from 'vitest';
import { insideConvex, makeLayout, MAX_SEATS, MIN_SEATS } from '../src/shared/geometry';
import { createWorld, placeMallet, serve, step, type SimEvent, type World } from '../src/shared/physics';
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings';

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
