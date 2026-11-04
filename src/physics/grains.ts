// A granular layer: thousands of circles, no rigid-body machinery.
//
// Why this exists: matter-js costs about 9 microseconds per body per 60 Hz step,
// and most of that is polygon SAT and an iterative contact solver - work that
// only pays off for *stacking, rotating* shapes. A box full of sand needs none
// of it. This solver keeps positions and velocities in typed arrays, buckets
// them in a uniform grid, and runs a handful of relaxation passes.
//
// What it gives up: rotation, contact manifolds, stacking of *shapes*. That is
// why it is a layer beside the rigid-body engine, not a replacement for it.
//
// Four things make it a toy rather than a benchmark:
//
//  - **Two materials.** Sand is dry and friable; water is translucent, slippery
//    and slightly cohesive, so a puddle holds a surface instead of spreading
//    into a film of lone droplets. `MATERIALS` is the only place a material's
//    look and behaviour is described, and both painters read it from here.
//  - **Rigid bodies.** Grains are pushed out of every Matter body each step and
//    push back with an accumulated load, so a pile can weigh a crate down and a
//    conveyor belt can carry sand along by its surface velocity.
//  - **Sleep.** A grain that has not gone anywhere for half a second is put to
//    rest and skipped entirely. A settled dune costs nothing, so the cost of
//    the layer is the number of *moving* grains - which is what lets a twelve
//    thousand grain box sit inside the frame budget.
//  - **Rest is measured on motion, not on velocity.** A packed heap is never
//    perfectly still: the contact solver leaves each grain with a velocity that
//    the next contact takes straight back, so it never moves while never being
//    still either. Asking where a grain *is* rather than how fast it is going
//    is the difference between a layer that sleeps and one that does not.

import { GRAVITY_ACCEL, GRAVITY_SCALE } from './world';

/** Material ids, stored one per grain in a `Uint8Array`. */
export const GRAIN = { sand: 0, water: 1 } as const;
export type GrainMaterial = (typeof GRAIN)[keyof typeof GRAIN];

export interface GrainMaterialSpec {
  /** fill colour, shared by both painters and the palette swatch */
  color: string;
  /** fill alpha - water is translucent, which is half of what makes it a liquid */
  alpha: number;
  /** opacity of the dark rim; 0 merges the grains into one mass */
  border: number;
  /** fraction of the tangential slip killed per contact */
  friction: number;
  /** 0 = dead stop, 1 = off a wall like a rubber ball */
  restitution: number;
  /** px of pull across the contact gap per pass - surface tension */
  cohesion: number;
  /** quiet windows before a grain is put to sleep. Water needs more, because
   *  a puddle that has not finished levelling still has somewhere to go. */
  sleepWindows: number;
}

/** Everything about sand and water that can be seen or felt, in id order. */
export const MATERIALS: readonly GrainMaterialSpec[] = [
  {
    // Sand: holds an angle, does not stick, reads as grain because of the rim.
    color: '#e0a458',
    alpha: 1,
    border: 1,
    friction: 0.22,
    restitution: 0.1,
    cohesion: 0,
    sleepWindows: 1,
  },
  {
    // Water: barely any friction and a little cohesion, so it flows, levels,
    // and holds a surface instead of scattering into a film of lone droplets.
    color: '#4fa8e8',
    alpha: 0.78,
    border: 0,
    friction: 0.03,
    restitution: 0.04,
    cohesion: 0.06,
    sleepWindows: 2,
  },
];

export interface GrainOptions {
  /** every grain has the same radius, in world px */
  radius: number;
  /** px per step squared, matching Matter's convention - see `GRAVITY_ACCEL` */
  gravity: number;
  /** relaxation passes per step; 3 is enough for a heap, 2 for a sprinkle */
  iterations: number;
}

const DEFAULTS: GrainOptions = {
  radius: 5,
  gravity: GRAVITY_ACCEL,
  iterations: 3,
};

