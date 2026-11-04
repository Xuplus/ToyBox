import Matter from 'matter-js';
import { describe, expect, it } from 'vitest';
import {
  GRAIN,
  GRAIN_FORCE,
  GrainWorld,
  dragImpulse,
  supportImpulse,
} from './grains';
import { GRAVITY_SCALE } from './world';

/** A body with a `contacts`/`grip` reading from one step of contact. */
function bed(kind: typeof GRAIN.sand | typeof GRAIN.water, py: number) {
  const world = new GrainWorld(400, 400, 400, { radius: 5 });
  for (let i = 0; i < 14; i++) {
    for (let j = 0; j < 5; j++) world.add(120 + i * 10, py + j * 10, 0, 0, kind);
  }
  return world;
}

describe('GrainWorld - what a body is left with', () => {
  it('gives a body resting on sand an upward support', () => {
    const world = bed(GRAIN.sand, 240);
    const ball = Matter.Bodies.circle(190, 232, 16);
    world.step([ball]);

    // The normals point from the body down to the grains, so the load it can
    // stand on points up: negative y. This is what holds a ball out of a dune.
    expect(world.loadFy[0]).toBeLessThan(-2);
    expect(world.contacts[0]).toBeGreaterThanOrEqual(4);
    expect(world.grip[0]).toBeGreaterThan(0.1); // four contacts x 0.05
  });

  it('gives a body in water contacts but no support', () => {
    const world = bed(GRAIN.water, 240);
    const ball = Matter.Bodies.circle(190, 232, 16);
    world.step([ball]);

    // Water cannot hold anything up, and pretending otherwise would be a
    // levitation. It still grips, which is all the drag it gets.
    expect(world.loadFy[0]).toBe(0);
    expect(world.contacts[0]).toBeGreaterThanOrEqual(4);
    expect(world.grip[0]).toBeGreaterThan(0);
  });

  it('leaves a static body alone', () => {
    const world = bed(GRAIN.sand, 240);
    const shelf = Matter.Bodies.rectangle(190, 235, 160, 20, { isStatic: true });
    world.step([shelf]);

    expect(world.loadFy[0]).toBe(0);
    expect(world.contacts[0]).toBe(0);
    expect(world.grip[0]).toBe(0);
  });
});

describe('supportImpulse', () => {
  const up = (vx: number, vy: number, mass = 1) => supportImpulse(0, -8, 2.7, vx, vy, mass);

  it('stops a body going into the support without throwing it back', () => {
    const out = up(0.7, 4);
    expect(out.vy).toBeLessThan(4); // slowed...
    expect(out.vy).toBeGreaterThanOrEqual(0); // ...but not reversed. A contact
    // that can reverse is a spring, and a spring is a trampoline.
    expect(out.vx).toBeGreaterThanOrEqual(0);
  });

  it('takes the whole gravity step out of a body that is barely moving', () => {
    const out = up(0, 0.27);
    expect(out.vy).toBeGreaterThanOrEqual(0);
    expect(out.vy).toBeLessThan(0.01);
  });

  it('never touches a body that is leaving', () => {
    const out = up(0, -3);
    expect(out.vx).toBe(0);
    expect(out.vy).toBe(-3);
  });

  it('carries the weight, and never more than the weight', () => {
    const flat = up(0, 0.27);
    // Gravity is mass * gravity.scale per step, pointing down; the force here
    // cancels exactly that much.
    expect(flat.fy).toBeCloseTo(-1 * GRAVITY_SCALE, 9);
    expect(flat.fx).toBeCloseTo(0, 9);

    // On a slope the same rule leaves the downhill component of gravity alone:
    const slope = supportImpulse(0.6, -0.8, 2.7, 0, 0.27, 1);
    expect(Math.hypot(slope.fx, slope.fy)).toBeLessThan(GRAVITY_SCALE);
    expect(slope.fx).toBeGreaterThan(0); // pushed out of the slope, downhill
    expect(slope.fy).toBeLessThan(0);
  });

  it('does nothing without support', () => {
    expect(supportImpulse(0, 0, 3, 1, 2, 1)).toEqual({ vx: 1, vy: 2, fx: 0, fy: 0 });
    // Water leaves no load at all, so a body in it gets no hold-up.
    expect(supportImpulse(0, 0, 0.6, 0, 3, 1).vy).toBe(3);
  });
});

describe('dragImpulse', () => {
  it('slows a body through a medium that cannot hold it up', () => {
    const out = dragImpulse(0, -6, 0.6, 0, 4);
    expect(out.vy).toBeLessThan(4);
    expect(out.vy).toBeGreaterThanOrEqual(0);
  });

  it('cannot reverse a body or add speed to one that is leaving', () => {
    expect(dragImpulse(0, -6, 5, 0, 4).vy).toBeGreaterThanOrEqual(0);
    expect(dragImpulse(0, -6, 0.6, 0, -2).vy).toBe(-2);
    expect(dragImpulse(0, 0, 0.6, 1, 2)).toEqual({ vx: 1, vy: 2 });
  });

  it('is weaker than sand', () => {
    const sand = supportImpulse(0, -8, 3.4, 0, 4, 1).vy;
    const water = dragImpulse(0, -8, 0.6, 0, 4).vy;
    expect(sand).toBeLessThan(water);
    expect(GRAIN_FORCE).toBeGreaterThan(0);
  });
});
