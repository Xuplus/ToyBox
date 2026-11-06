import { describe, expect, it } from 'vitest';
import {
  apex,
  blastSpeed,
  direction,
  falloff,
  holePull,
  launchVelocity,
  liftSpeed,
  windAt,
  windDelta,
  windSpeed,
} from './fields';
import { GRAIN, GrainWorld } from './grains';
import { GRAVITY_ACCEL } from './world';

describe('blast', () => {
  it('is strongest in the middle and nothing at the edge', () => {
    expect(falloff(0, 100)).toBe(1);
    expect(falloff(50, 100)).toBeCloseTo(0.5);
    expect(falloff(100, 100)).toBe(0);
    expect(falloff(150, 100)).toBe(0);
  });

  it('throws a light body further than a heavy one, but moves both', () => {
    const beach = blastSpeed(40, 170, 20, 1.8);
    const cannon = blastSpeed(40, 170, 20, 15);
    const bouncy = blastSpeed(40, 170, 20, 0.74);
    expect(bouncy).toBeGreaterThan(beach);
    expect(beach).toBeGreaterThan(cannon);
    expect(cannon).toBeGreaterThan(2);
    // Capped: a crumb is not fired at an absurd speed.
    expect(blastSpeed(0, 170, 20, 0.001)).toBeLessThanOrEqual(20 * 1.8);
  });

  it('points from the bomb to the body, and up when they coincide', () => {
    expect(direction(0, 0, 3, 4)).toEqual({ x: 0.6, y: 0.8 });
    expect(direction(5, 5, 5, 5)).toEqual({ x: 0, y: -1 });
  });
});

describe('wind', () => {
  it('blows only in front of the fan, fading with distance', () => {
    expect(windAt(-1, 0, 400, 40)).toBe(0);
    expect(windAt(0, 0, 400, 40)).toBe(1);
    expect(windAt(200, 0, 400, 40)).toBeCloseTo(0.5);
    expect(windAt(400, 0, 400, 40)).toBe(0);
  });

  it('has a soft side edge, and a column that widens', () => {
    expect(windAt(10, 39, 400, 40)).toBeGreaterThan(0);
    expect(windAt(10, 39, 400, 40)).toBeLessThan(windAt(10, 0, 400, 40));
    expect(windAt(10, 45, 400, 40)).toBe(0);
    expect(windAt(300, 45, 400, 40)).toBeGreaterThan(0);
  });

  it('holds a beach ball up and leaves a cannonball on the floor', () => {
    // Areas and masses from the catalog: r=34 at density 0.0005, r=26 at 0.007.
    const beachArea = Math.PI * 34 * 34;
    const cannonArea = Math.PI * 26 * 26;
    expect(windSpeed(1, beachArea, beachArea * 0.0005)).toBeGreaterThan(GRAVITY_ACCEL);
    expect(windSpeed(1, cannonArea, cannonArea * 0.007)).toBeLessThan(GRAVITY_ACCEL * 0.5);
  });
});

describe('wind on a moving body', () => {
  const area = Math.PI * 34 * 34;
  const mass = area * 0.0005;

  it('pushes a still body, less once it is moving, and not at all at the speed of the air', () => {
    const still = windDelta(1, 1, area, mass, 0);
    expect(still).toBeCloseTo(windSpeed(1, area, mass));
    expect(windDelta(1, 1, area, mass, 10.9)).toBeLessThan(still);
    expect(windDelta(1, 1, area, mass, 11)).toBe(0);
    expect(windDelta(1, 1, area, mass, 30)).toBe(0);
  });

  it('a body coasting through a faded gust is not pushed back', () => {
    expect(windDelta(0.1, 1, area, mass, 5)).toBe(0);
  });
});

describe('black hole', () => {
  it('pulls inward, harder the closer you are, and nothing beyond its reach', () => {
    const near = holePull(50, 0, 300, 1, 0);
    const far = holePull(250, 0, 300, 1, 0);
    expect(near.x).toBeLessThan(far.x);
    expect(far.x).toBeLessThan(0);
    expect(near.y).toBeCloseTo(0);
    expect(holePull(300, 0, 300, 1, 0)).toEqual({ x: 0, y: 0 });
  });

  it('swirls things round as well as in', () => {
    const v = holePull(100, 0, 300, 1, 0.5);
    expect(v.x).toBeLessThan(0);
    expect(Math.abs(v.y)).toBeGreaterThan(0);
  });
});

