// Tiny WebAudio synth: no audio files, no network — every sound is generated.
// The context can only be created from a user gesture, so callers `unlock()` on
// the first pointer down.

import { midiToHz } from './notes';

const MASTER_GAIN = 0.5;

export class Synth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
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

  /** Short filtered noise burst for glass/brick breaking. */
  crack(strength = 0.6): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || this.muted) return;

    if (!this.noise) {
      const length = Math.floor(ctx.sampleRate * 0.3);
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) {
        // Decaying white noise: denser at the start, like a shatter.
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.5);
      }
      this.noise = buffer;
    }

    const t = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = this.noise;

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
