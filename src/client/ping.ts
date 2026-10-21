const FAIR_MS = 80;
/** A ping this high shows red, and marks the player as lagging on the table. */
export const SLOW_MS = 150;
/** Playback is unstable when more than this share of frames run past the newest snapshot. */
export const UNSTABLE_RATE = 0.05;

export type PingLevel = 'good' | 'fair' | 'bad';

export const pingLevel = (ms: number): PingLevel => (ms < FAIR_MS ? 'good' : ms < SLOW_MS ? 'fair' : 'bad');
