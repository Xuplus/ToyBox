// Ropes and chains: a row of short links joined end to end by Matter
// constraints, tied at each end to a body. This file is the part that does not
// need a box: where the links go when a rope is tied, where on a body a rope
// ties on, and how to join the links. The engine owns the bodies once they are
// built, the catalog says what a link of each style is.
//
// A rope is a chain of rigid links rather than one soft body because Matter has
// no soft bodies - but it has cheap, stable distance constraints, and a body for
// each link is what lets a rope drape over a peg, be hit by a ball, be blown by
// a fan or be cut with the delete tool.

import Matter from 'matter-js';

export interface LinkPlace {
  x: number;
  y: number;
  angle: number;
}

export interface RopeLayout {
  /** length of every link, world px */
  link: number;
  /** centre and angle of each link, from end A to end B */
  links: LinkPlace[];
}

/**
 * Where the links of a new rope go between `a` and `b`.
 *
 * The rope is `slack` times longer than the gap, so it is laid out sagging -
 * on a parabola whose arc is that long - rather than as a straight line it
 * would immediately have to fall out of. The links are all the same length:
 * `link` is a target, and the count is rounded so they fill the rope exactly.
 * `maxLinks` caps the count, so a very long rope gets longer links instead of a
 * hundred bodies.
 */
export function ropeLayout(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  slack: number,
  link: number,
  maxLinks: number,
): RopeLayout {
  const gap = Math.hypot(bx - ax, by - ay);
  const length = gap * Math.max(1, slack);
  const count = Math.max(2, Math.min(maxLinks, Math.round(length / link)));
  const size = length / count;

  // A parabola with sag d over a chord D is ~ D (1 + 8/3 (d/D)^2) long.
  const sag = gap * Math.sqrt((3 * Math.max(0, slack - 1)) / 8);
  const ux = gap > 0 ? (bx - ax) / gap : 1;
  const uy = gap > 0 ? (by - ay) / gap : 0;
  // Sag is down the screen, whichever way the chord points: the normal to it
  // that has a positive y. A vertical rope has no down to sag towards.
  let nx = -uy;
  let ny = ux;
  if (ny < 0) {
    nx = -nx;
    ny = -ny;
  }

  // Points along the arc at equal arc length, by walking a fine polyline.
  const fine = count * 8;
  const px: number[] = [];
  const py: number[] = [];
  const along: number[] = [0];
  for (let i = 0; i <= fine; i++) {
    const t = i / fine;
    const dip = sag * 4 * t * (1 - t);
    px.push(ax + (bx - ax) * t + nx * dip);
    py.push(ay + (by - ay) * t + ny * dip);
    if (i > 0) along.push(along[i - 1] + Math.hypot(px[i] - px[i - 1], py[i] - py[i - 1]));
  }
  const total = along[fine] || 1;
  const at = (s: number): [number, number] => {
    const target = s * total;
    let k = 1;
    while (k < fine && along[k] < target) k++;
    const span = along[k] - along[k - 1] || 1;
    const f = (target - along[k - 1]) / span;
    return [px[k - 1] + (px[k] - px[k - 1]) * f, py[k - 1] + (py[k] - py[k - 1]) * f];
  };

  const links: LinkPlace[] = [];
  let [x0, y0] = at(0);
  for (let i = 1; i <= count; i++) {
    const [x1, y1] = at(i / count);
    links.push({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, angle: Math.atan2(y1 - y0, x1 - x0) });
    x0 = x1;
    y0 = y1;
  }
  return { link: size, links };
}

/**
 * Where a rope pulled from `inside` towards `toward` leaves a convex body: the
 * point on its outline along that ray. A rope is tied to the outside of a
 * crate, not to the middle of it - a tie in the middle would lay the first few
 * links through the crate, and they would spend every step being pushed out.
 * If `inside` is not inside, or the ray never leaves, it is returned as it is.
 */
export function surfaceAnchor(
  vertices: readonly { x: number; y: number }[],
  inside: { x: number; y: number },
  toward: { x: number; y: number },
): { x: number; y: number } {
  const dx = toward.x - inside.x;
  const dy = toward.y - inside.y;
  if (dx === 0 && dy === 0) return { x: inside.x, y: inside.y };

  // Ray against each edge: the nearest exit in front of the start.
  let best = Infinity;
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-12) continue;
    const t = ((a.x - inside.x) * ey - (a.y - inside.y) * ex) / denom;
    const u = ((a.x - inside.x) * dy - (a.y - inside.y) * dx) / denom;
    if (t > 0 && u >= 0 && u <= 1 && t < best) best = t;
  }
  if (!Number.isFinite(best) || !Matter.Vertices.contains(vertices as Matter.Vector[], inside)) {
    return { x: inside.x, y: inside.y };
  }
  // A whisker inside the outline, so the tie stays on the body as it turns.
  const t = Math.max(0, best - 0.5 / Math.hypot(dx, dy));
  return { x: inside.x + dx * t, y: inside.y + dy * t };
}

/** How the links of one rope are joined. */
export interface JointSpec {
  /** 0..1, how hard a joint pulls its ends together each iteration */
  stiffness: number;
  damping: number;
}

/** A body-frame offset turned into the world-frame offset Matter's `pointA/B`
 *  wants: Matter rotates it from there as the body turns. */
function offset(body: Matter.Body, along: number): Matter.Vector {
  return { x: Math.cos(body.angle) * along, y: Math.sin(body.angle) * along };
}

/**
 * Join `links` end to end, and tie the first to `a` and the last to `b` at the
 * given world points. Each link's ends are `half` px from its centre along its
 * own x axis. Returns the constraints; nothing is added to a world here.
 */
export function joinLinks(
  links: Matter.Body[],
  half: number,
  a: { body: Matter.Body; point: Matter.Vector },
  b: { body: Matter.Body; point: Matter.Vector },
  spec: JointSpec,
): Matter.Constraint[] {
  const joints: Matter.Constraint[] = [];
  const options = { stiffness: spec.stiffness, damping: spec.damping, length: 0 };
  const first = links[0];
  const last = links[links.length - 1];

  joints.push(
    Matter.Constraint.create({
      ...options,
      bodyA: a.body,
      pointA: Matter.Vector.sub(a.point, a.body.position),
      bodyB: first,
      pointB: offset(first, -half),
    }),
  );
  for (let i = 0; i + 1 < links.length; i++) {
    joints.push(
      Matter.Constraint.create({
        ...options,
        bodyA: links[i],
        pointA: offset(links[i], half),
        bodyB: links[i + 1],
        pointB: offset(links[i + 1], -half),
      }),
    );
  }
  joints.push(
    Matter.Constraint.create({
      ...options,
      bodyA: last,
      pointA: offset(last, half),
      bodyB: b.body,
      pointB: Matter.Vector.sub(b.point, b.body.position),
    }),
  );
  return joints;
}

/** How far apart the two ends of a joint are, world px: 0 when it holds. */
export function jointGap(joint: Matter.Constraint): number {
  const a = joint.bodyA;
  const b = joint.bodyB;
  const ax = (a?.position.x ?? 0) + joint.pointA.x;
  const ay = (a?.position.y ?? 0) + joint.pointA.y;
  const bx = (b?.position.x ?? 0) + joint.pointB.x;
  const by = (b?.position.y ?? 0) + joint.pointB.y;
  return Math.hypot(bx - ax, by - ay);
}
