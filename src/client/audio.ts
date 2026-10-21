const MUTE_KEY = 'puckagon:muted';

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Small synthesised sound kit. Nothing plays until the first user gesture unlocks audio. */
export class Sfx {
  muted = readMuted();
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private lastHit = 0;

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    comp.connect(ctx.destination);
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : 0.5;
    master.connect(comp);
    const noise = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.ctx = ctx;
    this.master = master;
    this.noise = noise;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    try {
      localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    } catch {
      // storage unavailable; the choice lasts for this page only
    }
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.5, this.ctx.currentTime, 0.02);
    return this.muted;
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, at = 0, slideTo?: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private hiss(dur: number, vol: number, freq: number, at = 0, q = 1): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise || this.muted) return;
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  hit(strength: number): void {
    const now = performance.now();
    if (now - this.lastHit < 30) return;
    this.lastHit = now;
    const f = 380 + strength * 520 + Math.random() * 40;
    this.tone(f, 0.09, 'triangle', 0.35 + strength * 0.4, 0, f * 0.6);
    this.hiss(0.05, 0.3 * strength + 0.1, 3200, 0, 0.8);
  }

  wall(strength: number): void {
    this.tone(170 + strength * 90, 0.07, 'sine', 0.25 + strength * 0.3, 0, 110);
    this.hiss(0.03, 0.12 * strength, 1800, 0, 1.2);
  }

  goal(good: boolean): void {
    this.hiss(0.6, 0.5, 900, 0, 0.6);
    if (good) {
      [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.22, 'square', 0.12, i * 0.07));
    } else {
      [392, 370, 349, 262].forEach((f, i) => this.tone(f, 0.25, 'sawtooth', 0.08, i * 0.16));
    }
  }

  tick(go: boolean): void {
    this.tone(go ? 880 : 440, go ? 0.3 : 0.12, 'square', 0.12);
  }

  join(): void {
    this.tone(660, 0.08, 'sine', 0.2);
    this.tone(990, 0.1, 'sine', 0.15, 0.06);
  }

  win(): void {
    [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.28, 'square', 0.11, i * 0.11));
  }
}