/**
 * Anything the granular layer can collide with. `Matter.Body` satisfies this
 * structurally, so the engine can hand its bodies straight through - but the
 * solver never imports Matter and stays unit-testable on its own.
 */
export interface GrainCollider {
  vertices: readonly { x: number; y: number }[];
  bounds: { min: { x: number; y: number }; max: { x: number; y: number } };
  position: { x: number; y: number };
  isStatic: boolean;
  mass: number;
  velocity: { x: number; y: number };
  /** Surface drift in px/step: a conveyor belt carries whatever rests on it. */
  surface?: { x: number; y: number };
}

/**
 * Sleep is decided over a window of steps: a grain that has moved less than
 * `SLEEP_DRIFT` in `SLEEP_WINDOW` steps is at rest. Half a second is short
 * enough that a settled heap is free almost immediately and long enough that a
 * grain in free fall (which covers hundreds of px in that time) never qualifies.
 */
const SLEEP_WINDOW = 30;
const SLEEP_DRIFT = 12;

/** Impact speed (px/step) that counts as a real hit, for the bounce. */
const BOUNCE_SPEED = 0.5;

/** A packed heap churns at ~2 px/step without going anywhere, so waking a
 *  sleeping grain needs a real impact behind it, not solver noise. */
const WAKE_SPEED = 3;

/** How many grains weigh as much as one body of mass 1. Sand should be heavy. */
const GRAINS_PER_MASS = 700;

/** The force one grain leaves on a body, matching `mass * gravity.scale`. */
export const GRAIN_FORCE = GRAVITY_SCALE / GRAINS_PER_MASS;

/** Colliders are capped so a shatter storm can't turn the grain pass quadratic. */
const MAX_COLLIDERS = 512;

const NO_COLLIDERS: readonly GrainCollider[] = [];

export class GrainWorld {
  readonly options: GrainOptions;
  width: number;
  height: number;
  /** live count */
  count = 0;
  /** grains that moved last step - this, not `count`, is what costs time */
  awake = 0;

  // Structure of arrays: one typed array per channel, no object per grain.
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  /** material id per grain - see `GRAIN` */
  readonly kind: Uint8Array;
  /** 1 when a grain is asleep and skipped by the solver */
  readonly asleep: Uint8Array;

  /** 1 when a grain had a contact during the current step */
  private readonly touched: Uint8Array;
  /** position at the start of the current sleep window */
  private readonly anchorX: Float32Array;
  private readonly anchorY: Float32Array;
  /** steps into the current sleep window */
  private readonly anchorTick: Uint8Array;
  /** consecutive quiet windows */
  private readonly quiet: Uint8Array;

  // Uniform grid, rebuilt each step with a counting sort (no allocation).
  private cols = 1;
  private rows = 1;
  private cellW = 1;
  private cellH = 1;
  private cellStart = new Int32Array(2);
  private cellFill = new Int32Array(2);
  private readonly order: Int32Array;
  /** grid cell of each grain, computed once per step and reused by every pass */
  private readonly cellOf: Int32Array;

  // --- colliders, rebuilt each step ---------------------------------------
  private colCount = 0;
  private colStart = new Int32Array(64);
  private colVerts = new Int32Array(64);
  /** corner positions, flat: x,y per corner, `colStart[c]` is the first */
  private colPx = new Float32Array(256);
  private colPy = new Float32Array(256);
  /** outward corner normals and their offsets - the inside test in one madd */
  private colNx = new Float32Array(256);
  private colNy = new Float32Array(256);
  private colOff = new Float32Array(256);
  private colMinX = new Float32Array(64);
  private colMinY = new Float32Array(64);
  private colMaxX = new Float32Array(64);
  private colMaxY = new Float32Array(64);
  private colMass = new Float32Array(64);
  private colVelX = new Float32Array(64);
  private colVelY = new Float32Array(64);
  private colSurfX = new Float32Array(64);
  private colSurfY = new Float32Array(64);
  private colCx = new Float32Array(64);
  private colCy = new Float32Array(64);
  /** 1 when the collider is moving, so grains touching it must wake */
  private colWake = new Uint8Array(64);

