import Matter from 'matter-js';
import { describe, expect, it } from 'vitest';
import { GrainWorld } from './grains';
import { toyById } from '../toys/catalog';
import type { ToyId } from '../toys/types';

function build(id: ToyId, x: number, y: number): Matter.Body {
  const toy = toyById(id);
  if (!toy) throw new Error(`no toy ${id}`);
  const built = toy.build(x, y, { noteIndex: 0 });
  return Array.isArray(built) ? built[0] : built;
}

/** The shape the engine hands to the solver. `Matter.Body` fits it as it is. */
function wrap(body: Matter.Body) {
  return {
    vertices: body.vertices,
    bounds: body.bounds,
    position: body.position,
    isStatic: body.isStatic,
    mass: body.isStatic ? 0 : body.mass,
    velocity: body.velocity,
    surface: { x: 0, y: 0 },
  };
}

describe('pouring into a box with toys in it', () => {
  it('keeps every grain finite and inside the box', () => {
    const source = build('sandSource', 708, 200);
    const crate = build('crate', 300, 500);
    const ramp = build('ramp', 900, 470);
    const view = [wrap(source), wrap(crate), wrap(ramp)];

    const width = 1416;
    const height = 606;
    const w = new GrainWorld(12000, width, height, { radius: 5 });

    for (let step = 0; step < 240; step++) {
      // Three grains a step, the way a source pours.
      for (let i = 0; i < 3; i++) {
        w.add(708 + (Math.random() - 0.5) * 52, 229 + Math.random() * 3, 0, 1.5, 0);
      }
      w.step(view);
    }

    expect(w.count).toBe(720);

    const r = w.options.radius;
    for (let i = 0; i < w.count; i++) {
      expect(Number.isFinite(w.x[i])).toBe(true);
      expect(Number.isFinite(w.y[i])).toBe(true);
      expect(w.x[i]).toBeGreaterThanOrEqual(r - 1);
      expect(w.x[i]).toBeLessThanOrEqual(width - r + 1);
      expect(w.y[i]).toBeGreaterThanOrEqual(r - 1);
      expect(w.y[i]).toBeLessThanOrEqual(height - r + 1);
    }
  });
});
