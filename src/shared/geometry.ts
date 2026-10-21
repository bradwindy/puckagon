import { GOAL_FRACTION, MALLET_SCALE, type Settings } from './settings';
import { add, closestOnSegment, dot, len, norm, scale, sub, v, type Vec } from './vec';

export const MIN_SEATS = 2;
export const MAX_SEATS = 12;

const RECT_W = 1.1;
const RECT_H = 1.8;

export interface Side {
  a: Vec;
  b: Vec;
  mid: Vec;
  tangent: Vec;
  /** Unit vector pointing into the table. */
  normal: Vec;
  length: number;
  /** Seat whose goal sits on this side, or -1 for a plain wall. */
  owner: number;
}

export interface Layout {
  seats: number;
  verts: Vec[];
  sides: Side[];
  /** seat -> index into sides */
  goalSide: number[];
  /** seat -> angle of the outward direction through the seat's goal */
  facing: number[];
  /** seat -> convex polygon the mallet centre must stay inside, for each zone mode */
  wedges: Vec[][];
  free: Vec[];
  puckR: number;
  malletR: number;
  goalHalf: number;
  extent: number;
}

function makeSide(a: Vec, b: Vec, owner: number): Side {
  const ab = sub(b, a);
  const tangent = norm(ab);
  const mid = scale(add(a, b), 0.5);
  let normal = v(-tangent.y, tangent.x);
  if (dot(normal, mid) > 0) normal = scale(normal, -1);
  return { a, b, mid, tangent, normal, length: len(ab), owner };
}

function centroid(poly: Vec[]): Vec {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return v(x / poly.length, y / poly.length);
}

function inwardNormal(a: Vec, b: Vec, inside: Vec): Vec {
  const t = norm(sub(b, a));
  const n = v(-t.y, t.x);
  return dot(n, sub(inside, a)) >= 0 ? n : scale(n, -1);
}

function intersectLines(p1: Vec, d1: Vec, p2: Vec, d2: Vec): Vec {
  const cross = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(cross) < 1e-12) return p2;
  const w = sub(p2, p1);
  const t = (w.x * d2.y - w.y * d2.x) / cross;
  return add(p1, scale(d1, t));
}

/** Shrinks a convex polygon by moving edge i inwards by insets[i]. */
export function insetPolygon(poly: Vec[], insets: number[]): Vec[] {
  const c = centroid(poly);
  const n = poly.length;
  const lines = poly.map((a, i) => {
    const b = poly[(i + 1) % n];
    const normal = inwardNormal(a, b, c);
    return { p: add(a, scale(normal, insets[i])), d: sub(b, a) };
  });
  return lines.map((line, i) => {
    const prev = lines[(i - 1 + n) % n];
    return intersectLines(prev.p, prev.d, line.p, line.d);
  });
}

/** Keeps the part of a convex polygon where dot(p - origin, normal) >= offset. */
function clipHalfPlane(poly: Vec[], origin: Vec, normal: Vec, offset: number): Vec[] {
  const out: Vec[] = [];
  const side = (p: Vec) => dot(sub(p, origin), normal) - offset;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const sa = side(a);
    const sb = side(b);
    if (sa >= 0) out.push(a);
    if (sa >= 0 !== sb >= 0) out.push(add(a, scale(sub(b, a), sa / (sa - sb))));
  }
  return out;
}

/**
 * Keeps mallets far enough out of each table corner that a puck always fits between them and the
 * corner. Otherwise a mallet held in a sharp corner traps the puck inside itself.
 */
function clearCorners(zone: Vec[], verts: Vec[], puckR: number, malletR: number): Vec[] {
  let clipped = zone;
  verts.forEach((corner, i) => {
    const toPrev = norm(sub(verts[(i - 1 + verts.length) % verts.length], corner));
    const toNext = norm(sub(verts[(i + 1) % verts.length], corner));
    const half = Math.acos(Math.max(-1, Math.min(1, dot(toPrev, toNext)))) / 2;
    const clearance = malletR + puckR + puckR / Math.sin(half) + 0.002;
    clipped = clipHalfPlane(clipped, corner, norm(add(toPrev, toNext)), clearance);
  });
  return clipped;
}

