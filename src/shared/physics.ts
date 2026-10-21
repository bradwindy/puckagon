import { clampToConvex, goalPosts, type Layout, zoneFor } from './geometry';
import { SPEEDS, type Settings } from './settings';
import { len, norm, rotate, sub, type Vec } from './vec';

export const MALLET_MAX_SPEED = 8;
const MALLET_RESTITUTION = 0.9;
const WALL_RESTITUTION = 0.88;
const HIT_EVENT_MIN = 0.12;
const WALL_EVENT_MIN = 0.2;
const IDLE_SPEED = 0.06;
const IDLE_NUDGE_AFTER = 3;
/**
 * A hard swing can send the puck past the table's top speed for a moment, up to a bit faster than a mallet can move, so
 * the puck leaves the mallet behind instead of riding it.
 */
const SPEED_CEILING = MALLET_MAX_SPEED * 1.05;
/** How fast, per second, speed above the table's top speed dies away. The further over it is, the faster it goes. */
const SOFT_CAP_DECAY = 6;

export interface Puck {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface Mallet {
  x: number;
  y: number;
  tx: number;
  ty: number;
}

export type SimEvent =
  | { k: 'hit'; x: number; y: number; s: number; seat: number }
  | { k: 'wall'; x: number; y: number; s: number }
  | { k: 'goal'; seat: number; x: number; y: number };

export interface World {
  layout: Layout;
  zone: Settings['zone'];
  speed: (typeof SPEEDS)[Settings['speed']];
  puck: Puck;
  mallets: (Mallet | null)[];
  open: boolean[];
  lastHitter: number;
  /** Seats that have touched the puck since it was served, most recent first, each once. */
  touches: number[];
  frozen: boolean;
  idle: number;
  rng: () => number;
}

export function createWorld(layout: Layout, settings: Settings, rng: () => number = Math.random): World {
  return {
    layout,
    zone: settings.zone,
    speed: SPEEDS[settings.speed],
    puck: { x: 0, y: 0, vx: 0, vy: 0 },
    mallets: Array.from({ length: layout.seats }, () => null),
    open: Array.from({ length: layout.seats }, () => true),
    lastHitter: -1,
    touches: [],
    frozen: true,
    idle: 0,
    rng,
  };
}

export function placeMallet(world: World, seat: number, p: Vec): void {
  const c = clampToConvex(p, zoneFor(world.layout, seat, world.zone));
  world.mallets[seat] = { x: c.x, y: c.y, tx: c.x, ty: c.y };
}

export function setTarget(world: World, seat: number, p: Vec): void {
  const m = world.mallets[seat];
  if (!m) return;
  const c = clampToConvex(p, zoneFor(world.layout, seat, world.zone));
  m.tx = c.x;
  m.ty = c.y;
}

export function resetPuck(world: World): void {
  world.puck = { x: 0, y: 0, vx: 0, vy: 0 };
  world.frozen = true;
  world.lastHitter = -1;
  world.touches = [];
  world.idle = 0;
}

/**
 * Gives a seat possession, like a real table after a goal: the puck is set down at rest in front of
 * that seat's goal. A seat < 0, or one whose goal is closed, means a random open seat.
 */
export function serve(world: World, seat: number): void {
  const open = world.open.map((o, i) => (o ? i : -1)).filter((i) => i >= 0);
  const target = seat >= 0 && world.open[seat] ? seat : (open[Math.floor(world.rng() * open.length)] ?? 0);
  const side = world.layout.sides[world.layout.goalSide[target]];
  const depth = len(side.mid);
  resetPuck(world);
  world.puck.x = side.mid.x + side.normal.x * depth * 0.55;
  world.puck.y = side.mid.y + side.normal.y * depth * 0.55;
  world.frozen = false;
}

function capSpeed(p: Puck, max: number): void {
  const s = Math.hypot(p.vx, p.vy);
  if (s > max) {
    p.vx = (p.vx / s) * max;
    p.vy = (p.vy / s) * max;
  }
}

function softCap(p: Puck, max: number, dt: number): void {
  const s = Math.hypot(p.vx, p.vy);
  if (s <= max) return;
  const k = (max + (s - max) * Math.exp(-SOFT_CAP_DECAY * (s / max) * dt)) / s;
  p.vx *= k;
  p.vy *= k;
}

/**
 * Pushes overlapping mallets apart along the line between them, half each, keeping each inside its zone. When a zone
 * edge holds one back, or several crowd into one spot, the next round moves them apart further.
 */
function separateMallets(world: World): void {
  const { layout, mallets } = world;
  const minD = 2 * layout.malletR;
  for (let round = 0; round < 8; round++) {
    let moved = false;
    for (let a = 0; a < mallets.length; a++) {
      for (let b = a + 1; b < mallets.length; b++) {
        const ma = mallets[a];
        const mb = mallets[b];
        if (!ma || !mb) continue;
        let dx = mb.x - ma.x;
        let dy = mb.y - ma.y;
        const dist = Math.hypot(dx, dy);
        if (dist >= minD - 1e-3) continue;
        if (dist < 1e-9) {
          dx = Math.cos(layout.facing[b]) - Math.cos(layout.facing[a]);
          dy = Math.sin(layout.facing[b]) - Math.sin(layout.facing[a]);
        }
        const push = (minD - dist) / 2 / Math.hypot(dx, dy);
        const pa = clampToConvex({ x: ma.x - dx * push, y: ma.y - dy * push }, zoneFor(layout, a, world.zone));
        const pb = clampToConvex({ x: mb.x + dx * push, y: mb.y + dy * push }, zoneFor(layout, b, world.zone));
        if (Math.hypot(pa.x - ma.x, pa.y - ma.y) + Math.hypot(pb.x - mb.x, pb.y - mb.y) > 1e-4) moved = true;
        ma.x = pa.x;
        ma.y = pa.y;
        mb.x = pb.x;
        mb.y = pb.y;
      }
    }
    if (!moved) return;
  }
}

function bounce(p: Puck, nx: number, ny: number, e: number): number {
  const vn = p.vx * nx + p.vy * ny;
  if (vn >= 0) return 0;
  p.vx -= (1 + e) * vn * nx;
  p.vy -= (1 + e) * vn * ny;
  return -vn;
}

/** Advances the world by dt seconds. Returns what happened. Stops early on a goal. */
export function step(world: World, dt: number): SimEvent[] {
  const events: SimEvent[] = [];
  const { layout, puck } = world;
  const r = layout.puckR;
  const rm = layout.malletR;
  const maxMove = MALLET_MAX_SPEED * dt;

  const moves = world.mallets.map((m) => {
    if (!m) return null;
    let dx = m.tx - m.x;
    let dy = m.ty - m.y;
    const d = Math.hypot(dx, dy);
    if (d > maxMove) {
      dx *= maxMove / d;
      dy *= maxMove / d;
    }
    return { dx, dy, vx: dx / dt, vy: dy / dt };
  });

  const longest = Math.max(Math.hypot(puck.vx, puck.vy) * dt, maxMove);
  const substeps = Math.min(24, Math.max(1, Math.ceil(longest / (r * 0.4))));
  const h = dt / substeps;
  const posts = world.open.map((open, seat) => (open ? goalPosts(layout, seat) : null));

  for (let i = 1; i <= substeps; i++) {
    for (let seat = 0; seat < moves.length; seat++) {
      const mv = moves[seat];
      const m = world.mallets[seat];
      if (!mv || !m) continue;
      m.x += mv.dx / substeps;
      m.y += mv.dy / substeps;
      if (world.zone === 'wedge') {
        // A mallet pushed aside by a neighbour carries on from where it was pushed, so keep it in its zone.
        const c = clampToConvex(m, zoneFor(layout, seat, world.zone));
        m.x = c.x;
        m.y = c.y;
      }
    }
    if (world.zone === 'wedge') separateMallets(world);
    if (world.frozen) continue;

    puck.x += puck.vx * h;
    puck.y += puck.vy * h;

    for (let seat = 0; seat < moves.length; seat++) {
      const mv = moves[seat];
      const m = world.mallets[seat];
      if (!mv || !m) continue;
      const dx = puck.x - m.x;
      const dy = puck.y - m.y;
      const dist = Math.hypot(dx, dy);
      const minD = r + rm;
      if (dist >= minD) continue;
      const nx = dist > 1e-9 ? dx / dist : 0;
      const ny = dist > 1e-9 ? dy / dist : -1;
      puck.x = m.x + nx * minD;
      puck.y = m.y + ny * minD;
      const rvx = puck.vx - mv.vx;
      const rvy = puck.vy - mv.vy;
      const rvn = rvx * nx + rvy * ny;
      if (rvn < 0) {
        const impulse = -(1 + MALLET_RESTITUTION) * rvn;
        puck.vx += nx * impulse;
        puck.vy += ny * impulse;
        world.lastHitter = seat;
        if (world.touches[0] !== seat) world.touches = [seat, ...world.touches.filter((s) => s !== seat)];
        const s = Math.min(1, impulse / world.speed.max);
        if (s > HIT_EVENT_MIN) events.push({ k: 'hit', x: m.x + nx * rm, y: m.y + ny * rm, s, seat });
      }
    }

    for (const pair of posts) {
      if (!pair) continue;
      for (const post of pair) {
        const dx = puck.x - post.x;
        const dy = puck.y - post.y;
        const dist = Math.hypot(dx, dy);
        if (dist >= r || dist < 1e-9) continue;
        const nx = dx / dist;
        const ny = dy / dist;
        puck.x = post.x + nx * r;
        puck.y = post.y + ny * r;
        const s = bounce(puck, nx, ny, WALL_RESTITUTION) / world.speed.max;
        if (s > WALL_EVENT_MIN) events.push({ k: 'wall', x: post.x, y: post.y, s: Math.min(1, s) });
      }
    }

    for (const side of layout.sides) {
      const d = (puck.x - side.a.x) * side.normal.x + (puck.y - side.a.y) * side.normal.y;
      if (d >= r) continue;
      const hasGoal = side.owner >= 0 && world.open[side.owner];
      if (hasGoal) {
        const t = (puck.x - side.mid.x) * side.tangent.x + (puck.y - side.mid.y) * side.tangent.y;
        if (Math.abs(t) < layout.goalHalf) {
          if (d < 0) {
            events.push({ k: 'goal', seat: side.owner, x: puck.x, y: puck.y });
            return events;
          }
          continue;
        }
      }
      puck.x += side.normal.x * (r - d);
      puck.y += side.normal.y * (r - d);
      const s = bounce(puck, side.normal.x, side.normal.y, WALL_RESTITUTION) / world.speed.max;
      if (s > WALL_EVENT_MIN) {
        events.push({ k: 'wall', x: puck.x - side.normal.x * r, y: puck.y - side.normal.y * r, s: Math.min(1, s) });
      }
    }

    // A puck held by a wall, a post or another mallet stops a mallet that is still pressing into it, for the rest of
    // the tick. A mallet that its zone edge keeps from backing off pushes the puck aside instead, which lets a mallet
    // later in the loop give way.
    for (let seat = 0; seat < moves.length; seat++) {
      const mv = moves[seat];
      const m = world.mallets[seat];
      if (!mv || !m) continue;
      const dx = m.x - puck.x;
      const dy = m.y - puck.y;
      const dist = Math.hypot(dx, dy);
      const minD = r + rm;
      if (dist >= minD - 1e-6 || dist < 1e-9) continue;
      const c = clampToConvex(
        { x: puck.x + (dx / dist) * minD, y: puck.y + (dy / dist) * minD },
        zoneFor(layout, seat, world.zone),
      );
      m.x = c.x;
      m.y = c.y;
      mv.dx = mv.dy = mv.vx = mv.vy = 0;
      const ex = puck.x - m.x;
      const ey = puck.y - m.y;
      const left = Math.hypot(ex, ey);
      if (left < 1e-9) continue;
      const nx = ex / left;
      const ny = ey / left;
      if (left < minD - 1e-6) {
        puck.x = m.x + nx * minD;
        puck.y = m.y + ny * minD;
      }
      // Drop the puck's speed into the stopped mallet, or it bounces between the mallet and its holder every substep.
      const vn = puck.vx * nx + puck.vy * ny;
      if (vn < 0) {
        puck.vx -= vn * nx;
        puck.vy -= vn * ny;
      }
    }

    capSpeed(puck, SPEED_CEILING);
  }

  if (!world.frozen) {
    softCap(puck, world.speed.max, dt);
    const decay = Math.exp(-world.speed.friction * dt);
    puck.vx *= decay;
    puck.vy *= decay;
    if (Math.hypot(puck.vx, puck.vy) < IDLE_SPEED) {
      world.idle += dt;
      if (world.idle > IDLE_NUDGE_AFTER) {
        const toCentre = len({ x: puck.x, y: puck.y }) > 0.05 ? norm(sub({ x: 0, y: 0 }, puck)) : { x: 1, y: 0 };
        const dir = rotate(toCentre, (world.rng() - 0.5) * 1.2);
        puck.vx = dir.x * world.speed.serve * 0.6;
        puck.vy = dir.y * world.speed.serve * 0.6;
        world.idle = 0;
      }
    } else {
      world.idle = 0;
    }
  }

  return events;
}
