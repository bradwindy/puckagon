import { INPUT_HZ, MAX_SAMPLES, round, SAMPLE_HZ } from '../shared/protocol';
import type { Vec } from '../shared/vec';

const SAMPLE_MS = 1000 / SAMPLE_HZ;
const SAMPLES_PER_SEND = SAMPLE_HZ / INPUT_HZ;
/** A longer gap between calls, such as a hidden tab, starts sampling again instead of filling the gap. */
const RESET_MS = 250;
/** Sent samples kept while no ack comes back, about a second's worth. */
const HISTORY = 64;

export interface Sample extends Vec {
  seq: number;
}

/** Numbers every sample of the page session, across parties and reconnects, so an ack never matches an older sample. */
let nextSeq = 0;

/**
 * Samples the mallet at SAMPLE_HZ whatever the display rate, and batches the samples to send at INPUT_HZ. Every sample
 * is sent, even while the mallet is still, because prediction counts the samples the server has still to apply.
 */
export class InputSampler {
  /** Samples not yet sent, oldest first. */
  private pending: Sample[] = [];
  /** Samples sent and not yet known to be applied, plus the last one that was. */
  private history: Sample[] = [];
  private nextSampleAt = 0;
  private last: { at: number; x: number; y: number } | null = null;

  /** Takes the mallet position at `now`, from a frame or a pointer event, and returns the batch to send once one is ready. */
  sample(now: number, mallet: Vec): { s: number; q: number[] } | null {
    if (now - this.nextSampleAt > RESET_MS) {
      this.nextSampleAt = now;
      this.pending = [];
      this.last = null;
    }
    const from = this.last ?? { at: now, ...mallet };
    now = Math.max(now, from.at);
    // Up to a quarter sample early still counts, so a few ms of frame jitter at 60 or 120 Hz never skips or doubles a sample.
    while (now >= this.nextSampleAt - SAMPLE_MS / 4) {
      // Each sample is where the mallet was at its own time between the last call and this one, so uneven call rates still give even steps.
      const f = now > from.at ? Math.min(1, Math.max(0, (this.nextSampleAt - from.at) / (now - from.at))) : 1;
      this.pending.push({ seq: nextSeq++, x: round(from.x + (mallet.x - from.x) * f), y: round(from.y + (mallet.y - from.y) * f) });
      this.nextSampleAt += SAMPLE_MS;
    }
    this.last = { at: now, x: mallet.x, y: mallet.y };
    if (this.pending.length < SAMPLES_PER_SEND) return null;
    const batch = this.pending.slice(-MAX_SAMPLES);
    this.pending = [];
    this.history.push(...batch);
    if (this.history.length > HISTORY) this.history.splice(0, this.history.length - HISTORY);
    return { s: batch[0].seq, q: batch.flatMap((p) => [p.x, p.y]) };
  }

  /**
   * The sample the server applied last, if it is still known, and the samples it has still to apply, oldest first.
   * Those include the ones not sent yet, since they go out with the next batch.
   */
  since(ack: number): { applied: Sample | null; next: Sample[] } {
    const applied = this.history.find((p) => p.seq === ack) ?? null;
    return { applied, next: [...this.history, ...this.pending].filter((p) => p.seq > ack) };
  }

  /** Forgets every sample taken so far. The numbering carries on. */
  forget(): void {
    this.pending = [];
    this.history = [];
  }

  /** Forgets the samples before the one the server applied last. */
  prune(ack: number): void {
    const keep = this.history.findIndex((p) => p.seq >= ack);
    this.history.splice(0, keep < 0 ? this.history.length : keep);
  }

  /** How far `now` is into the interval after the newest sample, from 0 to 1. */
  frac(now: number): number {
    return Math.min(1, Math.max(0, (now - (this.nextSampleAt - SAMPLE_MS)) / SAMPLE_MS));
  }
}
