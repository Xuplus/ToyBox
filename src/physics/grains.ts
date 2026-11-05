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
// Sand and water are two different solvers sharing one grid:
//
//  - **Sand is a frictional solid.** Grains collide as discs, and every contact
//    carries Coulomb friction: the tangential impulse may cancel the slip
//    entirely, up to `friction` times the normal impulse. That is static
//    friction, and it is the only reason a heap holds a slope. Without it a
//    pile is a slow liquid that only *looks* like sand because sleep froze it.
//  - **Water is a pressure solve** (Clavet et al. 2005, "double density
//    relaxation"). Each drop measures how crowded its neighbourhood is and
//    pushes its neighbours away in proportion; a "near" pressure keeps drops
//    apart. Pressure is isotropic, so a column of water pushes sideways as hard
//    as down, and a pile levels into a pool instead of standing as a cone.
//    Velocity is derived from where the drop ended up, so there is no separate
//    impulse model for liquids.
//
// Sleep is decided on support, not on a timer. A grain sleeps once it has
// stopped moving *and* something holds it up - the floor, a body, or neighbours
// below it that it cannot slide off. It wakes when something hits it, or when
// the grain under it goes away: every grain that moves more than a radius, and
// every grain that is erased, leaves a "dirty" cell behind it, and the sleepers
// in and above a dirty cell are woken to look again. A slow audit re-checks the
// sleepers in round robin, so nothing can be left hanging in the air.

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
  /** Coulomb coefficient: the most tangential impulse a contact can apply, as a
   *  fraction of its normal impulse. It sets the angle of repose, though not
   *  as tan(angle): discs interlock, so 0.4 stands at ~32-38 degrees, which is
   *  dry sand. For a liquid it is a plain drag on the slip against a rigid
   *  body instead, since water has no static friction. */
  friction: number;
  /** 0 = dead stop, 1 = off a wall like a rubber ball */
  restitution: number;
  /** relative mass, for sharing a correction between two different grains -
   *  water gives way to sand, not the other way round */
  mass: number;
  /** true for a liquid: solved by pressure instead of by contacts, and drawn as
   *  a flat translucent fill with a feathered edge so a cluster reads as one
   *  body of water instead of a heap of blue beads */
  liquid: boolean;
  /** 1 when the medium can hold a body up, 0 when it cannot. Sand stands under
   *  a ball; water does not, and without buoyancy a "support" from water would
   *  be a lie. This also weights the static load the pile leaves on a body. */
  support: number;
  /** fraction of the speed into the medium one contact takes out per step. It
   *  is the same idea as `friction`, but applied to a rigid body rather than
   *  between two grains, and it is what stops a ball dead in sand and lets it
   *  sink through water. */
  grip: number;
  /** fraction of the speed a slow, contacted grain keeps per step. Perfect
   *  circles roll for ever on a flat floor; real sand is angular and stops,
   *  and water does not stop at all. */
  rolling: number;
  /** quiet windows before a grain is put to sleep. Water needs more, because
   *  a puddle that has not finished levelling still has somewhere to go. */
  sleepWindows: number;
  /** px a grain may wander over a window and still count as stopped. A pool
   *  of water is never still: the pressure solve leaves every drop wandering
   *  a little inside a pool that is already level, so water needs more slack
   *  than sand or it never sleeps at all. */
  sleepDrift: number;
}

/** Everything about sand and water that can be seen or felt, in id order. */
export const MATERIALS: readonly GrainMaterialSpec[] = [
  {
    // Sand: holds an angle, does not stick, reads as grain because of the rim.
    color: '#e0a458',
    alpha: 1,
    border: 1,
    friction: 0.4,
    restitution: 0.1,
    mass: 1,
    liquid: false,
    support: 1,
    grip: 0.05,
    rolling: 0.9,
    sleepWindows: 1,
    sleepDrift: 3,
  },
  {
    // Water: pressure instead of contacts, so it runs and levels.
    color: '#3f9fe6',
    alpha: 0.62,
    border: 0,
    friction: 0.01,
    restitution: 0.02,
    // Light against sand: water seeping through a heap must not shove its
    // grains about (at 0.6 the seepage alone kept a dammed heap awake for
    // ever), and sand dropped into a pool should go to the bottom.
    mass: 0.15,
    liquid: true,
    support: 0,
    grip: 0.012,
    rolling: 1,
    sleepWindows: 2,
    sleepDrift: 6,
  },
];

// Per-material constants flattened for the inner loops: a property lookup on a
// spec object per contact is measurable at ten thousand grains.
const MU = Float32Array.from(MATERIALS, (m) => m.friction);
const BOUNCE = Float32Array.from(MATERIALS, (m) => m.restitution);
const INV_MASS = Float32Array.from(MATERIALS, (m) => 1 / m.mass);
const LIQUID = Uint8Array.from(MATERIALS, (m) => (m.liquid ? 1 : 0));
const ROLLING = Float32Array.from(MATERIALS, (m) => m.rolling);
const SLEEP_WINDOWS = Uint8Array.from(MATERIALS, (m) => m.sleepWindows);
const SLEEP_DRIFT2 = Float32Array.from(MATERIALS, (m) => m.sleepDrift * m.sleepDrift);
/** Can this material hold a grain up? Water cannot: sand in it sinks. */
const HOLDS = Uint8Array.from(MATERIALS, (m) => (m.support > 0 ? 1 : 0));
/** The friction angle, atan(mu): how far a contact's push can lean and still
 *  hold. See `cradled`. */
const CRADLE_ANGLE = Float32Array.from(MATERIALS, (m) => Math.atan(m.friction));

/**
 * The liquid solver, in units of the grain radius so a different radius
 * behaves the same. See `relaxLiquid`.
 */
export const FLUID = {
  /** rest spacing between drops, in diameters. Under 1 so the drops overlap
   *  and the painter fuses them into one surface. */
  spacing: 0.9,
  /** interaction radius, in diameters. Must stay under two grid cells. */
  reach: 2.2,
  /** pressure per unit of excess density, px - how hard water resists being
   *  squeezed. Too soft and a deep pool compresses; too stiff and it fizzes. */
  stiffness: 0.5,
  /** near-pressure, px - keeps two drops from collapsing into one */
  nearStiffness: 2.5,
  /** fraction of the rest density a drop may be short of before it stops
   *  pulling its neighbours in: surface tension, and the cap on it */
  tension: 0.1,
  /** how much of the relative motion of two neighbours is shared per step */
  viscosity: 0.04,
  /** fraction of the summed displacement applied per relaxation. Every drop
   *  is pushed by ~20 neighbours at once, so the full sum overshoots and the
   *  pool boils. */
  relax: 0.3,
  /** relaxations per step, re-measuring the same pairs. One is enough for a
   *  puddle; a pool twenty drops deep needs two, or the bottom of it never
   *  stops moving. See `relaxLiquid`. */
  iterations: 2,
} as const;

export interface GrainOptions {
  /** every grain has the same radius, in world px */
  radius: number;
  /** px per step squared, matching Matter's convention - see `GRAVITY_ACCEL` */
  gravity: number;
  /** contact passes per step. Fewer and a pour fluidises the heap it lands
   *  on (3 passes stand at ~25 degrees, 5 at ~35); liquids only take two */
  iterations: number;
}

