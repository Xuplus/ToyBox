// How the gadgets look, as numbers: colours, and the little animations (a fuse
// burning down, fan blades, a trampoline dipping, things spiralling into a black
// hole). Both painters read these, so the canvas path and the instanced path
// cannot drift apart - the same rule as `MATERIALS` for the grains.
//
// Pure: no canvas, no GL. Every function is a few multiplies.

import { shade } from '../lib/color';
import type { ToyMeta } from '../toys/types';
import type { Effect } from './scene';

export const GADGET = {
  /** the metal cap a bomb's fuse comes out of */
  bombCap: '#6b7385',
  fuse: '#d9bf8f',
  spark: '#ffd166',
  /** what a bomb flashes as its fuse runs out */
  danger: '#ff3b30',
  fanWell: '#141923',
  fanBlade: '#c9d4e3',
  fanHub: '#2a3242',
  trampolineFrame: '#2f3646',
  trampolineCap: '#9aa5b8',
  holeCore: '#040208',
  string: '#e8e3d8',
} as const;

/** Fraction of a bomb's fuse still to burn, 1 when lit, 0 when it goes. */
export function fuseLeft(meta: ToyMeta): number {
  const fuse = meta.fuse;
  if (!fuse || fuse.total <= 0) return 0;
  return Math.min(1, Math.max(0, fuse.left / fuse.total));
}

/**
 * How red a bomb is flashing, 0..1. Nothing for the first part of the fuse,
 * then a blink that gets faster and brighter as it runs down.
 */
export function bombDanger(meta: ToyMeta, time: number): number {
  const burnt = 1 - fuseLeft(meta);
  if (burnt < 0.35) return 0;
  const urgency = (burnt - 0.35) / 0.65;
  const hz = 2 + urgency * 9;
  const blink = 0.5 + 0.5 * Math.sin((time / 1000) * hz * Math.PI * 2);
  return urgency * (0.35 + 0.65 * blink);
}

/** The fuse's points in the bomb's own frame, from the cap to the spark. */
export function fusePoints(radius: number, left: number): { x: number; y: number }[] {
  // A short curl, cut down from the far end as it burns.
  const length = 4 + 14 * left;
  const steps = 4;
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const s = (i / steps) * length;
    points.push({ x: s * 0.55 + Math.sin(s * 0.22) * 2, y: -radius - 6 - s * 0.8 });
  }
  return points;
}

/** Spark size: flickers, so a lit fuse is visibly alive. */
export function sparkRadius(time: number): number {
  return 2.4 + 1.1 * Math.abs(Math.sin(time * 0.037)) + 0.6 * Math.abs(Math.sin(time * 0.091));
}

/** The string hanging under a balloon, in world px from its knot. */
export function balloonString(
  radius: number,
  time: number,
  id: number,
  vx: number,
): { x: number; y: number }[] {
  const length = radius * 1.6;
  const lean = Math.max(-6, Math.min(6, -vx * 2));
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    const sway = Math.sin(time * 0.004 + id * 1.7 + t * 2.4) * 2.5 * t;
    points.push({ x: sway + lean * t * t, y: radius + 4 + t * length });
  }
  return points;
}

/** Fan blade angle: spins steadily, faster for a stronger fan. */
export function fanSpin(time: number, strength: number): number {
  return (time * 0.02 * strength) % (Math.PI * 2);
}

export interface Streak {
  /** distance in front of the fan, world px */
  along: number;
  /** sideways offset, world px */
  across: number;
  length: number;
  alpha: number;
}

/** Wind streaks in front of a fan, in its frame. Writes into `out` and returns it. */
export function fanStreaks(time: number, width: number, reach: number, out: Streak[]): Streak[] {
  const n = 6;
  out.length = n;
  const period = 1100;
  for (let i = 0; i < n; i++) {
    const t = (((time / period + i / n) % 1) + 1) % 1;
    const side = (((i * 0.618 + 0.13) % 1) - 0.5) * width * 0.85;
    const streak = out[i] ?? { along: 0, across: 0, length: 0, alpha: 0 };
    streak.along = 6 + t * reach * 0.6;
    streak.across = side * (1 + 0.5 * t);
    streak.length = 14 + t * 22;
    streak.alpha = 0.28 * Math.sin(Math.PI * t);
    out[i] = streak;
  }
  return out;
}

