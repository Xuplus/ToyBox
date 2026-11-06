// Tiny WebAudio synth: no audio files, no network — every sound is generated.
// The context can only be created from a user gesture, so callers `unlock()` on
// the first pointer down.

import { midiToHz } from './notes';

const MASTER_GAIN = 0.5;

export class Synth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private rumble: AudioBuffer | null = null;
  private muted = false;

  /** Create/resume the AudioContext. Safe to call on every gesture. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor =
      typeof window === 'undefined'
        ? undefined
        : window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    const ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : MASTER_GAIN;
    master.connect(ctx.destination);
    this.ctx = ctx;
    this.master = master;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : MASTER_GAIN;
  }

  /** A struck-bar tone: triangle fundamental plus a quiet octave, fast decay. */
  note(midi: number, velocity = 0.8): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || this.muted) return;

    const t = ctx.currentTime;
    const freq = midiToHz(midi);

    const envelope = ctx.createGain();
    const peak = 0.32 * Math.max(0.1, Math.min(1, velocity));
    envelope.gain.setValueAtTime(0.0001, t);
    envelope.gain.exponentialRampToValueAtTime(peak, t + 0.006);
    envelope.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = Math.min(12000, freq * 9);
    filter.Q.value = 0.6;

    const fundamental = ctx.createOscillator();
    fundamental.type = 'triangle';
    fundamental.frequency.value = freq;

    const overtone = ctx.createOscillator();
    overtone.type = 'sine';
    overtone.frequency.value = freq * 2;

    const overtoneGain = ctx.createGain();
    overtoneGain.gain.value = 0.28;

    fundamental.connect(envelope);
    overtone.connect(overtoneGain);
    overtoneGain.connect(envelope);
    envelope.connect(filter);
    filter.connect(master);

    const stopAt = t + 0.9;
    fundamental.start(t);
    overtone.start(t);
    fundamental.stop(stopAt);
    overtone.stop(stopAt);
  }

  /** Decaying white noise, built once: denser at the start, like a shatter. */
  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (!this.noise) {
      const length = Math.floor(ctx.sampleRate * 0.3);
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.5);
      }
      this.noise = buffer;
    }
    return this.noise;
  }

  /** A longer, rumbling noise for explosions: built once, 1.2 s. */
  private rumbleBuffer(ctx: AudioContext): AudioBuffer {
    if (!this.rumble) {
      const length = Math.floor(ctx.sampleRate * 1.2);
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      // Brown-ish noise: integrated white noise is mostly low end.
      let last = 0;
      for (let i = 0; i < length; i++) {
        last = (last + (Math.random() * 2 - 1) * 0.12) * 0.985;
        data[i] = last * 4 * Math.pow(1 - i / length, 1.6);
      }
      this.rumble = buffer;
    }
    return this.rumble;
  }

  /** A bomb: a low thump that drops in pitch, under a rumble of noise. */
  boom(strength = 1): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || this.muted) return;
    const t = ctx.currentTime;
    const level = Math.max(0.2, Math.min(1, strength));

    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(120, t);
    thump.frequency.exponentialRampToValueAtTime(38, t + 0.45);
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(0.0001, t);
    thumpGain.gain.exponentialRampToValueAtTime(0.75 * level, t + 0.01);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    thump.connect(thumpGain);
    thumpGain.connect(master);
    thump.start(t);
    thump.stop(t + 0.65);

    const noise = ctx.createBufferSource();
    noise.buffer = this.rumbleBuffer(ctx);
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.setValueAtTime(2400, t);
    low.frequency.exponentialRampToValueAtTime(180, t + 0.9);
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.55 * level;
    noise.connect(low);
    low.connect(noiseGain);
    noiseGain.connect(master);
    noise.start(t);
    noise.stop(t + 1.2);
  }

  /** A balloon popping: a very short, bright crack. */
  pop(): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || this.muted) return;
    const t = ctx.currentTime;

    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer(ctx);
    const high = ctx.createBiquadFilter();
    high.type = 'highpass';
    high.frequency.value = 900;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.5, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    source.connect(high);
    high.connect(gain);
    gain.connect(master);
    source.start(t);
    source.stop(t + 0.08);
  }

  /** A trampoline: a springy "boing", a falling pitch with a wobble on it. */
  boing(strength = 0.7): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || this.muted) return;
    const t = ctx.currentTime;
    const level = Math.max(0.15, Math.min(1, strength));

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(420, t);
    osc.frequency.exponentialRampToValueAtTime(140, t + 0.38);

    const wobble = ctx.createOscillator();
    wobble.frequency.value = 22;
    const depth = ctx.createGain();
    depth.gain.value = 26;
    wobble.connect(depth);
    depth.connect(osc.frequency);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.3 * level, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t);
    wobble.start(t);
    osc.stop(t + 0.45);
    wobble.stop(t + 0.45);
  }

  /** A black hole swallowing something: a quick downward sweep. */
  gulp(): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || this.muted) return;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(520, t);
    osc.frequency.exponentialRampToValueAtTime(55, t + 0.28);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.28, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t);
    osc.stop(t + 0.32);
  }

  /** Short filtered noise burst for glass/brick breaking. */
  crack(strength = 0.6): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || this.muted) return;

    const t = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer(ctx);

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 2200 + Math.random() * 1800;
    band.Q.value = 0.9;

    const gain = ctx.createGain();
    gain.gain.value = 0.28 * Math.max(0.2, Math.min(1, strength));

    source.connect(band);
    band.connect(gain);
    gain.connect(master);
    source.start(t);
    source.stop(t + 0.3);
  }
}