const DEFAULTS: GrainOptions = {
  radius: 5,
  gravity: GRAVITY_ACCEL,
  iterations: 5,
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
 * its material's `sleepDrift` in `SLEEP_WINDOW` steps has stopped. Whether it
 * may *sleep* also needs a support - see `cradled`.
 */
const SLEEP_WINDOW = 30;

/** Impact speed (px/step) that counts as a real hit, for the bounce. */
const BOUNCE_SPEED = 0.5;

/** Below this speed a contacted grain is rolling, not falling, and is damped. */
const ROLL_SPEED = 1.5;

/** A sleeping grain wakes for a hit faster than this. Now that a heap holds
 *  its own shape awake, waking one is harmless, so this can be low. */
const WAKE_SPEED = 1.5;

/** What left a dirty cell: anything that can hold a grain up, or only water. */
const DIRTY_SOLID = 1;
const DIRTY_LIQUID = 2;

/** What a sleeping grain is resting on, besides sand and the floor. */
const REST_BODY = 1;
const REST_WATER = 2;

/** How far apart, in radii past touching, two grains may be and still be
 *  listed as a pair for the step: what the passes can close between them. */
const CONTACT_MARGIN = 0.5;

/**
 * How far, in radii, a grain may sink into a *sleeping* neighbour before it is
 * pushed out. The bottom of a deep bed goes to sleep still squeezed together by
 * the weight above it; without this, a grain woken there resolves that old
 * overlap against its frozen neighbours in one go, moves, wakes the next, and
 * the bottom of the bed churns for ever (measured: 30 layers of r=3 sand kept
 * 400-1100 grains awake). 0.15 settles every bed tried; 0.3 is too soft.
 */
const SLEEPER_SLOP = 0.15;

/** Share of a body of water that must be still for all of it to sleep. The
 *  rest are drops wandering inside a pool that has stopped changing. */
const POOL_STILL = 0.95;

/** A sleeping drop wakes when an awake one runs into it faster than this,
 *  px/step. A pool is never perfectly still, so this is a real disturbance. */
const FLUID_WAKE = 1;

/**
 * A grain woken only to check its support gets this many steps to show that it
 * has lost it. Free fall covers ~9 px in 8 steps; a grain that is still held up
 * moves a fraction of that, and goes straight back to sleep. Without this, the
 * check itself would wake a heap a layer at a time and keep it awake.
 */
const PROBATION = 8;
const PROBATION_DRIFT = 2;

/** Sleepers re-checked per step, as a fraction of all grains: 1/32 re-checks
 *  the whole box twice a second. */
const AUDIT_SHARE = 32;

/** How many grains weigh as much as one body of mass 1. Sand should be heavy. */
const GRAINS_PER_MASS = 700;

/** The force one grain leaves on a body, matching `mass * gravity.scale`. */
export const GRAIN_FORCE = GRAVITY_SCALE / GRAINS_PER_MASS;

/**
 * The least a contact takes out of a body's speed per step: a little more than
 * one step of gravity, so a supported body comes to rest instead of sinking one
 * gravity step per step for ever.
 */
const SUPPORT_FLOOR = GRAVITY_ACCEL * 1.25;

/**
 * What one step of contact does to a body.
 *
 * `vx/vy` is its new velocity; `fx/fy` is a force to add so the medium carries
 * the body's weight - Matter applies gravity to the next step, and a supported
 * body must not have its gravity applied again.
 */
export interface ContactImpulse {
  vx: number;
  vy: number;
  fx: number;
  fy: number;
}

const NO_FORCE = { fx: 0, fy: 0 };

/**
 * What a pile does to a body it is holding up.
 *
 * `loadX/loadY` is the sum of the contact normals the medium pushes with: its
 * direction is what the body is sitting on, its length is the number of
 * contacts. `grip` is the sum of every contact's `grip` material property.
 *
 * The medium may take away speed that is going *into* it, and it may carry the
 * body's weight. It may never add speed. That one rule is the difference
 * between a ball that lands and stops and the trampoline that the old
 * force-based drag turned a dune into: a force that keeps pushing after the
 * ball has stopped is a spring, and a spring with a gain high enough to stop a
 * ball is a spring that throws it back out.
 *
 * The take is a *fraction of the speed coming in*, not a fixed force, so a fast
 * body keeps going for a few steps and carves a crater, while a body that is
 * nearly at rest has its one gravity step removed. Both cases end at zero, and
 * neither can overshoot.
 */
export function supportImpulse(
  loadX: number,
  loadY: number,
  grip: number,
  vx: number,
  vy: number,
  mass: number,
): ContactImpulse {
  const len = Math.hypot(loadX, loadY);
  if (len < 1e-6 || grip <= 0) return { vx, vy, ...NO_FORCE };

  const nx = loadX / len;
  const ny = loadY / len;
  const into = vx * nx + vy * ny;

  let outVx = vx;
  let outVy = vy;
  if (into < 0) {
    const take = Math.min(-into, Math.max(SUPPORT_FLOOR, -into * Math.min(1, grip)));
    outVx += nx * take;
    outVy += ny * take;
  }

  // The weight the pile carries, along its normal. Never more than the body's
  // own weight: a support only takes away gravity, it cannot supply lift.
  const carry = ny < 0 ? -mass * GRAVITY_SCALE * ny : 0;
  return { vx: outVx, vy: outVy, fx: nx * carry, fy: ny * carry };
}

/**
 * What a medium that cannot hold a body up (water) does to one moving through
 * it: it slows it down. `dragX/dragY` is the momentum the grains took, so it
 * points the way the body is losing speed - the direction to take it from.
 */
export function dragImpulse(
  dragX: number,
  dragY: number,
  grip: number,
  vx: number,
  vy: number,
): { vx: number; vy: number } {
  const len = Math.hypot(dragX, dragY);
  if (len < 1e-6 || grip <= 0) return { vx, vy };

  const nx = dragX / len;
  const ny = dragY / len;
  const into = vx * nx + vy * ny;
  if (into >= 0) return { vx, vy };

  const take = Math.min(-into, -into * Math.min(1, grip));
  return { vx: vx + nx * take, vy: vy + ny * take };
}

/**
 * Coulomb friction on a slip of `slip` px/step, given a normal impulse of `jn`:
 * the slip that is left. Below the cone the contact sticks and nothing is left;
 * above it the slip loses `mu * jn` and keeps sliding.
 */
function coulomb(slip: number, jn: number, mu: number): number {
  const limit = mu * jn;
  if (slip > limit) return slip - limit;
  if (slip < -limit) return slip + limit;
  return 0;
}

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

  /** position at the start of the step - a liquid's velocity is derived from it */
  private readonly prevX: Float32Array;
  private readonly prevY: Float32Array;
  /** 1 when a grain had a contact during the current step */
  private readonly touched: Uint8Array;
  /** 1 when a body is holding the grain up this step (a face below it) */
  private readonly onBody: Uint8Array;
  /** what the grain fell asleep on, if the audit has to ask for more than
   *  sand and the floor: `REST_BODY`, and/or `REST_WATER` */
  private readonly restOn: Uint8Array;
  /** accumulated contact normal, weighted by how far it pushed this grain:
   *  the direction a grain is being supported from */
  private readonly supX: Float32Array;
  private readonly supY: Float32Array;
  /** position at the start of the current sleep window */
  private readonly anchorX: Float32Array;
  private readonly anchorY: Float32Array;
  /** steps into the current sleep window */
  private readonly anchorTick: Uint8Array;
  /** consecutive quiet windows */
  private readonly quiet: Uint8Array;
  /** steps left to prove a woken grain has lost its support - see `PROBATION` */
  private readonly probation: Uint8Array;
  /** where the grain was when it last told the grains above it that it moved */
  private readonly homeX: Float32Array;
  private readonly homeY: Float32Array;

  /** the grains the solver walks this step: awake ones, in no particular order */
  private readonly active: Int32Array;
  private activeCount = 0;
  /** true between bucketing and the end of the step, when a woken grain has to
   *  join `active` and be given a start position */
  private inStep = false;

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
  /** cells whose support changed since the last step, and the list of them */
  private dirty = new Uint8Array(2);
  private dirtyList = new Int32Array(256);
  private dirtyCount = 0;
  private auditCursor = 0;
  private settleTick = 0;
  /** this step's contact pairs, found once and walked by every pass */
  private pairI = new Int32Array(1024);
  private pairJ = new Int32Array(1024);
  private pairCount = 0;
  /** connected-water labels per grid cell, for `settleLiquid` */
  private cellLabel = new Int32Array(2);
  private cellStack = new Int32Array(2);

  // --- liquid -------------------------------------------------------------
  /** awake drops this step, and their neighbours found once and used twice */
  private fluid: Int32Array;
  private fluidCount = 0;
  private nbrStart: Int32Array;
  private nbr = new Int32Array(1024);
  private nbrQ = new Float32Array(1024);
  private nbrNx = new Float32Array(1024);
  private nbrNy = new Float32Array(1024);
  /** density, then (once the densities are summed) pressure */
  private readonly rho: Float32Array;
  /** near-density, then near-pressure */
  private readonly rhoNear: Float32Array;
  /** the summed displacement of each drop during the relaxation */
  private readonly accX: Float32Array;
  private readonly accY: Float32Array;
  /** 1 while a drop is in this step's `fluid` list */
  private readonly inFluid: Uint8Array;
  /** 1 when a drop has a grain of sand close enough to touch this step: the
   *  only drops the contact passes need to look at */
  private readonly nearSolid: Uint8Array;
  /** interaction radius and rest density for the current radius and grid */
  private reach = 1;
  private rho0 = 1;

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
  /**
   * The part of the load that points *up*: the contacts a body is standing on,
   * kept apart from the ones pressing on it from above.
   *
   * Without a pressure field the two cancel exactly when a body is buried, and
   * a ball that has sunk one radius into a dune is then surrounded by as many
   * contacts as it has below it - so the net load is nothing and it keeps
   * sinking. Only counting what it stands on is what lets it come to rest at
   * any depth. `loadF` stays the full sum: that one is the weight a pile leaves
   * on a crate.
   */
  readonly holdFx = new Float32Array(MAX_COLLIDERS);
  readonly holdFy = new Float32Array(MAX_COLLIDERS);
  /** how many grains are touching the collider - what makes a deep contact
   *  hold harder than a graze */
  readonly contacts = new Uint16Array(MAX_COLLIDERS);
  /** sum of the contact materials' `grip`, so the engine knows how hard the
   *  medium can take a body's speed away */
  readonly grip = new Float32Array(MAX_COLLIDERS);
  /** per-collider accumulated momentum taken from the body by the grains it
   *  pushed, in px/step of grain velocity */
  readonly dragX = new Float32Array(MAX_COLLIDERS);
  readonly dragY = new Float32Array(MAX_COLLIDERS);
  readonly dragTorque = new Float32Array(MAX_COLLIDERS);

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
    this.prevX = new Float32Array(capacity);
    this.prevY = new Float32Array(capacity);
    this.touched = new Uint8Array(capacity);
    this.onBody = new Uint8Array(capacity);
    this.restOn = new Uint8Array(capacity);
    this.supX = new Float32Array(capacity);
    this.supY = new Float32Array(capacity);
    this.anchorX = new Float32Array(capacity);
    this.anchorY = new Float32Array(capacity);
    this.anchorTick = new Uint8Array(capacity);
    this.quiet = new Uint8Array(capacity);
    this.probation = new Uint8Array(capacity);
    this.homeX = new Float32Array(capacity);
    this.homeY = new Float32Array(capacity);
    this.active = new Int32Array(capacity);
    this.order = new Int32Array(capacity);
    this.cellOf = new Int32Array(capacity);
    this.fluid = new Int32Array(capacity);
    this.nbrStart = new Int32Array(capacity + 1);
    this.rho = new Float32Array(capacity);
    this.rhoNear = new Float32Array(capacity);
    this.accX = new Float32Array(capacity);
    this.accY = new Float32Array(capacity);
    this.inFluid = new Uint8Array(capacity);
    this.nearSolid = new Uint8Array(capacity);

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
    this.restOn[i] = 0;
    this.anchorX[i] = grainX;
    this.anchorY[i] = grainY;
    this.anchorTick[i] = 0;
    this.quiet[i] = 0;
    this.probation[i] = 0;
    this.homeX[i] = grainX;
    this.homeY[i] = grainY;
    return true;
  }

  clear(): void {
    this.count = 0;
    this.awake = 0;
    this.colCount = 0;
    this.dirtyCount = 0;
    this.dirty.fill(0);
  }

  /**
   * The box changed size: rebuild the grid and pull everything back inside.
   *
   * A new floor height moves what every pile stands on, so everything wakes.
   * A new width only matters to grains against the right wall - pulled in, or
   * left standing against a wall that has gone - so only those wake, and the
   * dirty cells they leave let whatever they held look again. Waking a whole
   * heap is not free: it has to carry its own weight again from scratch, and
   * it settles a little lower than it slept.
   */
  resize(width: number, height: number): void {
    const oldWidth = this.width;
    const floorMoved = height !== this.height;
    this.width = width;
    this.height = height;
    this.buildGrid();

    const r = this.options.radius;
    const right = width - r;
    const bottom = height - r;
    const oldRight = oldWidth - r - 1;
    for (let i = 0; i < this.count; i++) {
      const gx = this.x[i];
      const gy = this.y[i];
      this.x[i] = Math.min(Math.max(gx, r), right);
      this.y[i] = Math.min(Math.max(gy, r), bottom);
      if (floorMoved || this.asleep[i] === 0) continue;
      if (this.x[i] !== gx || this.y[i] !== gy || (width !== oldWidth && gx >= oldRight)) {
        this.wake(i, PROBATION);
        this.markDirty(this.x[i], this.y[i]);
      }
    }
    if (floorMoved) this.wakeAll();
  }

  /** Wake everything, on probation: what is still held up goes back to sleep. */
  wakeAll(): void {
    for (let i = 0; i < this.count; i++) if (this.asleep[i] === 1) this.wake(i, PROBATION);
  }

  /**
   * Wake everything touching a box - used when a body is deleted or dragged.
   * The box is grown by a grain's reach, since a grain resting on a body has
   * its centre a radius outside the body's bounds. What is woken also leaves
   * its cell dirty, so a pile *on top of* what was woken looks again too: the
   * box only has to reach the first layer.
   */
  wakeIn(boxMinX: number, boxMinY: number, boxMaxX: number, boxMaxY: number): void {
    const x = this.x;
    const y = this.y;
    const reach = this.options.radius * 2 + 2;
    const minX = boxMinX - reach;
    const minY = boxMinY - reach;
    const maxX = boxMaxX + reach;
    const maxY = boxMaxY + reach;
    for (let i = 0; i < this.count; i++) {
      if (this.asleep[i] === 0) continue;
      if (x[i] < minX || x[i] > maxX || y[i] < minY || y[i] > maxY) continue;
      this.wake(i, PROBATION);
      this.markDirty(x[i], y[i]);
    }
  }

  /** `probation` > 0 for a grain woken to re-check its support rather than hit. */
  private wake(i: number, probation = 0): void {
    this.asleep[i] = 0;
    this.probation[i] = probation;
    this.restOn[i] = 0;
    this.quiet[i] = 0;
    this.anchorTick[i] = 0;
    this.anchorX[i] = this.x[i];
    this.anchorY[i] = this.y[i];
    this.homeX[i] = this.x[i];
    this.homeY[i] = this.y[i];
    if (this.inStep) {
      // Woken mid-step: it has to be walked by the rest of this step, and it
      // has not moved yet, so its start position is where it is. A drop woken
      // here missed the relaxation's look round, so it takes its contacts.
      this.active[this.activeCount++] = i;
      this.nearSolid[i] = 1;
      this.prevX[i] = this.x[i];
      this.prevY[i] = this.y[i];
    }
  }

  /** Something under this point went away: the sleepers around and above it
   *  have to check that they are still held up. `what` says whether it could
   *  have been holding anything but water (`DIRTY_SOLID`) or was only a drop
   *  (`DIRTY_LIQUID`), which never held a grain of sand up. */
  private markDirty(px: number, py: number, what = DIRTY_SOLID): void {
    const cx = Math.min(this.cols - 1, Math.max(0, (px / this.cellW) | 0));
    const cy = Math.min(this.rows - 1, Math.max(0, (py / this.cellH) | 0));
    const cell = cy * this.cols + cx;
    const was = this.dirty[cell];
    this.dirty[cell] = was | what;
    if (was !== 0) return;
    if (this.dirtyCount === this.dirtyList.length) {
      const next = new Int32Array(this.dirtyList.length * 2);
      next.set(this.dirtyList);
      this.dirtyList = next;
    }
    this.dirtyList[this.dirtyCount++] = cell;
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

      // Whatever was resting on this grain has lost its support.
      this.markDirty(x[i], y[i]);

      const last = --this.count;
      if (i !== last) {
        x[i] = x[last];
        y[i] = y[last];
        this.vx[i] = this.vx[last];
        this.vy[i] = this.vy[last];
        this.kind[i] = this.kind[last];
        this.asleep[i] = this.asleep[last];
        this.restOn[i] = this.restOn[last];
        this.anchorX[i] = this.anchorX[last];
        this.anchorY[i] = this.anchorY[last];
        this.anchorTick[i] = this.anchorTick[last];
        this.quiet[i] = this.quiet[last];
        this.probation[i] = this.probation[last];
        this.homeX[i] = this.homeX[last];
        this.homeY[i] = this.homeY[last];
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
    // per grain, which is what this loop spends its time on. Liquids reach two
    // cells out (a 5x5 stencil) instead of needing a coarser grid of their own.
    const r = this.options.radius;
    const cell = Math.max(4, r * 2 + 2);
    this.cols = Math.max(1, Math.ceil(this.width / cell));
    this.rows = Math.max(1, Math.ceil(this.height / cell));
    this.cellW = this.width / this.cols;
    this.cellH = this.height / this.rows;
    const cells = this.cols * this.rows + 1;
    this.cellStart = new Int32Array(cells);
    this.cellFill = new Int32Array(cells);
    this.dirty = new Uint8Array(cells);
    this.dirtyCount = 0;
    this.cellLabel = new Int32Array(cells);
    this.cellStack = new Int32Array(cells);

    this.reach = Math.min(FLUID.reach * 2 * r, 2 * Math.min(this.cellW, this.cellH) - 0.01);
    this.rho0 = restDensity(FLUID.spacing * 2 * r, this.reach);
  }

  /** One fixed step. The engine always passes one 60 Hz tick. */
  step(colliders: readonly GrainCollider[] = NO_COLLIDERS): void {
    const n = this.count;
    if (n === 0) {
      this.colCount = 0;
      this.awake = 0;
      this.dirtyCount = 0;
      return;
    }

    this.updateColliders(colliders);
    this.integrate();
    this.bucket();

    this.inStep = true;
    this.wakeDirty();
    this.audit();

    if (this.fluidCount > 0) this.relaxLiquid();
    this.findContacts();
    for (let pass = 0; pass < this.options.iterations; pass++) this.solveContacts(pass);
    if (this.fluidCount > 0) this.liquidVelocity();

    this.collideBodies();
    this.holdVelocity();
    this.finish();
    if (++this.settleTick >= SLEEP_WINDOW) {
      this.settleTick = 0;
      this.settleLiquid();
    }
    this.inStep = false;
  }

  // --- the step, in order --------------------------------------------------

  /** Gravity, then move. Also lists who is awake and who of those is liquid. */
  private integrate(): void {
    const n = this.count;
    const { radius: r, gravity } = this.options;
    const { x, y, vx, vy, asleep, kind, prevX, prevY, active, fluid } = this;

    // A grain may not travel further in one step than the solver can resolve,
    // or it can tunnel through a thin body or through a wall of other grains.
    const maxStep = r * 2.5;
    const maxStepSq = maxStep * maxStep;
    let count = 0;
    let drops = 0;
    for (let i = 0; i < n; i++) {
      if (asleep[i] === 1) continue;
      active[count++] = i;
      if (LIQUID[kind[i]] === 1) fluid[drops++] = i;
      vy[i] += gravity;
      const v2 = vx[i] * vx[i] + vy[i] * vy[i];
      if (v2 > maxStepSq) {
        const k = maxStep / Math.sqrt(v2);
        vx[i] *= k;
        vy[i] *= k;
      }
      prevX[i] = x[i];
      prevY[i] = y[i];
      x[i] += vx[i];
      y[i] += vy[i];
    }
    this.activeCount = count;
    this.fluidCount = drops;
  }

  /** Counting sort into the grid. Asleep grains are bucketed too: an awake
   *  grain has to be able to find them, or it would sink through a pile. */
  private bucket(): void {
    const n = this.count;
    const { x, y, cols, rows, cellW, cellH, cellStart, cellFill, order, cellOf } = this;

    cellStart.fill(0);
    for (let i = 0; i < n; i++) {
      const cx = Math.min(cols - 1, Math.max(0, (x[i] / cellW) | 0));
      const cy = Math.min(rows - 1, Math.max(0, (y[i] / cellH) | 0));
      const cell = cy * cols + cx;
      cellOf[i] = cell;
      cellStart[cell + 1]++;
    }
    for (let c = 1, cells = cols * rows; c <= cells; c++) cellStart[c] += cellStart[c - 1];

    cellFill.set(cellStart);
    for (let i = 0; i < n; i++) order[cellFill[cellOf[i]]++] = i;
  }

  /**
   * Wake the sleepers in and beside every dirty cell, and in the row above it:
   * the grains that may have been resting on whatever left. They fall if they
   * have to, and leave dirty cells of their own as they go, so a collapse
   * spreads exactly as far as the support it lost.
   */
  private wakeDirty(): void {
    const { cols, cellStart, order, asleep, kind, restOn, dirty, dirtyList } = this;
    const lastCol = cols - 1;
    for (let d = 0; d < this.dirtyCount; d++) {
      const cell = dirtyList[d];
      const solid = (dirty[cell] & DIRTY_SOLID) !== 0;
      dirty[cell] = 0;
      const cy = (cell / cols) | 0;
      const cx = cell - cy * cols;
      const gx0 = cx > 0 ? cx - 1 : 0;
      const gx1 = cx < lastCol ? cx + 1 : lastCol;
      for (let gy = cy > 0 ? cy - 1 : 0; gy <= cy; gy++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          const c = gy * cols + gx;
          for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
            const j = order[k];
            if (asleep[j] === 1 && (solid || LIQUID[kind[j]] === 1 || (restOn[j] & REST_WATER) !== 0)) {
              this.wake(j, PROBATION);
            }
          }
        }
      }
    }
    this.dirtyCount = 0;
  }

  /**
   * The safety net under `wakeDirty`: re-check a slice of the sleepers every
   * step, and wake any that nothing is holding up any more - a body that slid
   * out too slowly to wake what it carried, say.
   */
  private audit(): void {
    const n = this.count;
    const span = Math.max(1, Math.ceil(n / AUDIT_SHARE));
    let i = this.auditCursor >= n ? 0 : this.auditCursor;
    for (let k = 0; k < span; k++) {
      if (this.asleep[i] === 1) {
        const rest = this.restOn[i];
        const held = ((rest & REST_BODY) !== 0 && this.nearBody(i)) || this.cradled(i, (rest & REST_WATER) !== 0);
        if (!held) {
          this.wake(i);
          this.markDirty(this.x[i], this.y[i]);
        }
      }
      if (++i >= n) i = 0;
    }
    this.auditCursor = i;
  }

  /**
   * The liquid: double-density relaxation (Clavet et al. 2005).
   *
   * Each drop sums its neighbours twice: a density (how crowded it is) and a
   * near-density (how close the closest ones are). Pressure is the excess over
   * the rest density and pushes neighbours apart along the line between them;
   * near-pressure is always repulsive and keeps drops from merging. A drop
   * short of its rest density pulls a little (surface tension), capped at
   * `FLUID.tension` so a stray pair does not collapse into one.
   *
   * Sand and sleeping drops count towards a drop's density - they are the
   * walls of the pool - but only an awake drop is moved.
   *
   * The displacements are summed and applied together (Jacobi), not one pair
   * at a time. Applied in place, each drop sees the ones before it in index
   * order already moved, and that bias is not noise: it drives a steady
   * current along the bottom of a pool that is otherwise level, so no drop in
   * it ever stops. Summed, what is left is a jitter that goes nowhere, and a
   * still pool can sleep. It also means every pair is measured once.
   */
  private relaxLiquid(): void {
    const { x, y, vx, vy, kind, asleep, prevX, prevY, cols, rows, cellStart, order, cellOf, fluid } = this;
    const { rho, rhoNear, inFluid, nearSolid } = this;
    const h = this.reach;
    const h2 = h * h;
    const rho0 = this.rho0;
    const r = this.options.radius;
    const solid2 = (2 * r + 4) * (2 * r + 4);
    const k = FLUID.stiffness;
    const kNear = FLUID.nearStiffness;
    const floorP = -k * rho0 * FLUID.tension;
    const visc = FLUID.viscosity;
    const maxD = r * 0.5;
    const lastCol = cols - 1;
    const lastRow = rows - 1;
    const drops = this.fluidCount;

    for (let f = 0; f < drops; f++) {
      const i = fluid[f];
      inFluid[i] = 1;
      rho[i] = 0;
      rhoNear[i] = 0;
    }

    // Pass 1: neighbours and densities. A pair of awake drops is found from
    // its lower index only and counted for both; anything else - sand, or a
    // sleeping drop - is only ever a neighbour, so it is kept on this side.
    let at = 0;
    for (let f = 0; f < drops; f++) {
      const i = fluid[f];
      this.nbrStart[f] = at;
      if (this.nbr.length < at + 64) this.growNeighbours((at + 64) * 2);

      const cell = cellOf[i];
      const cy = (cell / cols) | 0;
      const cx = cell - cy * cols;
      const xi = x[i];
      const yi = y[i];
      let density = rho[i];
      let near = rhoNear[i];
      let solid = 0;
      for (let gy = cy > 1 ? cy - 2 : 0, gy1 = cy < lastRow - 1 ? cy + 2 : lastRow; gy <= gy1; gy++) {
        const rowBase = gy * cols;
        for (let gx = cx > 1 ? cx - 2 : 0, gx1 = cx < lastCol - 1 ? cx + 2 : lastCol; gx <= gx1; gx++) {
          for (let s = cellStart[rowBase + gx], e = cellStart[rowBase + gx + 1]; s < e; s++) {
            const j = order[s];
            const partner = inFluid[j] === 1;
            if (partner ? j <= i : j === i) continue;
            const dx = x[j] - xi;
            const dy = y[j] - yi;
            const d2 = dx * dx + dy * dy;
            if (d2 >= h2 || d2 === 0) continue;
            if (LIQUID[kind[j]] === 0 && d2 < solid2) solid = 1;
            const d = Math.sqrt(d2);
            const q = 1 - d / h;
            const q2 = q * q;
            density += q2;
            near += q2 * q;
            if (partner) {
              rho[j] += q2;
              rhoNear[j] += q2 * q;
            }
            if (at === this.nbr.length) this.growNeighbours(at * 2);
            this.nbr[at] = j;
            this.nbrQ[at] = q;
            this.nbrNx[at] = dx / d;
            this.nbrNy[at] = dy / d;
            at++;
          }
        }
      }
      rho[i] = density;
      rhoNear[i] = near;
      nearSolid[i] = solid;
    }
    this.nbrStart[drops] = at;

    // Two smaller relaxations rather than one big one. A drop at the bottom of
    // a deep pool is squeezed until it has more neighbours inside the kernel
    // than one at the surface, so the summed push is larger there; a single
    // relaxation stiff enough to hold the column up overshoots at the bottom
    // and the pool boils for ever, and one soft enough to be stable lets it
    // compress by a third. The second pass re-measures the same pairs - the
    // grid search is not repeated.
    const { nbr, nbrQ, nbrNx, nbrNy, nbrStart, accX, accY } = this;
    const relax = FLUID.relax;
    for (let iteration = 0; iteration < FLUID.iterations; iteration++) {
      if (iteration > 0) {
        for (let f = 0; f < drops; f++) {
          const i = fluid[f];
          rho[i] = 0;
          rhoNear[i] = 0;
        }
        for (let f = 0; f < drops; f++) {
          const i = fluid[f];
          const xi = x[i];
          const yi = y[i];
          for (let s = nbrStart[f], e = nbrStart[f + 1]; s < e; s++) {
            const j = nbr[s];
            const dx = x[j] - xi;
            const dy = y[j] - yi;
            const d2 = dx * dx + dy * dy;
            if (d2 >= h2 || d2 === 0) {
              nbrQ[s] = 0;
              continue;
            }
            const d = Math.sqrt(d2);
            const q = 1 - d / h;
            const q2 = q * q;
            nbrQ[s] = q;
            nbrNx[s] = dx / d;
            nbrNy[s] = dy / d;
            rho[i] += q2;
            rhoNear[i] += q2 * q;
            if (inFluid[j] === 1) {
              rho[j] += q2;
              rhoNear[j] += q2 * q;
            }
          }
        }
      }

      // Densities to pressures, in place: nothing reads a density after this.
      for (let f = 0; f < drops; f++) {
        const i = fluid[f];
        const p = k * (rho[i] - rho0);
        rho[i] = p < floorP ? floorP : p;
        rhoNear[i] = kNear * rhoNear[i];
      }

      // Pass 2: displacements, summed.
      for (let f = 0; f < drops; f++) {
        const i = fluid[f];
        const pi = rho[i];
        const pni = rhoNear[i];
        const dix = x[i] - prevX[i];
        const diy = y[i] - prevY[i];

        for (let s = this.nbrStart[f], e = this.nbrStart[f + 1]; s < e; s++) {
          const j = nbr[s];
          const q = nbrQ[s];
          const nx = nbrNx[s];
          const ny = nbrNy[s];
          let push = pi * q + pni * q * q;
          if (push > maxD) push = maxD;
          else if (push < -maxD) push = -maxD;

          if (inFluid[j] === 1) {
            // Both drops' pressures, shared equally.
            let pushJ = rho[j] * q + rhoNear[j] * q * q;
            if (pushJ > maxD) pushJ = maxD;
            else if (pushJ < -maxD) pushJ = -maxD;
            const shove = (push + pushJ) * 0.5;
            // Viscosity: share a little of the pair's relative motion.
            const m = visc * q;
            const rx = (x[j] - prevX[j] - dix) * m;
            const ry = (y[j] - prevY[j] - diy) * m;
            accX[i] += rx - nx * shove;
            accY[i] += ry - ny * shove;
            accX[j] -= rx - nx * shove;
            accY[j] -= ry - ny * shove;
          } else if (LIQUID[kind[j]] === 1) {
            // A sleeping drop: still water. An awake pair moves each drop by the
            // mean of their two pushes; the sleeper's pressure is not known, but
            // it is still water next to this drop, so its push is taken as the
            // same - and this drop, the only one that can move, takes all of it.
            // (Half of it leaves a drop woken inside a sleeping pool with half
            // its support, and it falls through and wakes the rest.) It wakes
            // the sleeper for a drop that is really moving into it.
            if (asleep[j] === 1 && vx[i] * nx + vy[i] * ny > FLUID_WAKE) this.wake(j);
            accX[i] -= nx * push;
            accY[i] -= ny * push;
          } else if (push > 0) {
            // Sand: a wall. This drop takes all of it, and does not stick to it.
            accX[i] -= nx * push;
            accY[i] -= ny * push;
          }
        }
      }

      for (let f = 0; f < drops; f++) {
        const i = fluid[f];
        x[i] += accX[i] * relax;
        y[i] += accY[i] * relax;
        accX[i] = 0;
        accY[i] = 0;
      }
    }
    for (let f = 0; f < drops; f++) inFluid[fluid[f]] = 0;
  }

  private growNeighbours(size: number): void {
    const grow = <T extends Int32Array | Float32Array>(a: T, make: (n: number) => T): T => {
      const next = make(size);
      next.set(a);
      return next;
    };
    this.nbr = grow(this.nbr, (n) => new Int32Array(n));
    this.nbrQ = grow(this.nbrQ, (n) => new Float32Array(n));
    this.nbrNx = grow(this.nbrNx, (n) => new Float32Array(n));
    this.nbrNy = grow(this.nbrNy, (n) => new Float32Array(n));
  }

  /**
   * Every pair that can touch this step, each once: an awake grain and a
   * neighbour within reach - asleep, or awake with a higher index, or a drop
   * that the relaxation said has no sand by it (so it never looks itself).
   * Drop-drop pairs are the liquid's and are left out.
   */
  private findContacts(): void {
    const { x, y, kind, asleep, cols, rows, cellStart, order, cellOf, active, nearSolid } = this;
    const r = this.options.radius;
    const reach = r * 2 + r * CONTACT_MARGIN;
    const reachSq = reach * reach;
    const lastCol = cols - 1;
    const lastRow = rows - 1;
    let at = 0;

    for (let a = 0; a < this.activeCount; a++) {
      const i = active[a];
      if (asleep[i] === 1) continue;
      const liquidI = LIQUID[kind[i]];
      if (liquidI === 1 && nearSolid[i] === 0) continue;
      const xi = x[i];
      const yi = y[i];

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
          for (let s = cellStart[rowBase + gx], e = cellStart[rowBase + gx + 1]; s < e; s++) {
            const j = order[s];
            if (j === i) continue;
            const liquidJ = LIQUID[kind[j]];
            if (liquidI === 1 && liquidJ === 1) continue;
            // Visit each awake pair once. A sleeping grain is never the outer
            // index, so a pair with one is always found from this side; nor
            // is a drop that is not looking.
            if (j < i && asleep[j] === 0 && !(liquidJ === 1 && nearSolid[j] === 0)) continue;
            const dx = x[j] - xi;
            const dy = y[j] - yi;
            if (dx * dx + dy * dy >= reachSq) continue;
            if (at === this.pairI.length) {
              this.pairI = growInt(this.pairI, at * 2);
              this.pairJ = growInt(this.pairJ, at * 2);
            }
            this.pairI[at] = i;
            this.pairJ[at] = j;
            at++;
          }
        }
      }
    }
    this.pairCount = at;
  }

  /**
   * Disc contacts with Coulomb friction. Drop-drop pairs are the liquid's, and
   * a drop only takes part in the first two passes: the extra passes are what
   * a sand heap needs to carry its own weight, and water has pressure for that.
   *
   * The pairs are found once per step (`findContacts`) and every pass walks
   * that list: a grain moves a fraction of a radius in a step, so the pairs
   * that can touch do not change between passes, and scanning nine cells five
   * times over was most of the cost of a heap.
   */
  private solveContacts(pass: number): void {
    const { x, y, vx, vy, kind, asleep, touched, supX, supY, pairI, pairJ } = this;
    const r = this.options.radius;
    const minDist = r * 2;
    const minDistSq = minDist * minDist;
    const maxPush = r * 1.2;
    const liquidPasses = 2;
    const slop = r * SLEEPER_SLOP;

    for (let p = 0, pairs = this.pairCount; p < pairs; p++) {
      const i = pairI[p];
      const j = pairJ[p];
      const ki = kind[i];
      const kj = kind[j];
      if (pass >= liquidPasses && (LIQUID[ki] === 1 || LIQUID[kj] === 1)) continue;
      const wi = INV_MASS[ki];
      const fixed = asleep[j] === 1;

      // Re-read: both move as earlier pairs are resolved.
      const xi = x[i];
      const yi = y[i];
      const dx = x[j] - xi;
      const dy = y[j] - yi;
      const d2 = dx * dx + dy * dy;
      if (d2 >= minDistSq || d2 === 0) continue;

      const d = Math.sqrt(d2);
      const nx = dx / d;
      const ny = dy / d;
      const rvx = vx[j] - vx[i];
      const rvy = vy[j] - vy[i];
      const normalSpeed = rvx * nx + rvy * ny;

      // A sleeping grain wakes for a real hit. It used to need a hard
      // one, because a woken heap slumped; with friction it holds. A sleeping
      // drop also wakes for any sand pressing on it: water cannot hold sand
      // up, and a frozen drop would.
      if (fixed && (-normalSpeed > WAKE_SPEED || (HOLDS[kj] === 0 && HOLDS[ki] === 1))) this.wake(j);
      else if (this.probation[j] !== 0 && -normalSpeed > WAKE_SPEED) this.probation[j] = 0;
      const wj = asleep[j] === 1 ? 0 : INV_MASS[kj];
      const wsum = wi + wj;

      // Position: share the overlap by inverse mass. A sleeper is a wall.
      const pen = Math.min(minDist - d - (wj === 0 ? slop : 0), maxPush);
      if (pen <= 0) continue;
      const pi = (pen * wi) / wsum;
      const pj = (pen * wj) / wsum;
      x[i] = xi - nx * pi;
      y[i] = yi - ny * pi;
      x[j] += nx * pj;
      y[j] += ny * pj;

      // No friction on this correction: cancelling the pair's tangential
      // drift here held a slope ~2 degrees steeper, and under the weight of
      // a deep bed (pen large, so the cone wide) it shoved grains sideways
      // every step - the bottom of an 80-layer bed never stopped moving.

      // Which way each was pushed: the direction it is held from. A
      // sleeper is not walked by `finish`, so it must not be marked.
      touched[i] = 1;
      supX[i] -= nx * pi;
      supY[i] -= ny * pi;
      if (wj !== 0) {
        touched[j] = 1;
        supX[j] += nx * pj;
        supY[j] += ny * pj;
      }

      if (normalSpeed >= 0) continue; // already separating

      // Velocity: an inelastic impulse along the normal - restitution
      // only for a real hit, or a resting heap buzzes - and Coulomb
      // friction on the tangent, bounded by that impulse. Below the cone
      // the slip is cancelled outright: that is static friction, and it
      // is what holds a slope.
      const tx = -ny;
      const ty = nx;
      const muIJ = (MU[ki] + MU[kj]) * 0.5;
      const e = -normalSpeed > BOUNCE_SPEED ? (BOUNCE[ki] + BOUNCE[kj]) * 0.5 : 0;
      const jn = (-(1 + e) * normalSpeed) / wsum;
      const slip = rvx * tx + rvy * ty;
      const jt = (slip - coulomb(slip, jn * wsum, muIJ)) / wsum;

      vx[i] += (-nx * jn + tx * jt) * wi;
      vy[i] += (-ny * jn + ty * jt) * wi;
      vx[j] += (nx * jn - tx * jt) * wj;
      vy[j] += (ny * jn - ty * jt) * wj;
    }
  }

  /** A drop's velocity is where it went: no impulse model for the liquid. */
  private liquidVelocity(): void {
    const { x, y, vx, vy, prevX, prevY, fluid, asleep } = this;
    for (let f = 0; f < this.fluidCount; f++) {
      const i = fluid[f];
      if (asleep[i] === 1) continue;
      vx[i] = x[i] - prevX[i];
      vy[i] = y[i] - prevY[i];
    }
  }

  /**
   * Kill the velocity that contacts are holding. A grain resting on a pile
   * picks up one gravity step per frame and is pushed straight back out of the
   * contact; the position comes back but the velocity never does, so the heap
   * would churn for ever without going anywhere. The support direction says
   * which part of that velocity is being held, so remove exactly that.
   * Tangential motion is untouched: friction already had its say.
   */
  private holdVelocity(): void {
    const { vx, vy, supX, supY, active, asleep } = this;
    for (let a = 0; a < this.activeCount; a++) {
      const i = active[a];
      if (asleep[i] === 1) continue;
      const sx = supX[i];
      const sy = supY[i];
      const len2 = sx * sx + sy * sy;
      if (len2 === 0) continue;

      const len = Math.sqrt(len2);
      const nx = sx / len;
      const ny = sy / len;
      const vn = vx[i] * nx + vy[i] * ny;
      if (vn < 0) {
        vx[i] -= vn * nx;
        vy[i] -= vn * ny;
      }
    }
  }

  /** Rolling resistance, the walls, the dirty cells a mover leaves, and sleep. */
  private finish(): void {
    const { x, y, vx, vy, kind, asleep, touched, onBody, supX, supY, active } = this;
    const { anchorX, anchorY, anchorTick, quiet, homeX, homeY } = this;
    const r = this.options.radius;
    const left = r;
    const right = this.width - r;
    const top = r;
    const bottom = this.height - r;
    const r2 = r * r;
    let awake = 0;

    for (let a = 0; a < this.activeCount; a++) {
      const i = active[a];
      if (asleep[i] === 1) continue;
      const ki = kind[i];
      const mu = MU[ki];
      const liquid = LIQUID[ki] === 1;

      // Rolling resistance: only for a grain that is already slow and touching
      // something, so a falling stream is untouched and a lone grain rolling
      // across a flat floor eventually stops instead of orbiting for ever.
      // Not on a body: it is relative to what the grain rolls on, and a belt
      // moves. Friction against the face already holds it there.
      if (touched[i] === 1 && onBody[i] === 0) {
        const speed = Math.abs(vx[i]) + Math.abs(vy[i]);
        if (speed < ROLL_SPEED) {
          vx[i] *= ROLLING[ki];
          vy[i] *= ROLLING[ki];
        }
      }

      // Walls. The floor and the sides carry Coulomb friction for a solid, so
      // the foot of a heap grips the floor instead of skating outwards.
      if (x[i] < left || x[i] > right) {
        const into = Math.abs(vx[i]);
        x[i] = x[i] < left ? left : right;
        const sign = x[i] === left ? 1 : -1;
        vx[i] = sign * into * (into > BOUNCE_SPEED ? BOUNCE[ki] : 0);
        if (!liquid) vy[i] = coulomb(vy[i], into, mu);
      }
      if (y[i] > bottom) {
        const into = Math.max(0, vy[i]);
        y[i] = bottom;
        vy[i] = -into * (into > BOUNCE_SPEED ? BOUNCE[ki] : 0);
        vx[i] = liquid ? vx[i] * (1 - mu) : coulomb(vx[i], into, mu);
      } else if (y[i] < top) {
        y[i] = top;
        vy[i] = Math.abs(vy[i]) * (Math.abs(vy[i]) > BOUNCE_SPEED ? BOUNCE[ki] : 0);
      }

      // Moved a radius from where it last told anyone: whatever was resting
      // on it there has lost (some of) its support.
      const hx = x[i] - homeX[i];
      const hy = y[i] - homeY[i];
      if (hx * hx + hy * hy > r2) {
        this.markDirty(homeX[i], homeY[i], HOLDS[ki] === 1 ? DIRTY_SOLID : DIRTY_LIQUID);
        homeX[i] = x[i];
        homeY[i] = y[i];
      }

      // Probation: a grain woken to look again goes back to sleep at once if
      // it has not fallen and is still held up.
      const trial = this.probation[i];
      if (trial !== 0) {
        this.probation[i] = trial - 1;
        if (trial === 1) {
          const mx = x[i] - anchorX[i];
          const my = y[i] - anchorY[i];
          if (mx * mx + my * my < PROBATION_DRIFT * PROBATION_DRIFT) {
            const held = this.heldBy(i);
            if (held !== 0) {
              asleep[i] = 1;
              this.restOn[i] = (onBody[i] === 1 ? REST_BODY : 0) | (held === REST_WATER ? REST_WATER : 0);
              vx[i] = 0;
              vy[i] = 0;
            }
          }
        }
      }

      // Sleep: stopped over a whole window, and held up by something.
      if (asleep[i] === 0 && ++anchorTick[i] >= SLEEP_WINDOW) {
        anchorTick[i] = 0;
        const mx = x[i] - anchorX[i];
        const my = y[i] - anchorY[i];
        anchorX[i] = x[i];
        anchorY[i] = y[i];

        if (mx * mx + my * my > SLEEP_DRIFT2[ki]) {
          quiet[i] = 0;
        } else if (++quiet[i] >= SLEEP_WINDOWS[ki] && !liquid) {
          const held = this.heldBy(i);
          if (held !== 0) {
            asleep[i] = 1;
            this.restOn[i] = (onBody[i] === 1 ? REST_BODY : 0) | (held === REST_WATER ? REST_WATER : 0);
            vx[i] = 0;
            vy[i] = 0;
          }
        }
      }

      if (asleep[i] === 0) awake++;
      touched[i] = 0;
      onBody[i] = 0;
      supX[i] = 0;
      supY[i] = 0;
    }

    this.awake = awake;
  }

  /**
   * Put still water to sleep, one body of it at a time.
   *
   * A drop never sleeps on its own. A pool is never perfectly still - the
   * pressure solve leaves every drop wandering a little, and drops swap places
   * inside a level pool without it changing at all - and a drop that does
   * stop becomes a wall its awake neighbours jostle against, which knocks it
   * awake again. Pools that slept drop by drop never slept. So the water is
   * split into connected bodies (grid cells holding awake drops, touching),
   * and a body sleeps whole once nearly every drop in it has been quiet for
   * its windows. Waking stays local: a splash wakes the drops it reaches, and
   * those can only spread until their body is all awake - which, once it is
   * still again, is what passes this test.
   */
  private settleLiquid(): void {
    const { cols, rows, cellLabel, cellStack, cellOf, kind, asleep, quiet, vx, vy } = this;
    const n = this.count;
    cellLabel.fill(0);
    // Mark the cells with awake water: -1 is "water, not labelled yet".
    let any = false;
    for (let i = 0; i < n; i++) {
      if (asleep[i] === 0 && LIQUID[kind[i]] === 1) {
        cellLabel[cellOf[i]] = -1;
        any = true;
      }
    }
    if (!any) return;

    // Label the touching cells: one flood fill per body of water.
    let labels = 0;
    for (let c = 0, cells = cols * rows; c < cells; c++) {
      if (cellLabel[c] !== -1) continue;
      const label = ++labels;
      let top = 0;
      cellStack[top++] = c;
      cellLabel[c] = label;
      while (top > 0) {
        const cell = cellStack[--top];
        const cy = (cell / cols) | 0;
        const cx = cell - cy * cols;
        for (let gy = cy > 0 ? cy - 1 : 0, gy1 = cy < rows - 1 ? cy + 1 : cy; gy <= gy1; gy++) {
          for (let gx = cx > 0 ? cx - 1 : 0, gx1 = cx < cols - 1 ? cx + 1 : cx; gx <= gx1; gx++) {
            const next = gy * cols + gx;
            if (cellLabel[next] !== -1) continue;
            cellLabel[next] = label;
            cellStack[top++] = next;
          }
        }
      }
    }

    // Tally each body, and settle the still ones.
    const total = new Int32Array(labels + 1);
    const still = new Int32Array(labels + 1);
    for (let i = 0; i < n; i++) {
      if (asleep[i] === 1 || LIQUID[kind[i]] === 0) continue;
      const label = cellLabel[cellOf[i]];
      total[label]++;
      if (quiet[i] >= SLEEP_WINDOWS[kind[i]]) still[label]++;
    }
    let slept = 0;
    for (let i = 0; i < n; i++) {
      if (asleep[i] === 1 || LIQUID[kind[i]] === 0) continue;
      const label = cellLabel[cellOf[i]];
      if (still[label] < total[label] * POOL_STILL) continue;
      asleep[i] = 1;
      this.restOn[i] = 0;
      vx[i] = 0;
      vy[i] = 0;
      this.homeX[i] = this.x[i];
      this.homeY[i] = this.y[i];
      slept++;
    }
    if (slept === 0) return;
    this.awake -= slept;

    // A body that has just been found still was only wandering: the cells its
    // drops left dirty on the way are not support anything lost, and would
    // wake it again on the very next step.
    let kept = 0;
    for (let d = 0; d < this.dirtyCount; d++) {
      const cell = this.dirtyList[d];
      const label = cellLabel[cell];
      if (label > 0 && still[label] >= total[label] * POOL_STILL) this.dirty[cell] = 0;
      else this.dirtyList[kept++] = cell;
    }
    this.dirtyCount = kept;
  }

  /**
   * Is this grain held up, rather than merely slow? On the floor or on a body,
   * or by contacts that can push it up between them.
   *
   * Each contact pushes the grain away from its neighbour, and friction lets
   * that push lean by up to the friction angle either way. The grain is held
   * if "up" is inside the fan those pushes make: one push within the friction
   * angle of up, or two on either side of up less than half a turn apart -
   * which covers sitting in a dip, being wedged between two neighbours or a
   * neighbour and a side wall, and being jammed under an arch. A grain perched
   * on the outside of a single neighbour is not held: it is still sliding off,
   * however slowly, and must not be frozen there.
   */
  private cradled(i: number, onWater = false): boolean {
    const r = this.options.radius;
    if (this.y[i] >= this.height - r - 0.5 || this.onBody[i] === 1) return true;

    const { x, y, kind, cols, rows, cellStart, order, cellOf } = this;
    // A drop asks less: water in a pool rests on whatever is under it, and it
    // only sleeps a body at a time, so the question for one drop is just
    // whether the floor under it went away.
    const liquid = LIQUID[this.kind[i]] === 1;
    const lean = CRADLE_ANGLE[this.kind[i]];
    // Drops sit further apart than grains near the top of a pool.
    const reachD = liquid ? 2 * r + 3 : 2 * r + 0.75;
    const reach2 = reachD * reachD;
    const cell = cellOf[i];
    const cy = (cell / cols) | 0;
    const cx = cell - cy * cols;
    // Angles of the pushes from straight up, positive to the right: the
    // nearest one on each side. A side wall pushes level, inwards.
    let right = x[i] <= r + 0.5 ? Math.PI / 2 : Infinity;
    let left = x[i] >= this.width - r - 0.5 ? -Math.PI / 2 : -Infinity;

    for (let gy = cy > 0 ? cy - 1 : 0, gy1 = Math.min(rows - 1, cy + 1); gy <= gy1; gy++) {
      for (let gx = cx > 0 ? cx - 1 : 0, gx1 = Math.min(cols - 1, cx + 1); gx <= gx1; gx++) {
        const c = gy * cols + gx;
        for (let s = cellStart[c]; s < cellStart[c + 1]; s++) {
          const j = order[s];
          if (j === i) continue;
          const dx = x[j] - x[i];
          const dy = y[j] - y[i];
          if (dx * dx + dy * dy > reach2) continue;
          if (liquid) {
            if (dy > 0) return true;
            continue;
          }
          // Sand is not held up by water: it sinks through it - unless it is
          // jammed there and has stopped, see `heldBy`.
          if (HOLDS[kind[j]] === 0 && !onWater) continue;
          // The push is (-dx, -dy); up is (0, -1).
          const angle = Math.atan2(-dx, dy);
          if (Math.abs(angle) <= lean) return true;
          if (angle > 0) {
            if (angle < right) right = angle;
          } else if (angle > left) left = angle;
        }
      }
    }
    return right - left < Math.PI + 2 * lean;
  }

  /**
   * What is holding a still grain up: 0 if nothing, 1 if sand, a body, a wall
   * or the floor, `REST_WATER` if only water is. Sand sinks through water, so
   * it is not held by it while it is still sinking - but a grain that sank
   * onto drops pinned against the floor or other sand has stopped, and must be
   * allowed to sleep, or it presses on them for ever and nothing in the pool
   * sleeps either. It sleeps marked as resting on water, so any drop moving
   * away from under it wakes it again (see `wakeDirty`).
   */
  private heldBy(i: number): number {
    if (this.cradled(i)) return 1;
    if (LIQUID[this.kind[i]] === 0 && this.cradled(i, true)) return REST_WATER;
    return 0;
  }

  /** Is any body's bounding box within reach of this grain? The audit's test
   *  for a grain that went to sleep on a body - a box, not a hull, because a
   *  false "yes" only costs the grain one more look later. */
  private nearBody(i: number): boolean {
    const r = this.options.radius + 2;
    const gx = this.x[i];
    const gy = this.y[i];
    for (let c = 0; c < this.colCount; c++) {
      if (gx < this.colMinX[c] - r || gx > this.colMaxX[c] + r) continue;
      if (gy < this.colMinY[c] - r || gy > this.colMaxY[c] + r) continue;
      return true;
    }
    return false;
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
      this.holdFx[c] = 0;
      this.holdFy[c] = 0;
      this.contacts[c] = 0;
      this.grip[c] = 0;
      this.dragX[c] = 0;
      this.dragY[c] = 0;
      this.dragTorque[c] = 0;

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

            const gx = x[i];
            const gy = y[i];
            if (gx < minX || gx > maxX || gy < minY || gy > maxY) continue;

            if (asleep[i] === 1) {
              if (!wake) continue;
              this.wake(i);
            }

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
    // A face under the grain (up to 60 degrees off level) is holding it up.
    if (normalY < -0.5) this.onBody[i] = 1;
    this.supX[i] += normalX * depth;
    this.supY[i] += normalY * depth;

    // Velocity, relative to the surface (the body's own motion plus a belt's
    // drift): reflect the normal part with restitution, and take friction off
    // the slip - Coulomb for a solid, so sand sticks to a ramp until it is too
    // steep, a plain drag for a liquid.
    const beforeX = this.vx[i];
    const beforeY = this.vy[i];
    const ki = this.kind[i];
    const mu = MU[ki];
    const svx = this.colVelX[c] + this.colSurfX[c];
    const svy = this.colVelY[c] + this.colSurfY[c];
    const rvx = this.vx[i] - svx;
    const rvy = this.vy[i] - svy;
    const into = rvx * normalX + rvy * normalY;
    const hit = into < 0 ? -into : 0;
    const out = hit > BOUNCE_SPEED ? hit * BOUNCE[ki] : 0;
    const tx = -normalY;
    const ty = normalX;
    const slip = rvx * tx + rvy * ty;
    const left = LIQUID[ki] === 1 ? slip * (1 - mu) : coulomb(slip, hit, mu);
    // Whatever normal speed was not going in (separating) is kept.
    const keepN = into < 0 ? out : into;
    this.vx[i] = svx + tx * left + normalX * keepN;
    this.vy[i] = svy + ty * left + normalY * keepN;

    const mass = this.colMass[c];
    if (mass === 0) return;

    const material = MATERIALS[ki];
    this.contacts[c]++;
    this.grip[c] += material.grip;

    // The load is the opposite of the outward normal: the grain pushes *into*
    // the body. Weighted by `support`, so sand can carry a body and water
    // leaves no load behind it - there is no buoyancy to model.
    const fx = -normalX * material.support;
    const fy = -normalY * material.support;
    this.loadFx[c] += fx;
    this.loadFy[c] += fy;
    this.loadTorque[c] += (gx - this.colCx[c]) * fy - (gy - this.colCy[c]) * fx;

    // What the body is standing on: only the contacts that push it up.
    if (fy < 0) {
      this.holdFx[c] += fx;
      this.holdFy[c] += fy;
    }

    // Momentum: whatever the grain lost, the body gained. This is what makes a
    // ball sink into sand instead of falling through it as if it were not there.
    const dx = beforeX - this.vx[i];
    const dy = beforeY - this.vy[i];
    if (dx !== 0 || dy !== 0) {
      this.dragX[c] += dx;
      this.dragY[c] += dy;
      this.dragTorque[c] += (gx - this.colCx[c]) * dy - (gy - this.colCy[c]) * dx;
    }
  }
}

/** Density a drop has in a hexagonal pool at `spacing`, with the same kernel
 *  `relaxLiquid` uses - the pressure is measured against this. */
function restDensity(spacing: number, reach: number): number {
  let rho = 0;
  const rows = Math.ceil(reach / spacing) + 1;
  for (let b = -rows; b <= rows; b++) {
    for (let a = -rows * 2; a <= rows * 2; a++) {
      if (a === 0 && b === 0) continue;
      const dx = (a + b * 0.5) * spacing;
      const dy = ((b * Math.sqrt(3)) / 2) * spacing;
      const q = 1 - Math.hypot(dx, dy) / reach;
      if (q > 0) rho += q * q;
    }
  }
  return rho;
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