describe('trampoline', () => {
  const up = { x: 0, y: -1 };

  it('throws a dropped body back up at least at the launch speed', () => {
    const v = launchVelocity(up, { x: 2, y: 3 }, 14, 26);
    expect(v.y).toBeCloseTo(-14);
    expect(v.x).toBeCloseTo(2);
  });

  it('returns a fast landing a little harder, up to the cap', () => {
    expect(launchVelocity(up, { x: 0, y: 20 }, 14, 26).y).toBeCloseTo(-21);
    expect(launchVelocity(up, { x: 0, y: 40 }, 14, 26).y).toBeCloseTo(-26);
  });

  it('leaves alone a body that is already leaving fast', () => {
    expect(launchVelocity(up, { x: 1, y: -20 }, 14, 26)).toEqual({ x: 1, y: -20 });
  });

  it('launches high enough to be worth it', () => {
    expect(apex(14)).toBeGreaterThan(300);
  });
});

describe('balloon', () => {
  it('rises when its lift beats gravity', () => {
    expect(liftSpeed(1.5)).toBeGreaterThan(GRAVITY_ACCEL);
  });
});

describe('grain fields', () => {
  function pile(): GrainWorld {
    const world = new GrainWorld(4000, 600, 400, { radius: 5 });
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 50; col++) world.add(60 + col * 10 + (row % 2) * 5, 395 - row * 9, 0, 0, GRAIN.sand);
    }
    for (let i = 0; i < 1500; i++) world.step();
    return world;
  }

  it('a blast throws the grains near it out and leaves the far ones asleep', () => {
    const world = pile();
    expect(world.awake).toBe(0);
    const pushed = world.push(300, 395, 80, 12);
    expect(pushed).toBeGreaterThan(20);

    let flungLeft = 0;
    let flungRight = 0;
    let farAwake = 0;
    for (let i = 0; i < world.count; i++) {
      if (world.x[i] < 260 && world.vx[i] < -2) flungLeft++;
      if (world.x[i] > 340 && world.vx[i] > 2) flungRight++;
      if (Math.abs(world.x[i] - 300) > 120 && world.asleep[i] === 0) farAwake++;
    }
    expect(flungLeft).toBeGreaterThan(3);
    expect(flungRight).toBeGreaterThan(3);
    expect(farAwake).toBe(0);
  });

  it('a faint pull at the edge of the range does not wake a sleeping pile', () => {
    const world = pile();
    expect(world.push(300, 395, 400, -0.05)).toBe(0);
    let awake = 0;
    for (let i = 0; i < world.count; i++) if (world.asleep[i] === 0) awake++;
    expect(awake).toBe(0);
  });

  it('wind lifts grains out of a pile in front of the fan only', () => {
    const world = pile();
    // A fan on the floor at x=150, blowing up.
    world.blow(150, 400, 0, -1, 300, 30, 1);
    for (let i = 0; i < 60; i++) {
      world.blow(150, 400, 0, -1, 300, 30, 1);
      world.step();
    }
    let lifted = 0;
    let liftedElsewhere = 0;
    for (let i = 0; i < world.count; i++) {
      if (world.y[i] > 300) continue;
      // The column widens and a fountain spreads, so "elsewhere" is well
      // clear of it rather than just outside its edge.
      if (Math.abs(world.x[i] - 150) < 80) lifted++;
      else if (Math.abs(world.x[i] - 150) > 150) liftedElsewhere++;
    }
    expect(lifted).toBeGreaterThan(10);
    expect(liftedElsewhere).toBe(0);
  });

  it('a black hole draws grains towards it', () => {
    const world = new GrainWorld(100, 600, 400, { radius: 5, gravity: 0 });
    world.add(200, 200, 0, 0, GRAIN.water);
    world.add(400, 200, 0, 0, GRAIN.water);
    for (let i = 0; i < 20; i++) {
      world.push(300, 200, 200, -0.4, 0.2);
      world.step();
    }
    expect(world.x[0]).toBeGreaterThan(210);
    expect(world.x[1]).toBeLessThan(390);
  });
});
