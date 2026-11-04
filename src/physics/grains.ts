// A granular layer: thousands of circles, no rigid-body machinery.
//
// Why this exists: matter-js costs ~9 µs per body per 60 Hz step, and most of
// that is polygon SAT and an iterative contact solver — work that only pays off
// for *stacking, rotating* shapes. A box full of balls needs none of it. This
// solver keeps positions and velocities in typed arrays, buckets them in a
// uniform grid, and runs a handful of sequential relaxation passes: roughly two
// orders of magnitude cheaper per body. Balls are drawn as a fixed gradient and
// never show their rotation, so the result looks the same.
//
// What it gives up: rotation, contact manifolds, stacking of *shapes*. That is
// why it is a layer beside the rigid-body engine, not a replacement for it.

export interface GrainOptions {
  /** every grain has the same radius, in world px */
  radius: number;
  /** px per step², matching Matter's convention */
  gravity: number;
  /** 0 = dead stop, 1 = perfectly bouncy */
  restitution: number;
  /** below this impact speed (px/step) contacts don't bounce at all — Box2D's
   *  velocity threshold; without it a heap buzzes forever */
  restThreshold: number;
  /** fraction of the tangential velocity killed per contact */
  friction: number;
  /** a supported grain slower than this (px/step) is put to rest */
  restSpeed: number;
  /** relaxation passes per step; 3 is enough for a heap, 2 for a sprinkle */
  iterations: number;
}

const DEFAULTS: GrainOptions = {
  radius: 5,
  gravity: 1,
  restitution: 0.35,
  restThreshold: 1,
  friction: 0.18,
  restSpeed: 1.2,
  iterations: 3,
};

export class GrainWorld {
  readonly options: GrainOptions;
  readonly width: number;
  readonly height: number;
  /** live count */
  count = 0;

  // Structure of arrays: one Float32Array per channel, no object per grain.
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;

  // Uniform grid, rebuilt each step with a counting sort (no allocation).
  private readonly cols: number;
  private readonly rows: number;
  private readonly cellStart: Int32Array;
  private readonly cellFill: Int32Array;
  private readonly order: Int32Array;
  /** grid cell of each grain, computed once per step and reused by every pass */
  private readonly cellOf: Int32Array;
  /** 1 when a grain was in contact during the current step */
  private readonly touched: Uint8Array;

  constructor(capacity: number, width: number, height: number, options: Partial<GrainOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.width = width;
    this.height = height;

    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);

