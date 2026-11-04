// Rolling window of frame durations. Pure arithmetic — no DOM, no clock — so
// the FPS readout and the benchmark harness measure the same thing, and both
// can be tested without a browser.

export interface FrameSnapshot {
  /** frames per second at the median frame time */
  fps: number;
  /** the bad 5% — a 60 fps average with dips to 20 still feels broken */
  fpsLow: number;
  /** mean frame time in ms, including the idle wait for vsync */
  frameMs: number;
  /** how many frames the window holds (0 until the first frame) */
  samples: number;
}

export class FrameMeter {
  private readonly dts: Float32Array;
  private readonly scratch: Float32Array;
  private count = 0;
  private at = 0;

  constructor(private readonly capacity = 300) {
    this.dts = new Float32Array(capacity);
    this.scratch = new Float32Array(capacity);
  }

  /** Forget the window — used before a measurement starts. */
  reset(): void {
    this.count = 0;
    this.at = 0;
  }

  /** Record one frame. Non-positive deltas (duplicate RAF stamps) are dropped. */
  push(ms: number): void {
    if (!(ms > 0) || !Number.isFinite(ms)) return;
    this.dts[this.at] = ms;
    this.at = (this.at + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  snapshot(): FrameSnapshot {
    const n = this.count;
    if (n === 0) return { fps: 0, fpsLow: 0, frameMs: 0, samples: 0 };

    let sum = 0;
    for (let i = 0; i < n; i++) {
      const value = this.dts[i];
      sum += value;
      this.scratch[i] = value;
    }

    // TypedArray#sort is numeric and ascending without a comparator.
    const sorted = this.scratch.subarray(0, n).sort();
    const median = sorted[n >> 1];
    const slow = sorted[Math.min(n - 1, Math.floor(n * 0.95))];

    return { fps: 1000 / median, fpsLow: 1000 / slow, frameMs: sum / n, samples: n };
  }
}
