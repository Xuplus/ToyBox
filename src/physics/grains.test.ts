import { describe, expect, it } from 'vitest';
import { GrainWorld, scatterGrains } from './grains';

function world(n: number, width = 300, height = 300, radius = 5): GrainWorld {
  return new GrainWorld(n, width, height, { radius });
}

function run(w: GrainWorld, steps: number): void {
  for (let i = 0; i < steps; i++) w.step();
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

  it('scatters deterministically for a given seed', () => {
    const a = world(50, 400, 300, 4);
    const b = world(50, 400, 300, 4);
    scatterGrains(a, 50, 7);
    scatterGrains(b, 50, 7);

    expect(a.count).toBe(b.count);
    for (let i = 0; i < a.count; i++) expect(a.x[i]).toBe(b.x[i]);
  });
});