  /** per-collider accumulated load, read by the engine after `step` */
  readonly loadFx = new Float32Array(MAX_COLLIDERS);
  readonly loadFy = new Float32Array(MAX_COLLIDERS);
  readonly loadTorque = new Float32Array(MAX_COLLIDERS);

  constructor(capacity: number, width: number, height: number, options: Partial<GrainOptions> = {}) {
    // An explicit `undefined` must not shadow a default: `{ radius: undefined }`
    // is what a caller passing an optional radius through produces, and a NaN
    // cell size silently turns every grain into NaN.
    const merged = { ...DEFAULTS };
    if (options.radius !== undefined) merged.radius = options.radius;
    if (options.gravity !== undefined) merged.gravity = options.gravity;
    if (options.iterations !== undefined) merged.iterations = options.iterations;
    this.options = merged;
    this.width = width;
    this.height = height;

    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.asleep = new Uint8Array(capacity);
    this.touched = new Uint8Array(capacity);
    this.anchorX = new Float32Array(capacity);
    this.anchorY = new Float32Array(capacity);
    this.anchorTick = new Uint8Array(capacity);
    this.quiet = new Uint8Array(capacity);
    this.order = new Int32Array(capacity);
    this.cellOf = new Int32Array(capacity);

    this.buildGrid();
  }

  get capacity(): number {
    return this.x.length;
  }

  add(grainX: number, grainY: number, vx = 0, vy = 0, kind: GrainMaterial = GRAIN.sand): boolean {
    if (this.count >= this.capacity) return false;
    const i = this.count++;
    this.x[i] = grainX;
    this.y[i] = grainY;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.kind[i] = kind;
    this.asleep[i] = 0;
    this.anchorX[i] = grainX;
    this.anchorY[i] = grainY;
    this.anchorTick[i] = 0;
    this.quiet[i] = 0;
    return true;
  }

  clear(): void {
    this.count = 0;
    this.awake = 0;
    this.colCount = 0;
  }

  /** The box changed size: rebuild the grid and pull everything back inside. */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.buildGrid();

