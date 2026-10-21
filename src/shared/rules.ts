import type { GoalKind } from './protocol';
import type { ScoreMode } from './settings';

/** A puck jammed against a mallet makes a hit every tick. Only one hit per seat this many ticks apart reaches clients. */
export const HIT_EVENT_GAP = 4;
/**
 * A held puck touches the same spot every tick. An event this close to one of the last few with the same seat (walls
 * share one key), within this many ticks of it, is the same contact and stays quiet for as long as the hold lasts.
 * Clients apply the same rules to their predicted events.
 */
export const SAME_SPOT = 0.02;
export const SAME_SPOT_TICKS = 30;

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
