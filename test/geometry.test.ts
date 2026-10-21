import { describe, expect, it } from 'vitest';
import { clampToConvex, homePosition, insideConvex, makeLayout, MAX_SEATS, MIN_SEATS } from '../src/shared/geometry';
import { DEFAULT_SETTINGS } from '../src/shared/settings';

const seatCounts = Array.from({ length: MAX_SEATS - MIN_SEATS + 1 }, (_, i) => i + MIN_SEATS);

describe('makeLayout', () => {
  it('uses a rectangle with goals on the short ends for two players', () => {
    const layout = makeLayout(2, DEFAULT_SETTINGS);
    expect(layout.verts).toHaveLength(4);
    const goals = layout.sides.filter((s) => s.owner >= 0);
    expect(goals).toHaveLength(2);
    for (const side of layout.sides) {
      const shortest = Math.min(...layout.sides.map((s) => s.length));
      expect(side.owner >= 0).toBe(Math.abs(side.length - shortest) < 1e-9);
    }
  });

  it.each(seatCounts.filter((n) => n > 2))('uses a regular %i-gon with one goal per side', (n) => {
    const layout = makeLayout(n, DEFAULT_SETTINGS);
    expect(layout.verts).toHaveLength(n);
    expect(new Set(layout.sides.map((s) => s.owner))).toEqual(new Set(Array.from({ length: n }, (_, i) => i)));
    for (const side of layout.sides) expect(side.length).toBeCloseTo(layout.sides[0].length, 9);
  });

  it.each(seatCounts)('keeps every wedge, home spot and goal mouth inside the %i-player table', (n) => {
    const layout = makeLayout(n, DEFAULT_SETTINGS);
    expect(layout.goalHalf * 2).toBeGreaterThan(layout.puckR * 4);
    for (let seat = 0; seat < n; seat++) {
      for (const p of layout.wedges[seat]) expect(insideConvex(p, layout.verts)).toBe(true);
      expect(insideConvex(homePosition(layout, seat, 'wedge'), layout.wedges[seat])).toBe(true);
      expect(layout.goalHalf).toBeLessThan(layout.sides[layout.goalSide[seat]].length / 2);
    }
  });
});

describe('clampToConvex', () => {
  const square = [
    { x: -1, y: -1 },
    { x: 1, y: -1 },
    { x: 1, y: 1 },
    { x: -1, y: 1 },
  ];

  it('leaves inside points alone and moves outside points onto the nearest edge', () => {
    expect(clampToConvex({ x: 0.2, y: -0.3 }, square)).toEqual({ x: 0.2, y: -0.3 });
    expect(clampToConvex({ x: 3, y: 0.5 }, square)).toEqual({ x: 1, y: 0.5 });
    expect(clampToConvex({ x: 5, y: 5 }, square)).toEqual({ x: 1, y: 1 });
  });
});
