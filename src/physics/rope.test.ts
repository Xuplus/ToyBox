import Matter from 'matter-js';
import { describe, expect, it } from 'vitest';
import { makePin, toyById } from '../toys/catalog';
import { tiePoint, tieRope } from '../toys/tie';
import { jointGap, ropeLayout, surfaceAnchor } from './rope';
import { CONSTRAINT_ITERATIONS } from './world';

describe('ropeLayout', () => {
  it('fills the rope with equal links, end to end', () => {
    const layout = ropeLayout(0, 0, 300, 0, 1.06, 12, 70);
    const length = 300 * 1.06;
    expect(layout.links.length).toBe(Math.round(length / 12));
    expect(layout.link * layout.links.length).toBeCloseTo(length, 6);
    // Consecutive links meet: one's far end is the next one's near end.
    for (let i = 0; i + 1 < layout.links.length; i++) {
      const a = layout.links[i];
      const b = layout.links[i + 1];
      const ax = a.x + (Math.cos(a.angle) * layout.link) / 2;
      const ay = a.y + (Math.sin(a.angle) * layout.link) / 2;
      const bx = b.x - (Math.cos(b.angle) * layout.link) / 2;
      const by = b.y - (Math.sin(b.angle) * layout.link) / 2;
      expect(Math.hypot(bx - ax, by - ay)).toBeLessThan(0.6);
    }
  });

  it('sags down the screen whichever way it is tied', () => {
    for (const [ax, bx] of [
      [0, 300],
      [300, 0],
    ]) {
      const layout = ropeLayout(ax, 100, bx, 100, 1.06, 12, 70);
      const middle = layout.links[Math.floor(layout.links.length / 2)];
      expect(middle.y).toBeGreaterThan(130);
    }
  });

  it('gets longer links rather than more of them', () => {
    const layout = ropeLayout(0, 0, 2000, 0, 1, 12, 50);
    expect(layout.links).toHaveLength(50);
    expect(layout.link).toBeCloseTo(40, 6);
    expect(ropeLayout(0, 0, 1, 0, 1, 12, 50).links).toHaveLength(2);
  });
});

describe('surfaceAnchor', () => {
  const crate = Matter.Bodies.rectangle(100, 100, 60, 60);

  it('ties a rope pulled out of a crate to its outline', () => {
    const up = surfaceAnchor(crate.vertices, { x: 100, y: 100 }, { x: 100, y: -50 });
    expect(up.x).toBeCloseTo(100, 6);
    expect(up.y).toBeGreaterThan(70);
    expect(up.y).toBeLessThan(71);
    const side = surfaceAnchor(crate.vertices, { x: 110, y: 90 }, { x: 400, y: 90 });
    expect(side.x).toBeGreaterThan(129);
    expect(side.x).toBeLessThan(130);
  });

  it('leaves a point outside the body alone', () => {
    expect(surfaceAnchor(crate.vertices, { x: 0, y: 0 }, { x: 50, y: 50 })).toEqual({ x: 0, y: 0 });
  });
});

/** A box with a pin and whatever hangs from it, stepped like the engine does. */
function hang(style: 'rope' | 'chain', load: Matter.Body, drop = 200) {
  const engine = Matter.Engine.create();
  engine.constraintIterations = CONSTRAINT_ITERATIONS;
  const spec = toyById(style)!.rope!;
  const pin = makePin(300, 50);
  const { links, joints } = tieRope(
    spec,
    { body: pin, point: { x: 300, y: 50 } },
    { body: load, point: tiePoint(load, load.position, { x: 300, y: 50 }) },
  );
  Matter.Body.setPosition(load, { x: load.position.x, y: 50 + drop });
  Matter.Composite.add(engine.world, [pin, load, ...links, ...joints]);
  const step = (n: number) => {
    for (let i = 0; i < n; i++) Matter.Engine.update(engine, 1000 / 60);
  };
  return { engine, links, joints, step, spec };
}

describe('tieRope', () => {
  it('ties the ends to where they were pressed', () => {
    const crate = Matter.Bodies.rectangle(300, 250, 56, 56);
    const { joints } = hang('rope', crate);
    expect(joints[0].bodyA?.label).toBe('pin');
    expect(joints[joints.length - 1].bodyB).toBe(crate);
    for (const joint of joints) expect(jointGap(joint)).toBeLessThan(1);
  });

  it('lets a crate hang from a pin and stop swinging', () => {
    const crate = Matter.Bodies.rectangle(420, 250, 56, 56, { density: 0.002 });
    const { joints, step, spec } = hang('rope', crate);
    step(900);
    // Hanging under the pin, on a rope that has not snapped or stretched far.
    expect(Math.abs(crate.position.x - 300)).toBeLessThan(25);
    expect(crate.position.y).toBeGreaterThan(200);
    expect(Math.hypot(crate.velocity.x, crate.velocity.y)).toBeLessThan(0.3);
    let widest = 0;
    for (const joint of joints) widest = Math.max(widest, jointGap(joint));
    expect(widest).toBeLessThan(spec.snapAt / 2);
  });

  it('holds a cannonball on a rope without snapping it', () => {
    const ball = Matter.Bodies.circle(450, 50, 26, { density: 0.007 });
    const { joints, step, spec } = hang('rope', ball, 0);
    let widest = 0;
    for (let i = 0; i < 600; i++) {
      step(1);
      for (const joint of joints) widest = Math.max(widest, jointGap(joint));
    }
    expect(widest).toBeLessThan(spec.snapAt);
    // A rope gives a little, but it is not a bungee: ~160 px of it.
    expect(ball.position.y).toBeLessThan(50 + 160 * 1.06 + 26 + 45);
  });

  it('holds a cannonball on a chain', () => {
    const ball = Matter.Bodies.circle(300, 250, 26, { density: 0.007 });
    const { joints, step, spec } = hang('chain', ball);
    let widest = 0;
    for (let i = 0; i < 600; i++) {
      step(1);
      for (const joint of joints) widest = Math.max(widest, jointGap(joint));
    }
    expect(widest).toBeLessThan(spec.snapAt);
    expect(ball.position.y).toBeGreaterThan(230);
    expect(ball.position.y).toBeLessThan(320);
  });
});
