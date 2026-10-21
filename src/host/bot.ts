import { clampToConvex, homePosition, zoneFor } from '../shared/geometry';
import type { World } from '../shared/physics';
import type { BotLevel } from '../shared/protocol';
import { add, dot, len, norm, rotate, scale, sub, v, type Vec } from '../shared/vec';

interface Skill {
  /** Top mallet speed, world units per second. */
  speed: number;
  /** Ticks between decisions. */
  react: number;
  /** Random error added to every aim point. */
  noise: number;
  /** How far ahead (seconds) the bot predicts the puck. */
  lead: number;
  /** Largest error (radians) when aiming a shot at a goal. */
  aimError: number;
  /** How closely the bot tracks the puck across its goal mouth when defending, 0 to 1. */
  keep: number;
}

export const BOT_SKILL: Record<BotLevel, Skill> = {
  easy: { speed: 1.7, react: 12, noise: 0.07, lead: 0, aimError: 0.6, keep: 0.55 },
  medium: { speed: 2.9, react: 6, noise: 0.035, lead: 0.07, aimError: 0.3, keep: 0.8 },
  hard: { speed: 4.6, react: 2, noise: 0.012, lead: 0.12, aimError: 0.08, keep: 1 },
};

export interface BotBrain {
  aim: Vec;
  wait: number;
  shootAt: number;
}

export function newBrain(): BotBrain {
  return { aim: v(0, 0), wait: 0, shootAt: -1 };
}

function decide(world: World, seat: number, skill: Skill, brain: BotBrain, rng: () => number): Vec {
  const { layout, puck } = world;
  const side = layout.sides[layout.goalSide[seat]];
  const zone = zoneFor(layout, seat, world.zone);
  const mallet = world.mallets[seat]!;
  const jitter = () => v((rng() - 0.5) * 2 * skill.noise, (rng() - 0.5) * 2 * skill.noise);
  if (world.frozen) return homePosition(layout, seat, world.zone);

  const reach = layout.puckR + layout.malletR;
  const pred = v(puck.x + puck.vx * skill.lead, puck.y + puck.vy * skill.lead);
  const touchable = len(sub(clampToConvex(pred, zone), pred)) < reach * 0.9;
  const incoming = -(puck.vx * side.normal.x + puck.vy * side.normal.y);

  // A fast puck heading for goal gets blocked, not lined up, or the swing knocks it in.
  if (touchable && incoming < 0.5) {
    const open = world.open.map((o, s) => (o && s !== seat ? s : -1)).filter((s) => s >= 0);
    if (!open.includes(brain.shootAt)) brain.shootAt = open[Math.floor(rng() * open.length)] ?? -1;
    const goal = brain.shootAt >= 0 ? layout.sides[layout.goalSide[brain.shootAt]].mid : v(0, 0);
    const dir = rotate(norm(sub(goal, pred)), (rng() - 0.5) * 2 * skill.aimError);
    const perp = v(-dir.y, dir.x);
    const rel = sub(v(mallet.x, mallet.y), pred);
    const along = dot(rel, dir);
    const across = dot(rel, perp);
    // Lined up behind the puck: drive through it.
    if (along < -reach * 0.7 && Math.abs(across) < layout.malletR * 0.6) return add(pred, scale(dir, layout.malletR * 1.5));
    // Behind but off line: slide onto the line.
    if (along < -reach * 0.3) return add(sub(pred, scale(dir, reach * 1.05)), jitter());
    // On the wrong side: go round the puck instead of through it, so it is not knocked backwards.
    const side = across >= 0 ? 1 : -1;
    return add(add(pred, scale(perp, side * reach * 1.7)), scale(dir, -reach * 0.5));
  }

  let lateral = dot(sub(v(puck.x, puck.y), side.mid), side.tangent) * 0.5;
  if (incoming > 0.05) {
    const distance = dot(sub(v(puck.x, puck.y), side.a), side.normal);
    const t = distance / incoming;
    lateral = dot(sub(v(puck.x + puck.vx * t, puck.y + puck.vy * t), side.mid), side.tangent);
  }
  lateral = Math.max(-layout.goalHalf, Math.min(layout.goalHalf, lateral * skill.keep));
  return add(add(side.mid, add(scale(side.tangent, lateral), scale(side.normal, layout.malletR * 2.5))), jitter());
}

/** Where a bot wants its mallet this tick. Moves at the bot's own top speed toward its latest decision. */
export function botTarget(world: World, seat: number, level: BotLevel, brain: BotBrain, rng: () => number, dt: number): Vec | null {
  const mallet = world.mallets[seat];
  if (!mallet) return null;
  const skill = BOT_SKILL[level];
  if (--brain.wait <= 0) {
    brain.aim = decide(world, seat, skill, brain, rng);
    brain.wait = skill.react;
  }
  const delta = sub(brain.aim, v(mallet.x, mallet.y));
  const dist = len(delta);
  const maxStep = skill.speed * dt;
  return dist <= maxStep ? brain.aim : add(v(mallet.x, mallet.y), scale(delta, maxStep / dist));
}