/** How far a trampoline's mat is pressed in after a landing, 0..1. */
export function trampolineDip(meta: ToyMeta, time: number): number {
  if (meta.hitAt === undefined) return 0;
  const age = time - meta.hitAt;
  if (age < 0 || age > 380) return 0;
  const t = age / 380;
  // A damped wobble: down, back up past flat, settle.
  return Math.cos(t * Math.PI * 2.5) * (1 - t) * (1 - t);
}

export interface Orbit {
  x: number;
  y: number;
  radius: number;
  alpha: number;
}

/** The specks spiralling into a black hole, relative to its middle. */
export function holeOrbits(time: number, core: number, out: Orbit[]): Orbit[] {
  const n = 7;
  out.length = n;
  const period = 1600;
  for (let i = 0; i < n; i++) {
    const t = (((time / period + i / n) % 1) + 1) % 1;
    const dist = core * (1.15 + 2.3 * (1 - t));
    // Faster as it gets closer, like anything falling into a well.
    const angle = i * 2.4 + t * t * Math.PI * 3 + time * 0.0008;
    const orbit = out[i] ?? { x: 0, y: 0, radius: 0, alpha: 0 };
    orbit.x = Math.cos(angle) * dist;
    orbit.y = Math.sin(angle) * dist;
    orbit.radius = 1.4 + 1.6 * (1 - t);
    orbit.alpha = 0.85 * Math.sin(Math.PI * Math.min(1, t * 1.15));
    out[i] = orbit;
  }
  return out;
}

/** A black hole's core throbs when it swallows something. */
export function holeThrob(meta: ToyMeta, time: number): number {
  if (meta.hitAt === undefined) return 0;
  const age = time - meta.hitAt;
  return age >= 0 && age < 240 ? 1 - age / 240 : 0;
}

/** 0 when an effect starts, 1 when it is over. */
export function effectT(effect: Effect, time: number): number {
  return Math.min(1, Math.max(0, (time - effect.born) / effect.life));
}

/** An effect's rings, as radius and alpha, so both painters draw the same flash. */
export function effectRings(effect: Effect, time: number): { radius: number; alpha: number; flash: number } {
  const t = effectT(effect, time);
  const ease = 1 - (1 - t) * (1 - t);
  switch (effect.kind) {
    case 'blast':
      return { radius: effect.radius * (0.15 + 0.85 * ease), alpha: (1 - t) * 0.9, flash: Math.max(0, 1 - t * 2.2) };
    case 'pop':
      return { radius: effect.radius * (0.6 + 0.8 * ease), alpha: 1 - t, flash: 0 };
    case 'gulp':
      return { radius: effect.radius * (2.2 - 1.9 * ease), alpha: (1 - t) * 0.8, flash: 0 };
  }
}

// --- ropes and chains ------------------------------------------------------

/**
 * How one link of a rope or chain is drawn, in its own frame (x along the
 * link). Each is drawn a little longer than the link, so neighbours overlap at
 * the joint and the rope reads as one line rather than a row of beads.
 *
 * - a rope link is a capsule, alternately a shade lighter and darker: a twist;
 * - a chain alternates a ring seen face on with one seen edge on (a bar).
 */
export interface LinkLook {
  shape: 'capsule' | 'ring' | 'bar';
  halfW: number;
  halfH: number;
  /** null for a ring: it is only its outline */
  fill: string | null;
  edge: string;
  edgeW: number;
}

export function linkLook(meta: ToyMeta): LinkLook {
  const index = meta.link?.index ?? 0;
  const h = meta.h;
  if (meta.link?.style !== 'chain') {
    return {
      shape: 'capsule',
      halfW: meta.w / 2 + h / 2,
      halfH: h / 2,
      fill: index % 2 === 0 ? meta.color : shade(meta.color, -0.12),
      edge: meta.accent,
      edgeW: 0.8,
    };
  }
  if (index % 2 === 0) {
    return { shape: 'ring', halfW: meta.w / 2 + h * 0.35, halfH: h / 2, fill: null, edge: meta.color, edgeW: h * 0.3 };
  }
  return {
    shape: 'bar',
    halfW: meta.w / 2 + h * 0.35,
    halfH: h * 0.22,
    fill: shade(meta.color, -0.1),
    edge: meta.accent,
    edgeW: 0.8,
  };
}

/** The peg a rope is tied to in empty space: its dark middle, world px. */
export const PIN_DOT = 1.8;

/** The dashed line of a rope being tied: dash, then gap, world px. */
export const TETHER_DASH = [7, 5] as const;
