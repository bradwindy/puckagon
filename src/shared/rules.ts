import type { GoalKind } from './protocol';
import type { ScoreMode } from './settings';

/**
 * The point goes to the last player other than the conceder to touch the puck, so a defender who
 * grazes a shot on its way in doesn't rob the shooter. It is only an own goal when nobody else has
 * touched the puck since the serve.
 */
export function resolveGoal(mode: ScoreMode, seat: number, touches: number[]): { scorer: number; kind: GoalKind } {
  const scorer = touches.find((s) => s !== seat) ?? -1;
  if (mode === 'lives') return { scorer, kind: 'life' };
  if (scorer >= 0) return { scorer, kind: 'score' };
  return { scorer: -1, kind: touches[0] === seat ? 'own' : 'none' };
}
