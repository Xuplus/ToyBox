import Matter from 'matter-js';
import { describe, expect, it } from 'vitest';
import { GRAIN, GrainWorld, scatterGrains } from './grains';
import { GRAVITY_ACCEL, STEP_MS } from './world';
function world(n: number, width = 300, height = 300, radius = 5): GrainWorld {
  return new GrainWorld(n, width, height, { radius });
}

function run(w: GrainWorld, steps: number): void {
  for (let i = 0; i < steps; i++) w.step();
}

/** A static rectangle, in the shape the solver wants. */
function platform(x: number, y: number, w: number, h: number) {
  const body = Matter.Bodies.rectangle(x, y, w, h, { isStatic: true });
  return body;
}

/** Bounding box of the heap. */
function footprint(w: GrainWorld) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < w.count; i++) {
    minX = Math.min(minX, w.x[i]);
    maxX = Math.max(maxX, w.x[i]);
    minY = Math.min(minY, w.y[i]);
    maxY = Math.max(maxY, w.y[i]);
  }
  return { minX, maxX, minY, maxY };
}

describe('GrainWorld', () => {
  it('drops a grain onto the floor and stops it there', () => {
    const w = world(4);
    w.add(150, 20);

    run(w, 240);

    expect(w.y[0]).toBeGreaterThan(280); // resting near the bottom
    expect(w.y[0]).toBeLessThanOrEqual(300 - w.options.radius);
  });

  it('keeps every grain inside the box', () => {
    const w = world(400, 200, 200, 4);
    scatterGrains(w, 400);
    run(w, 120);

    const r = w.options.radius;
    for (let g = 0; g < w.count; g++) {
      expect(w.x[g]).toBeGreaterThanOrEqual(r - 1);
      expect(w.x[g]).toBeLessThanOrEqual(200 - r + 1);
      expect(w.y[g]).toBeGreaterThanOrEqual(r - 1);
      expect(w.y[g]).toBeLessThanOrEqual(200 - r + 1);
    }
  });

  it('pushes two overlapping grains apart', () => {
    const w = world(2, 200, 200, 10);
    w.add(100, 100);
    w.add(104, 100); // 4 px apart, radii sum to 20

    w.step();

    const gap = Math.hypot(w.x[1] - w.x[0], w.y[1] - w.y[0]);
    expect(gap).toBeGreaterThan(4);
  });

  it('settles a heap instead of leaving it jittering', () => {
    const w = world(600, 400, 300, 4);
    expect(scatterGrains(w, 600)).toBe(600);

    run(w, 1200);

    // A heap is settled when its footprint stops changing. Testing velocities
    // would be wrong: a supported grain legitimately carries the ~1 px/step of
    // gravity it was just given, and free grains are still rolling.
    const before = footprint(w);
    run(w, 120);
    const after = footprint(w);

    expect(Math.abs(after.minX - before.minX)).toBeLessThan(3);
    expect(Math.abs(after.maxY - before.maxY)).toBeLessThan(3);
    expect(after.maxY - after.minY).toBeLessThan(before.maxY - before.minY + 3);
  });

  it('never produces a NaN, even when crowded', () => {
    const w = world(2000, 200, 200, 6);
    for (let i = 0; i < 2000; i++) w.add(30 + (i % 40) * 3, 30 + ((i / 40) | 0) * 3);

    run(w, 60);

    for (let i = 0; i < w.count; i++) {
      expect(Number.isFinite(w.x[i])).toBe(true);
      expect(Number.isFinite(w.y[i])).toBe(true);
      expect(Number.isFinite(w.vx[i])).toBe(true);
      expect(Number.isFinite(w.vy[i])).toBe(true);
    }
  });

  it('refuses to hold more than its capacity', () => {
    const w = world(2);
    expect(w.add(10, 10)).toBe(true);
    expect(w.add(10, 10)).toBe(true);
    expect(w.add(10, 10)).toBe(false);
    expect(w.count).toBe(2);
  });

  it('ignores an explicitly undefined option instead of adopting it', () => {
    // `ensureGrains(radius?)` in the engine forwards an optional radius; passing
    // `{ radius: undefined }` used to wipe the default and make every grain NaN.
    const w = new GrainWorld(4, 200, 200, { radius: undefined });
    expect(w.options.radius).toBe(5);
    expect(w.options.gravity).toBeCloseTo(GRAVITY_ACCEL, 6);

    w.add(100, 100);
    w.step();
    expect(Number.isFinite(w.x[0])).toBe(true);
    expect(Number.isFinite(w.y[0])).toBe(true);
  });

  it('scatters deterministically for a given seed', () => {
    const a = world(50, 400, 300, 4);
    const b = world(50, 400, 300, 4);
    scatterGrains(a, 50, 7);
    scatterGrains(b, 50, 7);

    expect(a.count).toBe(b.count);
    for (let i = 0; i < a.count; i++) expect(a.x[i]).toBe(b.x[i]);
  });
});

