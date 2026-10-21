export type ZoneMode = 'wedge' | 'free';
export type ScoreMode = 'points' | 'lives';
export type Speed = 'chill' | 'normal' | 'chaos';
export type Size = 'S' | 'M' | 'L';

export interface Settings {
  zone: ZoneMode;
  mode: ScoreMode;
  target: number;
  speed: Speed;
  goal: Size;
  mallet: Size;
}

export const DEFAULT_SETTINGS: Settings = {
  zone: 'wedge',
  mode: 'points',
  target: 7,
  speed: 'normal',
  goal: 'M',
  mallet: 'M',
};

export const TARGET_MIN = 3;
export const TARGET_MAX = 15;

export const SPEEDS: Record<Speed, { max: number; serve: number; friction: number }> = {
  chill: { max: 1.5, serve: 0.55, friction: 0.25 },
  normal: { max: 2.3, serve: 0.75, friction: 0.15 },
  chaos: { max: 3.4, serve: 1.05, friction: 0.06 },
};

export const GOAL_FRACTION: Record<Size, number> = { S: 0.3, M: 0.42, L: 0.56 };
export const MALLET_SCALE: Record<Size, number> = { S: 1.3, M: 1.6, L: 2.0 };

function pick<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

export function sanitizeSettings(input: unknown, prev: Settings = DEFAULT_SETTINGS): Settings {
  const s = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const target = Number.isInteger(s.target) ? (s.target as number) : prev.target;
  return {
    zone: pick(s.zone, ['wedge', 'free'] as const, prev.zone),
    mode: pick(s.mode, ['points', 'lives'] as const, prev.mode),
    target: Math.min(TARGET_MAX, Math.max(TARGET_MIN, target)),
    speed: pick(s.speed, ['chill', 'normal', 'chaos'] as const, prev.speed),
    goal: pick(s.goal, ['S', 'M', 'L'] as const, prev.goal),
    mallet: pick(s.mallet, ['S', 'M', 'L'] as const, prev.mallet),
  };
}