export function insideConvex(p: Vec, poly: Vec[]): boolean {
  const c = centroid(poly);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (dot(inwardNormal(a, b, c), sub(p, a)) < -1e-9) return false;
  }
  return true;
}

export function clampToConvex(p: Vec, poly: Vec[]): Vec {
  if (insideConvex(p, poly)) return p;
  let best = poly[0];
  let bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const q = closestOnSegment(p, poly[i], poly[(i + 1) % poly.length]);
    const d = len(sub(p, q));
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

export function makeLayout(seats: number, settings: Pick<Settings, 'goal' | 'mallet'>): Layout {
  const n = Math.max(MIN_SEATS, Math.min(MAX_SEATS, Math.floor(seats)));
  let verts: Vec[];
  let owners: number[];
  let facing: number[];
  let goalEdge: number;

  if (n === 2) {
    const w = RECT_W / 2;
    const h = RECT_H / 2;
    verts = [v(w, h), v(-w, h), v(-w, -h), v(w, -h)];
    owners = [0, -1, 1, -1];
    facing = [Math.PI / 2, -Math.PI / 2];
    goalEdge = RECT_W;
  } else {
    verts = [];
    facing = [];
    for (let k = 0; k < n; k++) {
      const phi = Math.PI / 2 + (2 * Math.PI * k) / n;
      const angle = phi - Math.PI / n;
      verts.push(v(Math.cos(angle), Math.sin(angle)));
      facing.push(phi);
    }
    owners = verts.map((_, k) => k);
    goalEdge = 2 * Math.sin(Math.PI / n);
  }

  const sides = verts.map((a, i) => makeSide(a, verts[(i + 1) % verts.length], owners[i]));
  const goalSide: number[] = [];
  sides.forEach((s, i) => {
    if (s.owner >= 0) goalSide[s.owner] = i;
  });

  const puckR = Math.min(0.05, Math.max(0.028, 0.045 * goalEdge));
  const malletR = puckR * MALLET_SCALE[settings.mallet];
  const goalHalf = (GOAL_FRACTION[settings.goal] * goalEdge) / 2;

  const origin = v(0, 0);
  const wedges: Vec[][] = [];
  for (let seat = 0; seat < n; seat++) {
    if (n === 2) {
      const w = RECT_W / 2;
      const h = RECT_H / 2;
      const sy = seat === 0 ? 1 : -1;
      const half = [v(-w * sy, 0), v(w * sy, 0), v(w * sy, h * sy), v(-w * sy, h * sy)];
      wedges.push(clearCorners(insetPolygon(half, [0, malletR, malletR, malletR]), verts, puckR, malletR));
    } else {
      const side = sides[goalSide[seat]];
      wedges.push(clearCorners(insetPolygon([origin, side.a, side.b], [0, malletR, 0]), verts, puckR, malletR));
    }
  }
  const free = clearCorners(insetPolygon(verts, verts.map(() => malletR)), verts, puckR, malletR);
  const extent = Math.max(...verts.map(len));

  return { seats: n, verts, sides, goalSide, facing, wedges, free, puckR, malletR, goalHalf, extent };
}

export function zoneFor(layout: Layout, seat: number, mode: Settings['zone']): Vec[] {
  return mode === 'free' ? layout.free : layout.wedges[seat];
}

export function goalPosts(layout: Layout, seat: number): [Vec, Vec] {
  const side = layout.sides[layout.goalSide[seat]];
  return [add(side.mid, scale(side.tangent, -layout.goalHalf)), add(side.mid, scale(side.tangent, layout.goalHalf))];
}

/** Where a seat's mallet rests: inside its zone, a little way out from its goal. */
export function homePosition(layout: Layout, seat: number, mode: Settings['zone']): Vec {
  const side = layout.sides[layout.goalSide[seat]];
  const p = add(side.mid, scale(side.normal, layout.malletR * 2.5));
  return clampToConvex(p, zoneFor(layout, seat, mode));
}