describe('GrainWorld - the same gravity as everything else', () => {
  it('uses the acceleration Matter derives from its gravity scale', () => {
    expect(GRAVITY_ACCEL).toBeCloseTo(0.278, 3);
    expect(new GrainWorld(1, 100, 100).options.gravity).toBeCloseTo(GRAVITY_ACCEL, 6);
  });

  it('falls at the same rate as a Matter body', () => {
    const engine = Matter.Engine.create();
    const ball = Matter.Bodies.circle(100, 40, 10, { frictionAir: 0.001 });
    Matter.Composite.add(engine.world, ball);

    const w = world(2, 400, 400, 5);
    w.add(100, 40);

    const ballStart = ball.position.y;
    const grainStart = w.y[0];

    for (let i = 0; i < 30; i++) {
      Matter.Engine.update(engine, STEP_MS);
      w.step();
    }

    const ballDrop = ball.position.y - ballStart;
    const grainDrop = w.y[0] - grainStart;

    expect(ballDrop).toBeGreaterThan(100);
    expect(Math.abs(grainDrop - ballDrop) / ballDrop).toBeLessThan(0.05);
  });
});

describe('GrainWorld - rigid bodies', () => {
  it('rests on a platform instead of falling through it', () => {
    const w = world(3, 200, 300, 5);
    for (let i = 0; i < 3; i++) w.add(95 + i, 40);

    const shelf = platform(100, 150, 200, 20);
    for (let i = 0; i < 200; i++) w.step([shelf]);

    for (let i = 0; i < w.count; i++) {
      expect(w.y[i]).toBeLessThan(136); // the shelf's top face is at 140
      expect(w.y[i]).toBeGreaterThan(130); // ...and it is resting on it
    }
  });

  it('leaves its weight on a dynamic body, pointing into it', () => {
    const w = world(30, 200, 300, 5);
    const crate = Matter.Bodies.rectangle(100, 200, 160, 20);
    // Dropped from just above the crate, evenly across it.
    for (let i = 0; i < 10; i++) w.add(55 + i * 10, 170);
    for (let i = 0; i < 200; i++) w.step([crate]);

    // A settled pile has gone to sleep, so it is not touching anything. Wake it
    // and let one step put it back in contact to read the load it carries.
    w.wakeAll();
    w.step([crate]);

    expect(w.loadFy[0]).toBeGreaterThan(5); // the pile weighs on the crate
    expect(Math.abs(w.loadFx[0])).toBeLessThan(20); // straight down
    expect(Math.abs(w.loadTorque[0])).toBeLessThan(100); // and roughly centred
  });

  it('tips a body that is carrying an unbalanced pile', () => {
    const w = world(30, 200, 300, 5);
    const crate = Matter.Bodies.rectangle(100, 200, 160, 20);
    // All of it on the left half of the crate.
    for (let i = 0; i < 5; i++) w.add(30 + i * 15, 170);
    for (let i = 0; i < 200; i++) w.step([crate]);

    w.wakeAll();
    w.step([crate]);

    expect(w.loadFy[0]).toBeGreaterThan(2);
    expect(w.loadTorque[0]).toBeLessThan(-10);
  });

  it('a static body takes no load at all', () => {
    const w = world(10, 200, 300, 5);
    for (let i = 0; i < 10; i++) w.add(90 + i * 2, 100);

    const shelf = platform(100, 200, 120, 20);
    for (let i = 0; i < 120; i++) w.step([shelf]);

    expect(w.loadFx[0]).toBe(0);
    expect(w.loadFy[0]).toBe(0);
  });

  it('carries a grain along on a belt surface', () => {
    const w = world(2, 400, 200, 5);
    w.add(100, 150);

    const belt = platform(200, 176, 300, 12);
    const conveyor = {
      vertices: belt.vertices,
      bounds: belt.bounds,
      position: belt.position,
      isStatic: true,
      mass: 0,
      velocity: belt.velocity,
      surface: { x: 4.2, y: 0 },
    };

    for (let i = 0; i < 40; i++) w.step([conveyor]);

    expect(w.vx[0]).toBeGreaterThan(3);
    expect(w.x[0]).toBeGreaterThan(150);
  });

  it('never lets a grain end up inside a body', () => {
    const w = world(400, 300, 300, 4);
    scatterGrains(w, 400);

    const block = Matter.Bodies.rectangle(150, 220, 200, 60);
    for (let i = 0; i < 300; i++) w.step([block]);

    // A grain resting on a face is at most one radius from it; anything deeper
    // than that is inside the block, which is the bug this guards against.
    for (let i = 0; i < w.count; i++) {
      const inside =
        w.x[i] > block.bounds.min.x + 4 &&
        w.x[i] < block.bounds.max.x - 4 &&
        w.y[i] > block.bounds.min.y + 4 &&
        w.y[i] < block.bounds.max.y - 4;
      expect(inside).toBe(false);
    }
  });
});

