import Matter from 'matter-js';

/** Fixed simulation step. Matter is tuned for 60 Hz; anything else changes feel. */
export const STEP_MS = 1000 / 60;

/**
 * Matter's default `gravity.scale`: the gravitational *force* per unit of mass.
 * `Engine._bodiesApplyGravity` adds `mass * gravity.y * scale` to every body.
 */
export const GRAVITY_SCALE = 0.001;

/**
 * The same gravity expressed as an acceleration, in px per step squared. Matter
 * integrates a force as `force / mass * STEP_MS^2`, so one step of gravity adds
 * `GRAVITY_SCALE * STEP_MS^2` to the velocity - which is the number the granular
 * layer has to use to fall at the same rate as everything else in the box.
 */
export const GRAVITY_ACCEL = GRAVITY_SCALE * STEP_MS * STEP_MS;

/** Wall thickness. Walls sit OUTSIDE the visible area, so the canvas edge is
 *  exactly the inside of the box - nothing can leave and nothing is drawn over. */
const WALL = 80;

/** Constraint passes per step - see `createWorld`. */
export const CONSTRAINT_ITERATIONS = 10;

export interface World {
  engine: Matter.Engine;
  width: number;
  height: number;
  walls: Matter.Body[];
}

export function createWorld(width: number, height: number): World {
  const engine = Matter.Engine.create();
  engine.gravity.x = 0;
  engine.gravity.y = 1;
  // Ropes: a row of light links holding a heavy load is the case Matter's
  // constraint solver converges worst on, and at its default of 2 a cannonball
  // on a rope stretched it like a bungee (120 px over 15 links). 10 brings that
  // to ~30 with links light enough for a balloon to lift some of the rope, for
  // ~0.05 ms a step. The drag constraint is tuned per pass - see the engine.
  engine.constraintIterations = CONSTRAINT_ITERATIONS;

  const world: World = { engine, width, height, walls: [] };
  buildWalls(world);
  return world;
}

/** Rebuild the four walls for the current box size. */
function buildWalls(world: World): void {
  const { engine, width: w, height: h, walls } = world;

  for (const wall of walls) Matter.Composite.remove(engine.world, wall);
  walls.length = 0;

  const options: Matter.IChamferableBodyDefinition = {
    isStatic: true,
    friction: 0.5,
    frictionStatic: 0.6,
    restitution: 0.08,
    label: 'wall',
  };

  // Floor, ceiling and both sides are half a thickness outside the box.
  const floor = Matter.Bodies.rectangle(w / 2, h + WALL / 2, w + WALL * 2, WALL, options);
  const ceiling = Matter.Bodies.rectangle(w / 2, -WALL / 2, w + WALL * 2, WALL, options);
  const left = Matter.Bodies.rectangle(-WALL / 2, h / 2, WALL, h + WALL * 2, options);
  const right = Matter.Bodies.rectangle(w + WALL / 2, h / 2, WALL, h + WALL * 2, options);

  walls.push(floor, ceiling, left, right);
  Matter.Composite.add(engine.world, walls);
}

function clamp(value: number, low: number, high: number): number {
  if (low > high) return (low + high) / 2; // body is bigger than the box
  return Math.min(Math.max(value, low), high);
}

/** Keep a body fully inside the box (used on spawn and after a resize). */
export function clampIntoBounds(body: Matter.Body, width: number, height: number): void {
  const halfW = (body.bounds.max.x - body.bounds.min.x) / 2;
  const halfH = (body.bounds.max.y - body.bounds.min.y) / 2;

  const x = clamp(body.position.x, halfW + 1, width - halfW - 1);
  const y = clamp(body.position.y, halfH + 1, height - halfH - 1);

  if (x !== body.position.x || y !== body.position.y) Matter.Body.setPosition(body, { x, y });
}

/** Resize the box: move the walls, then rescue anything now outside them. */
export function resizeWorld(world: World, width: number, height: number): void {
  world.width = width;
  world.height = height;
  buildWalls(world);

  for (const body of Matter.Composite.allBodies(world.engine.world)) {
    if (body.isStatic) continue;
    clampIntoBounds(body, width, height);
  }
}

export function removeBody(world: World, body: Matter.Body): void {
  Matter.Composite.remove(world.engine.world, body);
}
