import { INPUT_HEARTBEAT_MS, INPUT_HZ, MAX_SAMPLES, round, SAMPLE_HZ } from '../shared/protocol';
import type { Vec } from '../shared/vec';

const SAMPLE_MS = 1000 / SAMPLE_HZ;
const SAMPLES_PER_SEND = SAMPLE_HZ / INPUT_HZ;
/** A longer gap between frames, such as a hidden tab, starts sampling again instead of filling the gap. */
const RESET_MS = 250;

/** Samples the mallet at SAMPLE_HZ whatever the display rate, and batches the samples to send at INPUT_HZ. */
export class InputSampler {
  /** Samples not yet sent, flattened as [x0, y0, x1, y1, ...]. */
  private pending: number[] = [];
  private nextSampleAt = 0;
  private last: { at: number; x: number; y: number } | null = null;
  private sent: number[] = [];
  private lastSent = 0;

  /** Takes the mallet position for this frame, and returns the samples to send once a batch is ready. */
  sample(now: number, mallet: Vec): number[] | null {
    if (now - this.nextSampleAt > RESET_MS) {
      this.nextSampleAt = now;
      this.pending = [];
      this.last = null;
    }
    const from = this.last ?? { at: now, ...mallet };
    // Up to a quarter sample early still counts, so a few ms of frame jitter at 60 or 120 Hz never skips or doubles a sample.
    while (now >= this.nextSampleAt - SAMPLE_MS / 4) {
      // Each sample is where the mallet was at its own time between the last frame and this one, so uneven frame rates still give even steps.
      const f = now > from.at ? Math.min(1, Math.max(0, (this.nextSampleAt - from.at) / (now - from.at))) : 1;
      this.pending.push(round(from.x + (mallet.x - from.x) * f), round(from.y + (mallet.y - from.y) * f));
      this.nextSampleAt += SAMPLE_MS;
    }
    this.last = { at: now, x: mallet.x, y: mallet.y };
    if (this.pending.length < SAMPLES_PER_SEND * 2) return null;
    const q = this.pending.slice(-MAX_SAMPLES * 2);
    this.pending = [];
    const still = q.every((n, i) => n === this.sent[i % 2]);
    if (still && now - this.lastSent < INPUT_HEARTBEAT_MS) return null;
    this.sent = q.slice(-2);
    this.lastSent = now;
    return still ? this.sent : q;
  }
}