    const r = this.options.radius;
    const right = width - r;
    const bottom = height - r;
    for (let i = 0; i < this.count; i++) {
      this.x[i] = Math.min(Math.max(this.x[i], r), right);
      this.y[i] = Math.min(Math.max(this.y[i], r), bottom);
    }
    this.wakeAll();
  }

  wakeAll(): void {
    this.asleep.fill(0);
    this.quiet.fill(0);
    this.anchorTick.fill(0);
  }

  /** Wake everything inside a box - used when a body is deleted or dragged. */
  wakeIn(minX: number, minY: number, maxX: number, maxY: number): void {
    const x = this.x;
    const y = this.y;
    for (let i = 0; i < this.count; i++) {
      if (this.asleep[i] === 0) continue;
      if (x[i] < minX || x[i] > maxX || y[i] < minY || y[i] > maxY) continue;
      this.wake(i);
    }
  }

  private wake(i: number): void {
    this.asleep[i] = 0;
    this.quiet[i] = 0;
    this.anchorTick[i] = 0;
    this.anchorX[i] = this.x[i];
    this.anchorY[i] = this.y[i];
  }

  /** Erase grains inside a circle. O(1) per grain: swap the last one into the hole. */
  removeIn(centerX: number, centerY: number, radius: number): number {
    const x = this.x;
    const y = this.y;
    const r2 = radius * radius;
    let removed = 0;

    for (let i = this.count - 1; i >= 0; i--) {
      const dx = x[i] - centerX;
      const dy = y[i] - centerY;
      if (dx * dx + dy * dy > r2) continue;

      const last = --this.count;
      if (i !== last) {
        x[i] = x[last];
        y[i] = y[last];
        this.vx[i] = this.vx[last];
        this.vy[i] = this.vy[last];
        this.kind[i] = this.kind[last];
        this.asleep[i] = this.asleep[last];
        this.anchorX[i] = this.anchorX[last];
        this.anchorY[i] = this.anchorY[last];
        this.anchorTick[i] = this.anchorTick[last];
        this.quiet[i] = this.quiet[last];
      }
      removed++;
    }

    return removed;
  }

  /** How many grains of this material are in the box. */
  countOf(kind: GrainMaterial): number {
    let total = 0;
    for (let i = 0; i < this.count; i++) if (this.kind[i] === kind) total++;
    return total;
  }

  private buildGrid(): void {
    // Cells are just over two radii across: the smallest size that still finds
    // every contact with a 3x3 stencil. Bigger cells mean more candidate pairs
    // per grain, which is what this loop spends its time on.
    const cell = Math.max(4, this.options.radius * 2 + 2);
    this.cols = Math.max(1, Math.ceil(this.width / cell));
    this.rows = Math.max(1, Math.ceil(this.height / cell));
    this.cellW = this.width / this.cols;
    this.cellH = this.height / this.rows;
    const cells = this.cols * this.rows + 1;
    this.cellStart = new Int32Array(cells);
    this.cellFill = new Int32Array(cells);
  }

  /** One fixed step. The engine always passes one 60 Hz tick. */
  step(colliders: readonly GrainCollider[] = NO_COLLIDERS): void {
    const n = this.count;
    if (n === 0) {
      this.colCount = 0;
      this.awake = 0;
      return;
    }

    this.updateColliders(colliders);

    const { radius: r, gravity, iterations } = this.options;
    const x = this.x;
    const y = this.y;
    const vx = this.vx;
    const vy = this.vy;
    const kind = this.kind;
    const asleep = this.asleep;
    const width = this.width;
    const height = this.height;

    // --- integrate ---------------------------------------------------------
    // A grain may not travel further in one step than the solver can resolve,
    // or it can tunnel through a thin body or through a wall of other grains.
    const maxStep = r * 2.5;
    const maxStepSq = maxStep * maxStep;
    for (let i = 0; i < n; i++) {
      if (asleep[i] === 1) continue;
      vy[i] += gravity;
      const v2 = vx[i] * vx[i] + vy[i] * vy[i];
      if (v2 > maxStepSq) {
        const k = maxStep / Math.sqrt(v2);
        vx[i] *= k;
        vy[i] *= k;
      }
      x[i] += vx[i];
      y[i] += vy[i];
    }

    // --- bucket ------------------------------------------------------------
    // Asleep grains are bucketed too: an awake grain has to be able to find
    // them, or it would sink straight through a settled pile.
    const cols = this.cols;
    const rows = this.rows;
    const cellW = this.cellW;
    const cellH = this.cellH;
    const cellStart = this.cellStart;
    const cellFill = this.cellFill;
    const order = this.order;
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
    // Cohesion reaches 35% past contact, which still fits the 3x3 stencil:
    // cells are 2r+2 across, so the far corner of the stencil is 2r+3 out.
    const cohesionSq = minDistSq * 1.82;
    const cohesionBand = minDist * 0.35;
    const lastCol = cols - 1;
    const lastRow = rows - 1;
    const touched = this.touched;
    touched.fill(0, 0, n);

    for (let pass = 0; pass < iterations; pass++) {
      for (let i = 0; i < n; i++) {
        if (asleep[i] === 1) continue;

        // The cell recorded at bucketing time. A grain can't travel a whole
        // cell in one step, so this stays a valid hint for the 3x3 stencil.
        const cell = cellOf[i];
        const matI = MATERIALS[kind[i]];
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
              if (j === i) continue;
              // Visit each pair once - except when `j` is asleep, because a
              // sleeping grain is never the outer index and the pair would
              // otherwise never be looked at at all.
              if (j < i && asleep[j] === 0) continue;

              // Re-read: i moves as earlier contacts in this cell are resolved.
              const xi = x[i];
              const yi = y[i];
              const dx = x[j] - xi;
              const dy = y[j] - yi;
              const d2 = dx * dx + dy * dy;

              if (d2 >= cohesionSq) continue;

              if (d2 >= minDistSq) {
                // In the gap: no contact, but two cohesive grains pull on each
                // other. Surface tension is what makes water a puddle.
                if (asleep[j] === 1) continue;
                const pull = (matI.cohesion + MATERIALS[kind[j]].cohesion) * 0.5;
                if (pull === 0 || d2 === 0) continue;
                const d = Math.sqrt(d2);
                const g = pull * (1 - (d - minDist) / cohesionBand);
                if (g <= 0) continue;
                const nx = dx / d;
                const ny = dy / d;
                x[i] = xi + nx * g;
                y[i] = yi + ny * g;
                x[j] -= nx * g;
                y[j] -= ny * g;
                continue;
              }

              if (d2 === 0) continue;

              const d = Math.sqrt(d2);
              const nx = dx / d;
              const ny = dy / d;
              const rvx = vx[j] - vx[i];
              const rvy = vy[j] - vy[i];
              const normalSpeed = rvx * nx + rvy * ny;

              // A sleeping grain only wakes for a real impact. Waking it for
              // every touch would cascade through a settled heap - each grain
              // would wake its neighbour in turn and nothing would ever sleep.
              if (asleep[j] === 1) {
                if (-normalSpeed <= WAKE_SPEED) continue;
                this.wake(j);
              }

              // Position: half the overlap each. The correction is capped:
              // resolving a deep overlap in one step is a large displacement,
              // and a grain that lands hard should sink in and surface over the
              // next few steps instead of being fired back out.
              const push = Math.min(minDist - d, r * 1.2) * 0.5;
              x[i] = xi - nx * push;
              y[i] = yi - ny * push;
              x[j] += nx * push;
              y[j] += ny * push;
              touched[i] = 1;
              touched[j] = 1;

              if (normalSpeed >= 0) continue; // already separating

              // Velocity: an inelastic impulse along the normal, plus friction
              // on the tangent. Sand barely bounces, so restitution only
              // applies to a hard hit - otherwise a resting heap buzzes.
              const matJ = MATERIALS[kind[j]];
              const bouncy = -normalSpeed > BOUNCE_SPEED ? (matI.restitution + matJ.restitution) * 0.5 : 0;
              const bounce = (-(1 + bouncy) * normalSpeed) * 0.5;
              vx[i] -= bounce * nx;
              vy[i] -= bounce * ny;
              vx[j] += bounce * nx;
              vy[j] += bounce * ny;

              const tangent = rvx * -ny + rvy * nx;
              if (tangent !== 0) {
                const grip = tangent * ((matI.friction + matJ.friction) * 0.5) * 0.5;
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

    // --- rigid bodies ------------------------------------------------------
    this.collideBodies();

    // --- walls, sleep ------------------------------------------------------
    const left = r;
    const right = width - r;
    const top = r;
    const bottom = height - r;
    const anchorX = this.anchorX;
    const anchorY = this.anchorY;
    const anchorTick = this.anchorTick;
    const quiet = this.quiet;
    let awake = 0;

    for (let i = 0; i < n; i++) {
      if (asleep[i] === 1) continue;

      const material = MATERIALS[kind[i]];
      const bouncy = (speed: number): number =>
        Math.abs(speed) > BOUNCE_SPEED ? material.restitution : 0;

      if (x[i] < left) {
        x[i] = left;
        vx[i] = Math.abs(vx[i]) * bouncy(vx[i]);
      } else if (x[i] > right) {
        x[i] = right;
        vx[i] = -Math.abs(vx[i]) * bouncy(vx[i]);
      }

      if (y[i] > bottom) {
        y[i] = bottom;
        vy[i] = -Math.abs(vy[i]) * bouncy(vy[i]);
        vx[i] *= 1 - material.friction;
      } else if (y[i] < top) {
        y[i] = top;
        vy[i] = Math.abs(vy[i]) * bouncy(vy[i]);
      }

      // Sleep, decided on where the grain is rather than how fast it is going.
      if (++anchorTick[i] >= SLEEP_WINDOW) {
        anchorTick[i] = 0;
        const mx = x[i] - anchorX[i];
        const my = y[i] - anchorY[i];
        anchorX[i] = x[i];
        anchorY[i] = y[i];

        if (mx * mx + my * my > SLEEP_DRIFT * SLEEP_DRIFT) {
          quiet[i] = 0;
        } else if (++quiet[i] >= material.sleepWindows) {
          asleep[i] = 1;
          vx[i] = 0;
          vy[i] = 0;
        }
      }

      awake++;
    }

    this.awake = awake;
  }

  // --- rigid bodies -------------------------------------------------------

  /**
   * Hoist every collider into corner normals once per step. A point is inside
   * the convex hull when `p.n <= off` for every edge, which turns the per-grain
   * test into a handful of multiply-adds.
   */
  private updateColliders(colliders: readonly GrainCollider[]): void {
    const n = Math.min(colliders.length, MAX_COLLIDERS);
    let verts = 0;
    for (let c = 0; c < n; c++) verts += colliders[c].vertices.length;
    this.reserveColliders(n, verts);

    let at = 0;
    for (let c = 0; c < n; c++) {
      const body = colliders[c];
      const list = body.vertices;
      const count = list.length;

      this.colStart[c] = at;
      this.colVerts[c] = count;
      this.colMinX[c] = body.bounds.min.x;
      this.colMinY[c] = body.bounds.min.y;
      this.colMaxX[c] = body.bounds.max.x;
      this.colMaxY[c] = body.bounds.max.y;
      this.colCx[c] = body.position.x;
      this.colCy[c] = body.position.y;
      this.colMass[c] = body.isStatic ? 0 : body.mass;
      this.colVelX[c] = body.velocity.x;
      this.colVelY[c] = body.velocity.y;
      this.colSurfX[c] = body.surface?.x ?? 0;
      this.colSurfY[c] = body.surface?.y ?? 0;
      // A moving body drags grains with it, so anything it touches has to wake.
      const speed = Math.abs(body.velocity.x) + Math.abs(body.velocity.y);
      this.colWake[c] = !body.isStatic && speed > 0.4 ? 1 : 0;
      this.loadFx[c] = 0;
      this.loadFy[c] = 0;
      this.loadTorque[c] = 0;

      // Centroid, so the outward normal never depends on the winding order -
      // Matter does not promise one, and a wedge built by `fromVertices` does
      // not come out the same way as a rectangle. Outward, so that `p.n - off`
      // is positive outside the hull and the push-out direction is the normal.
      let gx = 0;
      let gy = 0;
      for (let k = 0; k < count; k++) {
        gx += list[k].x;
        gy += list[k].y;
        this.colPx[at + k] = list[k].x;
        this.colPy[at + k] = list[k].y;
      }
      gx /= count || 1;
      gy /= count || 1;

      for (let k = 0; k < count; k++) {
        const ax = this.colPx[at + k];
        const ay = this.colPy[at + k];
        const next = (k + 1) % count;
        const bx = this.colPx[at + next];
        const by = this.colPy[at + next];
        let nx = by - ay;
        let ny = ax - bx;
        const len = Math.hypot(nx, ny) || 1;
        nx /= len;
        ny /= len;
        if (nx * (gx - ax) + ny * (gy - ay) > 0) {
          nx = -nx;
          ny = -ny;
        }
        this.colNx[at + k] = nx;
        this.colNy[at + k] = ny;
        this.colOff[at + k] = nx * ax + ny * ay;
      }

      at += count;
    }

    this.colCount = n;
  }

  private reserveColliders(bodies: number, verts: number): void {
    if (bodies > this.colStart.length) {
      const size = Math.max(bodies, this.colStart.length * 2);
      this.colStart = growInt(this.colStart, size);
      this.colVerts = growInt(this.colVerts, size);
      this.colMinX = growFloat(this.colMinX, size);
      this.colMinY = growFloat(this.colMinY, size);
      this.colMaxX = growFloat(this.colMaxX, size);
      this.colMaxY = growFloat(this.colMaxY, size);
      this.colMass = growFloat(this.colMass, size);
      this.colVelX = growFloat(this.colVelX, size);
      this.colVelY = growFloat(this.colVelY, size);
      this.colSurfX = growFloat(this.colSurfX, size);
      this.colSurfY = growFloat(this.colSurfY, size);
      this.colCx = growFloat(this.colCx, size);
      this.colCy = growFloat(this.colCy, size);
      this.colWake = growFlags(this.colWake, size);
    }
    if (verts > this.colNx.length) {
      const size = Math.max(verts, this.colNx.length * 2);
      this.colPx = growFloat(this.colPx, size);
      this.colPy = growFloat(this.colPy, size);
      this.colNx = growFloat(this.colNx, size);
      this.colNy = growFloat(this.colNy, size);
      this.colOff = growFloat(this.colOff, size);
    }
  }

  /**
   * Push every grain out of every body it touches, and accumulate the load it
   * leaves behind. Driven from the collider side: each body walks the grid
   * cells its bounds cover, so the work is proportional to the grains that are
   * actually near something rather than to `grains x bodies`.
   */
  private collideBodies(): void {
    if (this.colCount === 0) return;

    const n = this.count;
    const r = this.options.radius;
    const x = this.x;
    const y = this.y;
    const asleep = this.asleep;
    const cellStart = this.cellStart;
    const order = this.order;
    const cols = this.cols;
    const rows = this.rows;
    const cellW = this.cellW;
    const cellH = this.cellH;

    for (let c = 0; c < this.colCount; c++) {
      const wake = this.colWake[c] === 1;
      const minX = this.colMinX[c] - r;
      const minY = this.colMinY[c] - r;
      const maxX = this.colMaxX[c] + r;
      const maxY = this.colMaxY[c] + r;

      const cx0 = Math.max(0, (minX / cellW) | 0);
      const cx1 = Math.min(cols - 1, (maxX / cellW) | 0);
      const cy0 = Math.max(0, (minY / cellH) | 0);
      const cy1 = Math.min(rows - 1, (maxY / cellH) | 0);

      for (let cy = cy0; cy <= cy1; cy++) {
        const rowBase = cy * cols;
        for (let cx = cx0; cx <= cx1; cx++) {
          const start = cellStart[rowBase + cx];
          const end = cellStart[rowBase + cx + 1];

          for (let k = start; k < end; k++) {
            const i = order[k];
            if (i >= n) continue;

            if (asleep[i] === 1) {
              if (!wake) continue;
              this.wake(i);
            }

            const gx = x[i];
            const gy = y[i];
            if (gx < minX || gx > maxX || gy < minY || gy > maxY) continue;

            this.collideGrain(c, i, gx, gy);
          }
        }
      }
    }
  }

  /** Circle vs convex polygon, position-based, with a load left on the body. */
  private collideGrain(c: number, i: number, gx: number, gy: number): void {
    const r = this.options.radius;
    const base = this.colStart[c];
    const verts = this.colVerts[c];
    const snx = this.colNx;
    const sny = this.colNy;
    const soff = this.colOff;

    let maxS = -Infinity;
    for (let k = 0; k < verts; k++) {
      const s = snx[base + k] * gx + sny[base + k] * gy - soff[base + k];
      // Outside every supporting line by more than a radius: no contact. The
      // hull is contained in all of them, so this can't reject a real hit.
      if (s > r) return;
      if (s > maxS) maxS = s;
    }

    let normalX: number;
    let normalY: number;
    let depth: number;

    if (maxS <= 0) {
      // Centre inside the hull: leave through the nearest edge. A grain in here
      // must not be allowed to fall asleep inside a body - it is not at rest,
      // it is stuck - so its sleep window never completes.
      this.anchorTick[i] = 0;
      this.quiet[i] = 0;
      let best = -Infinity;
      let bestK = 0;
      for (let k = 0; k < verts; k++) {
        const s = snx[base + k] * gx + sny[base + k] * gy - soff[base + k];
        if (s > best) {
          best = s;
          bestK = k;
        }
      }
      normalX = snx[base + bestK];
      normalY = sny[base + bestK];
      depth = Math.min(r - best, r);
    } else {
      // Outside: closest point on the hull boundary.
      let bestD2 = Infinity;
      let qx = gx;
      let qy = gy;
      for (let k = 0; k < verts; k++) {
        const ax = this.colPx[base + k];
        const ay = this.colPy[base + k];
        const next = base + ((k + 1) % verts);
        const ex = this.colPx[next] - ax;
        const ey = this.colPy[next] - ay;
        const len2 = ex * ex + ey * ey || 1;
        let t = ((gx - ax) * ex + (gy - ay) * ey) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + ex * t;
        const py = ay + ey * t;
        const d2 = (gx - px) * (gx - px) + (gy - py) * (gy - py);
        if (d2 < bestD2) {
          bestD2 = d2;
          qx = px;
          qy = py;
        }
      }
      if (bestD2 >= r * r) return;
      const d = Math.sqrt(bestD2) || 1;
      normalX = (gx - qx) / d;
      normalY = (gy - qy) / d;
      depth = Math.min(r - d, r);
    }

    // Position: push the grain out of the body. The body is not moved here -
    // it gets the load below instead, which keeps a heavy dune from being able
    // to tunnel a crate through the floor.
    const x = this.x;
    const y = this.y;
    x[i] = gx + normalX * depth;
    y[i] = gy + normalY * depth;
    this.touched[i] = 1;

    // Velocity: split the slip against the surface, reflect the normal part
    // with restitution, kill a fraction of the tangent with friction, and add
    // the surface's own drift (a belt) back on.
    const material = MATERIALS[this.kind[i]];
    const svx = this.colVelX[c] + this.colSurfX[c];
    const svy = this.colVelY[c] + this.colSurfY[c];
    const rvx = this.vx[i] - svx;
    const rvy = this.vy[i] - svy;
    const into = rvx * normalX + rvy * normalY;
    const out = into < 0 && -into > BOUNCE_SPEED ? -into * material.restitution : 0;
    const keep = 1 - material.friction;
    const tx = (rvx - into * normalX) * keep;
    const ty = (rvy - into * normalY) * keep;
    this.vx[i] = svx + tx + normalX * out;
    this.vy[i] = svy + ty + normalY * out;

    const mass = this.colMass[c];
    if (mass === 0) return;

    // The load is the opposite of the outward normal: the grain pushes *into*
    // the body. The engine scales it by `GRAIN_FORCE`.
    const fx = -normalX;
    const fy = -normalY;
    this.loadFx[c] += fx;
    this.loadFy[c] += fy;
    this.loadTorque[c] += (gx - this.colCx[c]) * fy - (gy - this.colCy[c]) * fx;
  }
}

function growFloat(source: Float32Array<ArrayBuffer>, size: number): Float32Array<ArrayBuffer> {
  const next = new Float32Array(size);
  next.set(source);
  return next;
}

function growInt(source: Int32Array<ArrayBuffer>, size: number): Int32Array<ArrayBuffer> {
  const next = new Int32Array(size);
  next.set(source);
  return next;
}

function growFlags(source: Uint8Array<ArrayBuffer>, size: number): Uint8Array<ArrayBuffer> {
  const next = new Uint8Array(size);
  next.set(source);
  return next;
}

/**
 * Fill a world with `n` grains in a loose grid, jittered so they don't all
 * start in lockstep. Returns how many actually fit.
 */
export function scatterGrains(
  world: GrainWorld,
  n: number,
  seed = 1,
  kind: GrainMaterial = GRAIN.sand,
): number {
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
    if (!world.add(gx, gy, 0, 0, kind)) break;
    added++;
  }

  return added;
}
