import Matter from 'matter-js';
import { describe, expect, it } from 'vitest';
import { GRAIN_DRAG, GRAIN_FORCE, GrainWorld } from './grains';

/** A block of grains on the floor with a body resting on top of them. */
function bed(): { world: GrainWorld; body: Matter.Body } {
  const world = new GrainWorld(200, 400, 400, { radius: 5 });
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 6; j++) world.add(150 + i * 10, 240 + j * 10);
  }
  return { world, body: Matter.Bodies.rectangle(200, 220, 120, 40) };
}

describe('a body in the granular layer', () => {
  it('is held up by the pile it rests on', () => {
    const { world, body } = bed();
    world.step([body]);

    // One unit of normal force per contact, pointing into the body: the grains
    // are below it, so the load on the body is upward (negative y).
    expect(world.loadFy[0]).toBeLessThan(-5);
    expect(world.loadFx[0]).toBeCloseTo(0, 1);
  });

  it('gives up momentum to the grains it pushes', () => {
    const { world, body } = bed();
    Matter.Body.setVelocity(body, { x: 0, y: 3 });
    world.step([body]);

    // The grains were standing still and the body pushed them down to its own
    // velocity, so the body owes the pile the difference. This is what makes
    // sand resist instead of behaving like empty space.
    expect(world.dragY[0]).toBeLessThan(-5);
    expect(Math.abs(world.dragX[0])).toBeLessThan(1);
  });

  it('owes nothing to a static body', () => {
    const world = new GrainWorld(200, 400, 400, { radius: 5 });
    for (let i = 0; i < 10; i++) world.add(150 + i * 10, 340);
    const shelf = Matter.Bodies.rectangle(200, 340, 200, 20, { isStatic: true });

    world.step([shelf]);

    expect(world.loadFy[0]).toBe(0);
    expect(world.dragY[0]).toBe(0);
    expect(GRAIN_DRAG).toBeGreaterThan(GRAIN_FORCE);
  });
});