describe('GrainWorld - sleep', () => {
  it('puts a settled heap to sleep, and a landing grain wakes it', () => {
    // Room for one more grain than the pile: the point of the test is what a
    // new arrival does to a heap that has gone to sleep.
    const w = world(400, 240, 240, 4);
    scatterGrains(w, 240);
    run(w, 600);

    // The pile is static; only a thin skin of grains on its surface keeps
    // rolling. What matters is that the cost of the heap is that skin, not the
    // heap: the rest of it is skipped entirely.
    expect(w.awake).toBeLessThan(w.count * 0.15);

    // One grain dropped into a settled pile has to wake its neighbours, or the
    // pile would behave like a solid block. It needs long enough to arrive.
    expect(w.add(120, 20)).toBe(true);
    run(w, 45);
    expect(w.awake).toBeGreaterThan(1);
  });

  it('wakes a settled heap without the heap moving', () => {
    const w = world(400, 240, 240, 4);
    scatterGrains(w, 240);
    run(w, 600);

    let asleep = 0;
    for (let i = 0; i < w.count; i++) asleep += w.asleep[i];
    expect(asleep).toBe(w.count);

    const x0 = Float32Array.from(w.x.subarray(0, w.count));
    const y0 = Float32Array.from(w.y.subarray(0, w.count));

    // Waking it must be a no-op. A pile that was frozen mid-collapse, or one
    // full of overlaps that the sleeping neighbours never got to resolve, pops
    // the moment it is disturbed - which is exactly what this guards.
    w.wakeAll();
    run(w, 10);

    let sum = 0;
    let max = 0;
    for (let i = 0; i < w.count; i++) {
      const d = Math.hypot(w.x[i] - x0[i], w.y[i] - y0[i]);
      sum += d;
      max = Math.max(max, d);
    }

    expect(sum / w.count).toBeLessThan(1.5);
    expect(max).toBeLessThan(6);
  });

  it('absorbs a fast hit instead of shattering the pile', () => {
    const w = world(400, 240, 240, 4);
    scatterGrains(w, 240);
    run(w, 600);

    const x0 = Float32Array.from(w.x.subarray(0, w.count));
    const y0 = Float32Array.from(w.y.subarray(0, w.count));
    const before = w.count;

    // A ball, near enough: one grain arriving at 12 px/step.
    w.add(120, 40, 0, 12);
    run(w, 60);

    let sum = 0;
    let max = 0;
    for (let i = 0; i < before; i++) {
      const d = Math.hypot(w.x[i] - x0[i], w.y[i] - y0[i]);
      sum += d;
      max = Math.max(max, d);
    }

    // The hit has to go *somewhere* - a crater that shallow is a few px - but
    // the pile must not burst apart, which is what waking a heap that was
    // frozen mid-collapse looks like.
    expect(sum / before).toBeLessThan(6);
    expect(max).toBeLessThan(40);
  });
});

describe('GrainWorld - materials', () => {
  it('pulls water together across the contact gap, and leaves sand alone', () => {
    const water = new GrainWorld(2, 400, 200, { radius: 5, gravity: 0 });
    water.add(100, 100, 0, 0, GRAIN.water);
    water.add(112, 100, 0, 0, GRAIN.water);

    const sand = new GrainWorld(2, 400, 200, { radius: 5, gravity: 0 });
    sand.add(100, 100, 0, 0, GRAIN.sand);
    sand.add(112, 100, 0, 0, GRAIN.sand);

    for (let i = 0; i < 40; i++) {
      water.step();
      sand.step();
    }

    const waterGap = Math.abs(water.x[1] - water.x[0]);
    const sandGap = Math.abs(sand.x[1] - sand.x[0]);

    expect(waterGap).toBeLessThan(11);
    expect(sandGap).toBeCloseTo(12, 0);
  });

  it('counts what is in the box per material', () => {
    const w = world(10, 200, 200, 5);
    w.add(50, 50, 0, 0, GRAIN.water);
    w.add(60, 50, 0, 0, GRAIN.water);
    w.add(70, 50, 0, 0, GRAIN.sand);

    expect(w.countOf(GRAIN.water)).toBe(2);
    expect(w.countOf(GRAIN.sand)).toBe(1);
  });
});

describe('GrainWorld - housekeeping', () => {
  it('erases grains inside a circle and keeps the rest', () => {
    const w = world(9, 200, 200, 5);
    for (let i = 0; i < 9; i++) w.add(40 + i * 8, 100);

    expect(w.removeIn(72, 100, 10)).toBe(3); // 64, 72 and 80
    expect(w.count).toBe(6);

    for (let i = 0; i < w.count; i++) {
      expect(Math.hypot(w.x[i] - 72, w.y[i] - 100)).toBeGreaterThan(10);
    }
  });

  it('pulls grains back inside when the box shrinks', () => {
    const w = world(4, 400, 400, 5);
    w.add(380, 380);
    w.resize(200, 200);

    expect(w.x[0]).toBeLessThanOrEqual(195);
    expect(w.y[0]).toBeLessThanOrEqual(195);

    run(w, 20);
    expect(w.y[0]).toBeLessThanOrEqual(195);
  });
});
