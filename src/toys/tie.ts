import Matter from 'matter-js';
import { joinLinks, ropeLayout, surfaceAnchor } from '../physics/rope';
import { makeLink } from './catalog';
import { metaOf } from './meta';
import type { RopeSpec } from './types';

/** One end of a rope: the body it is tied to and the world point it is tied at. */
export interface Tie {
  body: Matter.Body;
  point: Matter.Vector;
}

/**
 * Where on `body` a rope pressed at `press` and pulled towards `toward` ties
 * on. A pin or another rope's link is tied at its middle - it is too small to
 * have an outside worth finding - anything else on its outline.
 */
export function tiePoint(body: Matter.Body, press: Matter.Vector, toward: Matter.Vector): Matter.Vector {
  const kind = metaOf(body)?.kind;
  if (kind === 'pin' || kind === 'link') return { x: body.position.x, y: body.position.y };
  return surfaceAnchor(body.vertices, press, toward);
}

/**
 * Build a rope of `spec` from `a` to `b`: its links, laid out sagging, and the
 * joints that hold them together and to both ends. Nothing is added to a world.
 */
export function tieRope(
  spec: RopeSpec,
  a: Tie,
  b: Tie,
): { links: Matter.Body[]; joints: Matter.Constraint[] } {
  const layout = ropeLayout(a.point.x, a.point.y, b.point.x, b.point.y, spec.slack, spec.link, spec.maxLinks);
  const group = Matter.Body.nextGroup(true);
  const last = layout.links.length - 1;
  const links = layout.links.map((place, i) =>
    makeLink(spec, place.x, place.y, place.angle, layout.link, i, group, i === 0 || i === last),
  );
  const joints = joinLinks(links, layout.link / 2, a, b, spec);
  return { links, joints };
}
