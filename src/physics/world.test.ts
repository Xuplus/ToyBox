import Matter from 'matter-js';
import { describe, expect, it } from 'vitest';
import { toyById } from '../toys/catalog';
import { carryBodies } from './conveyor';
import { createWorld, STEP_MS, resizeWorld } from './world';

function build(id: Parameters<typeof toyById>[0], x: number, y: number): Matter.Body {
  const toy = toyById(id);
  if (!toy) throw new Error(`unknown toy ${id}`);
  const built = toy.build(x, y, { noteIndex: 0 });
  return Array.isArray(built) ? built[0] : built;
}

/** Run the simulation with the same order the engine uses. */
function run(world: ReturnType<typeof createWorld>, bodies: Matter.Body[], steps: number): void {
  for (let i = 0; i < steps; i++) {
    carryBodies(bodies);
    Matter.Engine.update(world.engine, STEP_MS);
  }
}

describe('world', () => {
  it('creates four enclosing walls', () => {
    const world = createWorld(400, 300);
    expect(world.walls).toHaveLength(4);
    for (const wall of world.walls) expect(wall.isStatic).toBe(true);
  });

  it('keeps the walls around a resized box', () => {
    const world = createWorld(400, 300);
    resizeWorld(world, 800, 600);
    const floor = world.walls[0];
    expect(floor.bounds.max.y).toBeGreaterThanOrEqual(600);
    expect(world.width).toBe(800);
  });
});

describe('gravity', () => {
  it('drops a ball and stops it on the floor', () => {
    const world = createWorld(400, 300);
    const ball = build('ballBouncy', 200, 40);
    Matter.Composite.add(world.engine.world, ball);

    run(world, [ball], 400);

    // Resting on the floor, not through it: floor plane is y = 300.
    expect(ball.position.y).toBeLessThan(300);
    expect(ball.position.y).toBeGreaterThan(200);
  });

  it('does not let a heavy ball escape the box', () => {
    const world = createWorld(300, 300);
    const ball = build('ballHeavy', 150, 20);
    Matter.Composite.add(world.engine.world, ball);

    run(world, [ball], 600);

    expect(ball.position.x).toBeGreaterThan(0);
    expect(ball.position.x).toBeLessThan(300);
    expect(ball.position.y).toBeLessThan(300);
  });
});

describe('conveyor', () => {
  it('carries a crate along the belt', () => {
    const world = createWorld(600, 300);
    const belt = build('beltRight', 300, 260);
    const crate = build('crate', 300, 218);
    Matter.Composite.add(world.engine.world, [belt, crate]);

    const startX = crate.position.x;
    run(world, [belt, crate], 120);

    expect(crate.position.x).toBeGreaterThan(startX + 20);
    expect(belt.position.x).toBeCloseTo(300, 3); // the belt itself never moves
  });

  it('carries the other way when the belt faces left', () => {
    const world = createWorld(600, 300);
    const belt = build('beltLeft', 300, 260);
    const crate = build('crate', 300, 218);
    Matter.Composite.add(world.engine.world, [belt, crate]);

    const startX = crate.position.x;
    run(world, [belt, crate], 120);

    expect(crate.position.x).toBeLessThan(startX - 20);
  });

  it('ignores bodies that are not on the belt', () => {
    const world = createWorld(600, 400);
    const belt = build('beltRight', 300, 360);
    const crate = build('crate', 120, 120);
    Matter.Composite.add(world.engine.world, [belt, crate]);

    run(world, [belt, crate], 120);

    // It fell to the floor well away from the belt, so it must stay put.
    expect(Math.abs(crate.position.x - 120)).toBeLessThan(4);
  });
});

describe('ramp', () => {
  it('lets a ball roll down the slope', () => {
    const world = createWorld(500, 400);
    const ramp = build('ramp', 250, 220);
    const ball = build('ballMarble', 220, 150);
    Matter.Composite.add(world.engine.world, [ramp, ball]);

    run(world, [ramp, ball], 240);

    expect(ball.position.x).toBeGreaterThan(280); // travelled down and to the right
    expect(ball.position.y).toBeGreaterThan(330); // and ended up on the floor
  });
});
