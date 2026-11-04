import Matter from 'matter-js';
import { metaOf } from '../toys/meta';

/** How far above a belt a body may sit and still be caught by it, in px. */
const CATCH = 12;

/** Fraction of the gap to the belt speed closed each step (0..1). */
const GRAB = 0.22;

/**
 * Conveyor pass, run before every `Engine.update`.
 *
 * Matter has no notion of surface velocity, so a belt is emulated: any toy
 * resting on top of the belt gets its horizontal velocity blended toward the
 * belt speed. Circles also get a matching spin, so balls roll instead of slide.
 */
export function carryBodies(bodies: Matter.Body[]): void {
  for (const belt of bodies) {
    const beltMeta = metaOf(belt);
    if (!beltMeta?.belt) continue;

    const top = belt.bounds.min.y;
    const target = beltMeta.belt.dir * beltMeta.belt.speed;

    for (const body of bodies) {
      if (body === belt || body.isStatic) continue;
      if (!metaOf(body)) continue; // only toys ride the belt
      if (body.velocity.y < -2) continue; // bouncing off, not resting

      const bottom = body.bounds.max.y;
      if (bottom < top - CATCH || bottom > top + CATCH) continue;

      const overlapsX =
        body.bounds.max.x > belt.bounds.min.x && body.bounds.min.x < belt.bounds.max.x;
      if (!overlapsX) continue;

      const vx = body.velocity.x + (target - body.velocity.x) * GRAB;
      Matter.Body.setVelocity(body, { x: vx, y: body.velocity.y });

      if (body.circleRadius) Matter.Body.setAngularVelocity(body, vx / body.circleRadius);
    }
  }
}
