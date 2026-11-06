// Force fields for the gadget toys: the bomb's blast, the fan's wind, the black
// hole's pull and the trampoline's launch. Pure maths, no Matter and no DOM, so
// the engine only has to loop over bodies and apply what comes out of here.
//
// Units are Matter's: px per step for speeds, px per step squared for a change
// of speed applied every step. Gravity is `GRAVITY_ACCEL` (~0.278).

import { GRAVITY_ACCEL } from './world';

export interface Vec {
  x: number;
  y: number;
}

/**
 * A body's mass in the units the fields think in. Matter's mass is
 * `density * area`; a bouncy ball is ~0.74, a crate ~6.3, a cannonball ~15.
 */
const REFERENCE_MASS = 1;

// --- blast ----------------------------------------------------------------

/** Linear falloff from the centre of a circle: 1 at the middle, 0 at its edge. */
export function falloff(dist: number, radius: number): number {
  if (radius <= 0 || dist >= radius) return 0;
  return 1 - Math.max(0, dist) / radius;
}

/**
 * The speed a blast gives a body. A light body is thrown further than a heavy
 * one, but not in proportion to its mass - a beach ball and a cannonball should
 * both visibly move - so the mass enters as a clamped square root.
 */
export function blastSpeed(dist: number, radius: number, strength: number, mass: number): number {
  const f = falloff(dist, radius);
  if (f === 0) return 0;
  const weight = Math.min(1.8, Math.max(0.3, Math.sqrt(REFERENCE_MASS / Math.max(mass, 1e-6))));
  return strength * f * weight;
}

/** Unit vector from `from` to `to`, or straight up when they coincide. */
export function direction(fromX: number, fromY: number, toX: number, toY: number): Vec {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { x: 0, y: -1 };
  return { x: dx / len, y: dy / len };
}

// --- wind -----------------------------------------------------------------

/**
 * How much of the fan's wind reaches a point, given in the fan's own frame:
 * `along` the blowing direction and `across` it. The column widens a little
 * with distance and fades out linearly to `reach`, with a soft side edge.
 */
export function windAt(along: number, across: number, reach: number, halfWidth: number): number {
  if (along < 0 || along > reach) return 0;
  const t = along / reach;
  const width = halfWidth * (1 + 0.5 * t);
  const side = Math.abs(across);
  if (side >= width) return 0;
  const edge = Math.min(1, (width - side) / (width * 0.35));
  return (1 - t) * edge;
}

/** What wind does to a body each step: proportional to its size, against its
 *  mass. The cap keeps a feather-light body from being fired out like a shot. */
export const WIND_GAIN = 0.0105;

export function windSpeed(strength: number, area: number, mass: number): number {
  if (strength <= 0) return 0;
  return Math.min(1.2, (WIND_GAIN * strength * Math.sqrt(Math.max(area, 0))) / Math.max(mass, 1e-6));
}

/** The speed of the air coming off a fan at strength 1, px/step. Wind brings a
 *  body up to this and no further, so a ball in a sideways gust drifts rather
 *  than being fired across the box. */
export const WIND_TOP = 11;

/**
 * The change of speed along the wind this step, for a body already moving at
 * `vAlong` along it. Wind is drag towards the speed of the air (`WIND_TOP * f`),
 * so it falls to nothing as the body catches up, and never pushes backwards.
 */
export function windDelta(f: number, strength: number, area: number, mass: number, vAlong: number): number {
  if (f <= 0) return 0;
  const air = WIND_TOP * strength * f;
  if (vAlong >= air) return 0;
  const push = windSpeed(strength * f, area, mass);
  return Math.min(push, air - vAlong);
}

// --- black hole -----------------------------------------------------------

/**
 * The black hole's pull on something `dist` away: inward, growing as it gets
 * closer, with a sideways swirl so things spiral in instead of falling straight
 * down the middle. Returned as the change of speed for this step.
 */
export function holePull(dx: number, dy: number, reach: number, pull: number, swirl: number): Vec {
  const dist = Math.hypot(dx, dy);
  if (dist >= reach || dist < 1e-6) return { x: 0, y: 0 };
  const f = 1 - dist / reach;
  const strength = pull * f * f + pull * 0.15 * f;
  const nx = -dx / dist;
  const ny = -dy / dist;
  // Tangent: the inward normal turned a quarter clockwise on screen.
  return {
    x: nx * strength - ny * strength * swirl,
    y: ny * strength + nx * strength * swirl,
  };
}

// --- trampoline -------------------------------------------------------------

/**
 * Velocity after a body lands on a trampoline whose surface faces `normal`
 * (unit, pointing away from the pad). The tangential part is kept; the normal
 * part is thrown back out at least at `launch`, or a little harder than it came
 * in, up to `max`. A body already leaving the pad is left alone.
 */
export function launchVelocity(normal: Vec, velocity: Vec, launch: number, max: number): Vec {
  const vn = velocity.x * normal.x + velocity.y * normal.y;
  if (vn > launch) return { x: velocity.x, y: velocity.y };
  const out = Math.min(max, Math.max(launch, -vn * 1.05));
  const tx = velocity.x - vn * normal.x;
  const ty = velocity.y - vn * normal.y;
  return { x: tx + normal.x * out, y: ty + normal.y * out };
}

/** How high a body launched straight up at `speed` px/step rises, in px. */
export function apex(speed: number): number {
  return (speed * speed) / (2 * GRAVITY_ACCEL);
}

// --- balloon ----------------------------------------------------------------

/** The extra upward speed a balloon gets every step, as a multiple of gravity:
 *  above 1 it rises. */
export function liftSpeed(lift: number): number {
  return GRAVITY_ACCEL * lift;
}
