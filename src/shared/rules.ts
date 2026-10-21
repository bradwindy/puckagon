import type { GoalKind } from './protocol';
import type { ScoreMode } from './settings';

export function resolveGoal(mode: ScoreMode, seat: number, lastHitter: number): { scorer: number; kind: GoalKind } {
  const scorer = lastHitter >= 0 && lastHitter !== seat ? lastHitter : -1;
  if (mode === 'lives') return { scorer, kind: 'life' };
  if (scorer >= 0) return { scorer, kind: 'score' };
  return { scorer: -1, kind: lastHitter === seat ? 'own' : 'none' };
}