    // Cells are just over two radii across: the smallest size that still finds
    // every contact with a 3×3 stencil. Bigger cells mean more candidate pairs
    // per grain, which is what this loop spends its time on.
    const cell = Math.max(4, this.options.radius * 2 + 2);
    this.cols = Math.max(1, Math.ceil(width / cell));
    this.rows = Math.max(1, Math.ceil(height / cell));
    this.cellStart = new Int32Array(this.cols * this.rows + 1);
    this.cellFill = new Int32Array(this.cols * this.rows + 1);
    this.order = new Int32Array(capacity);
    this.cellOf = new Int32Array(capacity);
    this.touched = new Uint8Array(capacity);
  }

  get capacity(): number {
    return this.x.length;
  }

  add(grainX: number, grainY: number, vx = 0, vy = 0): boolean {
    if (this.count >= this.capacity) return false;
    const i = this.count++;
    this.x[i] = grainX;
    this.y[i] = grainY;
    this.vx[i] = vx;
    this.vy[i] = vy;
    return true;
  }

  clear(): void {
    this.count = 0;
  }

  /** One fixed step. The engine always passes one 60 Hz tick. */
  step(): void {
    const n = this.count;
    if (n === 0) return;

    const { radius: r, gravity, restitution, restThreshold, friction, restSpeed, iterations } =
      this.options;
    const x = this.x;
    const y = this.y;
    const vx = this.vx;
    const vy = this.vy;
    const width = this.width;
    const height = this.height;

    // --- integrate ---------------------------------------------------------
    for (let i = 0; i < n; i++) {
      vy[i] += gravity;
      x[i] += vx[i];
      y[i] += vy[i];
    }

    // --- bucket ------------------------------------------------------------
    const cols = this.cols;
    const rows = this.rows;
    const cellW = width / cols;
    const cellH = height / rows;
    const cellStart = this.cellStart;
    const cellFill = this.cellFill;
    const order = this.order;
    const touched = this.touched;
    const cellOf = this.cellOf;

    cellStart.fill(0);
    for (let i = 0; i < n; i++) {
      const cx = Math.min(cols - 1, Math.max(0, (x[i] / cellW) | 0));
      const cy = Math.min(rows - 1, Math.max(0, (y[i] / cellH) | 0));
      cellStart[cy * cols + cx + 1]++;
    }
    for (let c = 1, cells = cols * rows; c <= cells; c++) cellStart[c] += cellStart[c - 1];

    cellFill.set(cellStart);
    for (let i = 0; i < n; i++) {
      const cx = Math.min(cols - 1, Math.max(0, (x[i] / cellW) | 0));
      const cy = Math.min(rows - 1, Math.max(0, (y[i] / cellH) | 0));
      const cell = cy * cols + cx;
      cellOf[i] = cell;
      order[cellFill[cell]++] = i;
    }

    // --- relax -------------------------------------------------------------
    const minDist = r * 2;
    const minDistSq = minDist * minDist;
    const lastCol = cols - 1;
    const lastRow = rows - 1;

    touched.fill(0, 0, n);

    for (let pass = 0; pass < iterations; pass++) {
      for (let i = 0; i < n; i++) {
        // The cell recorded at bucketing time. A grain can't travel a whole
        // cell in one step, so this stays a valid hint for the 3×3 stencil.
        const cell = cellOf[i];
        const cy = (cell / cols) | 0;
        const cx = cell - cy * cols;

        const gy0 = cy > 0 ? cy - 1 : 0;
        const gy1 = cy < lastRow ? cy + 1 : lastRow;
        const gx0 = cx > 0 ? cx - 1 : 0;
        const gx1 = cx < lastCol ? cx + 1 : lastCol;

        for (let gy = gy0; gy <= gy1; gy++) {
          const rowBase = gy * cols;

          for (let gx = gx0; gx <= gx1; gx++) {
            const start = cellStart[rowBase + gx];
            const end = cellStart[rowBase + gx + 1];

            for (let k = start; k < end; k++) {
              const j = order[k];
              if (j <= i) continue; // visit each pair once

              // Re-read: i moves as earlier contacts in this cell are resolved.
              const xi = x[i];
              const yi = y[i];
              const dx = x[j] - xi;
              const dy = y[j] - yi;
              const d2 = dx * dx + dy * dy;
              if (d2 >= minDistSq || d2 === 0) continue;

              const d = Math.sqrt(d2);
              const push = (minDist - d) * 0.5;
              const nx = dx / d;
              const ny = dy / d;

              x[i] = xi - nx * push;
              y[i] = yi - ny * push;
              x[j] += nx * push;
              y[j] += ny * push;
              touched[i] = 1;
              touched[j] = 1;

              const rvx = vx[j] - vx[i];
              const rvy = vy[j] - vy[i];
              const normalSpeed = rvx * nx + rvy * ny;
              if (normalSpeed >= 0) continue; // already separating

              // Slow contacts don't bounce: a resting heap would buzz forever.
              const bouncy = -normalSpeed > restThreshold ? restitution : 0;
              const bounce = (-(1 + bouncy) * normalSpeed) / 2;
              vx[i] -= bounce * nx;
              vy[i] -= bounce * ny;
              vx[j] += bounce * nx;
              vy[j] += bounce * ny;

              // Tangential damping: without it a heap behaves like a liquid.
              const tangentSpeed = rvx * -ny + rvy * nx;
              if (tangentSpeed !== 0) {
                const grip = tangentSpeed * friction * 0.5;
                vx[i] += grip * -ny;
                vy[i] += grip * nx;
                vx[j] -= grip * -ny;
                vy[j] -= grip * nx;
              }
            }
          }
        }
      }
    }

    // --- walls -------------------------------------------------------------
    const left = r;
    const right = width - r;
    const top = r;
    const bottom = height - r;

    for (let i = 0; i < n; i++) {
      if (x[i] < left) {
        x[i] = left;
        touched[i] = 1;
        vx[i] = Math.abs(vx[i]) * (Math.abs(vx[i]) > restThreshold ? restitution : 0);
      } else if (x[i] > right) {
        x[i] = right;
        touched[i] = 1;
        vx[i] = -Math.abs(vx[i]) * (Math.abs(vx[i]) > restThreshold ? restitution : 0);
      }

      if (y[i] > bottom) {
        y[i] = bottom;
        touched[i] = 1;
        const bounce = Math.abs(vy[i]) > restThreshold ? restitution : 0;
        vy[i] = -Math.abs(vy[i]) * bounce;
        vx[i] *= 1 - friction;
      } else if (y[i] < top) {
        y[i] = top;
        touched[i] = 1;
        vy[i] = Math.abs(vy[i]) * (Math.abs(vy[i]) > restThreshold ? restitution : 0);
      }

      // A supported grain that is barely moving is at rest. Without this the
      // heap oscillates forever: gravity adds 1 px/step and the contact takes
      // exactly 1 px/step back. Free-falling grains are never touched, so they
      // are never frozen mid-air.
      if (touched[i] === 1 && Math.abs(vx[i]) + Math.abs(vy[i]) < restSpeed) {
        vx[i] = 0;
        vy[i] = 0;
      }
    }
  }
}

/**
 * Fill a world with `n` grains in a loose grid, jittered so they don't all
 * start in lockstep. Returns how many actually fit.
 */
export function scatterGrains(world: GrainWorld, n: number, seed = 1): number {
  const spacing = world.options.radius * 2.2;
  const cols = Math.max(1, Math.floor((world.width - spacing) / spacing));
  const margin = world.options.radius + 1;

  let state = seed;
  let added = 0;

  for (let i = 0; i < n; i++) {
    // xorshift: deterministic, so a benchmark run is reproducible
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const jitter = ((state >>> 8) & 0xffff) / 0xffff - 0.5;

    const col = i % cols;
    const row = (i / cols) | 0;
    const gx = margin + col * spacing + jitter * 2;
    const gy = margin + row * spacing;

    if (gy > world.height - margin) break;
    if (!world.add(gx, gy)) break;
    added++;
  }

  return added;
}
