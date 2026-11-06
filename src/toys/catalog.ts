import Matter from 'matter-js';
import { noteForIndex, noteName } from '../audio/notes';
import { shade } from '../lib/color';
import { GRAIN, MATERIALS, type GrainMaterial } from '../physics/grains';
import { setMeta } from './meta';
import type { RopeSpec, SpawnContext, ToyDef, ToyId } from './types';

// The toy registry. Each entry knows how to build its Matter body; everything
// else (rendering, carrying, breaking) is driven by the metadata attached here.

interface BallCfg {
  id: ToyId;
  nameKey: string;
  color: string;
  r: number;
  restitution: number;
  density: number;
}

function makeBall(c: BallCfg): ToyDef {
  return {
    id: c.id,
    kind: 'ball',
    nameKey: c.nameKey,
    color: c.color,
    accent: shade(c.color, 0.4),
    swatch: 'circle',
    w: c.r * 2,
    h: c.r * 2,
    build(x, y) {
      const body = Matter.Bodies.circle(x, y, c.r, {
        label: c.id,
        friction: 0.05,
        frictionStatic: 0.15,
        frictionAir: 0.004,
        restitution: c.restitution,
        density: c.density,
      });
      return setMeta(body, {
        toyId: c.id,
        kind: 'ball',
        color: c.color,
        accent: shade(c.color, 0.4),
        w: c.r * 2,
        h: c.r * 2,
      });
    },
  };
}

interface BlockCfg {
  id: ToyId;
  nameKey: string;
  color: string;
  w: number;
  h: number;
  density: number;
  restitution?: number;
  friction?: number;
  breaksAt?: number;
}

function makeBlock(c: BlockCfg): ToyDef {
  const accent = shade(c.color, 0.35);
  return {
    id: c.id,
    kind: 'block',
    nameKey: c.nameKey,
    color: c.color,
    accent,
    swatch: 'rect',
    w: c.w,
    h: c.h,
    build(x, y) {
      const body = Matter.Bodies.rectangle(x, y, c.w, c.h, {
        label: c.id,
        friction: c.friction ?? 0.5,
        frictionStatic: 0.7,
        frictionAir: 0.008,
        restitution: c.restitution ?? 0.05,
        density: c.density,
      });
      return setMeta(body, {
        toyId: c.id,
        kind: 'block',
        color: c.color,
        accent,
        w: c.w,
        h: c.h,
        breaksAt: c.breaksAt,
      });
    },
  };
}

const BELT_W = 200;
const BELT_H = 22;
const BELT_SPEED = 4.2;
const BELT_COLOR = '#55617a';

function makeBelt(id: ToyId, dir: 1 | -1, nameKey: string): ToyDef {
  return {
    id,
    kind: 'belt',
    nameKey,
    color: BELT_COLOR,
    accent: shade(BELT_COLOR, 0.45),
    swatch: 'belt',
    w: BELT_W,
    h: BELT_H,
    build(x, y) {
      const body = Matter.Bodies.rectangle(x, y, BELT_W, BELT_H, {
        label: id,
        isStatic: true,
        friction: 0.8,
        frictionStatic: 0.9,
        restitution: 0,
      });
      return setMeta(body, {
        toyId: id,
        kind: 'belt',
        color: BELT_COLOR,
        accent: shade(BELT_COLOR, 0.45),
        w: BELT_W,
        h: BELT_H,
        belt: { dir, speed: BELT_SPEED },
      });
    },
  };
}

const RAMP_W = 150;
const RAMP_H = 72;

/**
 * A static wedge - the one non-rectangular block. Static so it stays where it is
 * put and works as a ramp immediately (belts and note blocks are static too).
 */
function makeRamp(): ToyDef {
  const color = '#c9a06a';
  const accent = shade(color, 0.35);

  return {
    id: 'ramp',
    kind: 'block',
    nameKey: 'toy_ramp',
    color,
    accent,
    swatch: 'rect',
    w: RAMP_W,
    h: RAMP_H,
    build(x, y) {
      const body = Matter.Bodies.fromVertices(
        x,
        y,
        [
          [
            { x: -RAMP_W / 2, y: RAMP_H / 2 },
            { x: RAMP_W / 2, y: RAMP_H / 2 },
            { x: -RAMP_W / 2, y: -RAMP_H / 2 },
          ],
        ],
        {
          label: 'ramp',
          isStatic: true,
          friction: 0.55,
          frictionStatic: 0.7,
          restitution: 0.05,
        },
      );

      return setMeta(body, {
        toyId: 'ramp',
        kind: 'block',
        color,
        accent,
        w: RAMP_W,
        h: RAMP_H,
        shape: 'poly',
      });
    },
  };
}

const SPAWNER_W = 78;
const SPAWNER_H = 40;
const SPAWNER_RATE = 320;
const SPAWNER_COLOR = '#55657f';
const SPAWNER_ACCENT = '#7fe0d0';

/**
 * A spout that keeps dropping bouncy balls. Static, so it stays where it is put
 * (usually up near the ceiling); the engine owns the emission clock and the
 * ball cap keeps a forgotten spawner from filling the box forever.
 */
function makeSpawner(): ToyDef {
  return {
    id: 'ballSpawner',
    kind: 'spawner',
    nameKey: 'toy_ballSpawner',
    color: SPAWNER_COLOR,
    accent: SPAWNER_ACCENT,
    swatch: 'spawner',
    w: SPAWNER_W,
    h: SPAWNER_H,
    build(x, y) {
      const body = Matter.Bodies.rectangle(x, y, SPAWNER_W, SPAWNER_H, {
        label: 'ballSpawner',
        isStatic: true,
        friction: 0.4,
        frictionStatic: 0.6,
        restitution: 0.1,
      });

      return setMeta(body, {
        toyId: 'ballSpawner',
        kind: 'spawner',
        color: SPAWNER_COLOR,
        accent: SPAWNER_ACCENT,
        w: SPAWNER_W,
        h: SPAWNER_H,
        spawner: { rateMs: SPAWNER_RATE, toy: 'ballBouncy', speed: 1.5, spread: 1.2, acc: 0 },
      });
    },
  };
}

const SOURCE_W = 84;
const SOURCE_H = 46;

/**
 * A hopper that pours a granular material. Static like the ball spout, and for
 * the same reason: it should stay where it is put, usually up near the ceiling.
 *
 * The palette colour *is* the material colour - that is what tells sand from
 * water at a glance - so the housing is drawn in a fixed dark slate by the
 * painters and only the mouth and the falling stream take the accent.
 */
function makeSource(
  id: ToyId,
  material: GrainMaterial,
  nameKey: string,
  perSecond: number,
): ToyDef {
  const color = MATERIALS[material].color;

  return {
    id,
    kind: 'source',
    nameKey,
    color,
    accent: shade(color, 0.4),
    swatch: 'spawner',
    w: SOURCE_W,
    h: SOURCE_H,
    build(x, y) {
      const body = Matter.Bodies.rectangle(x, y, SOURCE_W, SOURCE_H, {
        label: id,
        isStatic: true,
        friction: 0.4,
        frictionStatic: 0.6,
        restitution: 0.1,
      });

      return setMeta(body, {
        toyId: id,
        kind: 'source',
        color,
        accent: shade(color, 0.4),
        w: SOURCE_W,
        h: SOURCE_H,
        source: { material, perSecond, speed: 1.5, spread: 26, acc: 0, poured: 0 },
      });
    },
  };
}

const NOTE_W = 84;
export const NOTE_H = 28;
/** One colour per scale degree, so the bars read as a little xylophone. */
const NOTE_COLORS = [
  '#5b8cff',
  '#59b0ff',
  '#4bc4c4',
  '#4fbf7a',
  '#93c94a',
  '#e0bf45',
  '#f0913f',
  '#e8675f',
  '#d95fa6',
  '#a06cf0',
];

const noteBlock: ToyDef = {
  id: 'noteBlock',
  kind: 'note',
  nameKey: 'toy_noteBlock',
  color: NOTE_COLORS[0],
  accent: shade(NOTE_COLORS[0], 0.4),
  swatch: 'note',
  w: NOTE_W,
  h: NOTE_H,
  build(x, y, ctx: SpawnContext) {
    const midi = noteForIndex(ctx.noteIndex);
    const color = NOTE_COLORS[ctx.noteIndex % NOTE_COLORS.length];

    const body = Matter.Bodies.rectangle(x, y, NOTE_W, NOTE_H, {
      label: 'noteBlock',
      isStatic: true,
      friction: 0.4,
      frictionStatic: 0.5,
      restitution: 0.2,
    });

    return setMeta(body, {
      toyId: 'noteBlock',
      kind: 'note',
      color,
      accent: shade(color, 0.4),
      w: NOTE_W,
      h: NOTE_H,
      label: noteName(midi),
      midi,
      breaksAt: undefined,
    });
  },
};

// --- gadgets -------------------------------------------------------------
//
// The five toys below do something on their own rather than just sit there.
// What they do lives in the engine (`ToyBoxEngine`, the gadget section) and in
// the pure maths of `physics/fields.ts`; here they only get a body and the
// numbers that tune them.

export const BOMB_R = 16;
/** How long a bomb's fuse burns, simulated ms. */
export const FUSE_MS = 2600;

/**
 * A round black bomb with a lit fuse. It goes off when the fuse runs out, when
 * it is hit hard, or when another bomb goes off next to it.
 */
const bomb: ToyDef = {
  id: 'bomb',
  kind: 'bomb',
  nameKey: 'toy_bomb',
  color: '#2c303b',
  accent: '#ff8a3d',
  swatch: 'circle',
  w: BOMB_R * 2,
  h: BOMB_R * 2,
  build(x, y) {
    const body = Matter.Bodies.circle(x, y, BOMB_R, {
      label: 'bomb',
      friction: 0.3,
      frictionStatic: 0.5,
      frictionAir: 0.006,
      restitution: 0.3,
      density: 0.004,
    });
    return setMeta(body, {
      toyId: 'bomb',
      kind: 'bomb',
      color: '#2c303b',
      accent: '#ff8a3d',
      w: BOMB_R * 2,
      h: BOMB_R * 2,
      fuse: { left: FUSE_MS, total: FUSE_MS },
    });
  },
};

export const BALLOON_R = 22;
/** One colour per balloon, cycling, so a bunch reads as a bunch. */
const BALLOON_COLORS = ['#ff4d6d', '#ffb703', '#4cc9f0', '#80ed99', '#c77dff', '#ff8fab'];

/**
 * Lighter than air: it floats up, bumps along the ceiling, can be blown about
 * by a fan, and pops when something hits it hard. It never spins, so its knot
 * and string always hang underneath.
 */
const balloon: ToyDef = {
  id: 'balloon',
  kind: 'balloon',
  nameKey: 'toy_balloon',
  color: BALLOON_COLORS[0],
  accent: shade(BALLOON_COLORS[0], 0.4),
  swatch: 'circle',
  w: BALLOON_R * 2,
  h: BALLOON_R * 2,
  build(x, y, ctx: SpawnContext) {
    const color = BALLOON_COLORS[ctx.noteIndex % BALLOON_COLORS.length];
    const body = Matter.Bodies.circle(x, y, BALLOON_R, {
      label: 'balloon',
      friction: 0.1,
      frictionStatic: 0.2,
      frictionAir: 0.035,
      restitution: 0.55,
      density: 0.00035,
    });
    Matter.Body.setInertia(body, Infinity);
    return setMeta(body, {
      toyId: 'balloon',
      kind: 'balloon',
      color,
      accent: shade(color, 0.4),
      w: BALLOON_R * 2,
      h: BALLOON_R * 2,
      lift: 1.6,
      popsAt: 6,
    });
  },
};

const FAN_W = 76;
const FAN_H = 34;

/**
 * A fan that blows along its own "up". Tap it to turn it a quarter. Light
 * things fly, heavy things slide, and sand and water get blown about.
 */
const fan: ToyDef = {
  id: 'fan',
  kind: 'fan',
  nameKey: 'toy_fan',
  color: '#4a5568',
  accent: '#9be7ff',
  swatch: 'spawner',
  w: FAN_W,
  h: FAN_H,
  build(x, y) {
    const body = Matter.Bodies.rectangle(x, y, FAN_W, FAN_H, {
      label: 'fan',
      isStatic: true,
      friction: 0.4,
      frictionStatic: 0.6,
      restitution: 0.1,
    });
    return setMeta(body, {
      toyId: 'fan',
      kind: 'fan',
      color: '#4a5568',
      accent: '#9be7ff',
      w: FAN_W,
      h: FAN_H,
      fan: { strength: 1, reach: 420 },
      turn: Math.PI / 2,
    });
  },
};

const TRAMPOLINE_W = 130;
const TRAMPOLINE_H = 16;

/**
 * A springy pad: whatever lands on its top face is thrown back out, harder
 * than it came in. Tap it to tilt it, and it throws things sideways.
 */
const trampoline: ToyDef = {
  id: 'trampoline',
  kind: 'trampoline',
  nameKey: 'toy_trampoline',
  color: '#ff5d73',
  accent: '#2f3646',
  swatch: 'belt',
  w: TRAMPOLINE_W,
  h: TRAMPOLINE_H,
  build(x, y) {
    const body = Matter.Bodies.rectangle(x, y, TRAMPOLINE_W, TRAMPOLINE_H, {
      label: 'trampoline',
      isStatic: true,
      friction: 0.6,
      frictionStatic: 0.8,
      restitution: 0,
    });
    return setMeta(body, {
      toyId: 'trampoline',
      kind: 'trampoline',
      color: '#ff5d73',
      accent: '#2f3646',
      w: TRAMPOLINE_W,
      h: TRAMPOLINE_H,
      bounce: { launch: 14, max: 24 },
      turn: Math.PI / 4,
    });
  },
};

export const HOLE_R = 24;

/**
 * A black hole. It stays where it is put, pulls in everything that moves -
 * toys, sand, water - swirling it round, and swallows whatever reaches the
 * middle. It is a sensor: nothing collides with it, things fall *in*.
 */
const blackHole: ToyDef = {
  id: 'blackHole',
  kind: 'hole',
  nameKey: 'toy_blackHole',
  color: '#1a0f2e',
  accent: '#b07cff',
  swatch: 'circle',
  w: HOLE_R * 2,
  h: HOLE_R * 2,
  build(x, y) {
    const body = Matter.Bodies.circle(x, y, HOLE_R, {
      label: 'blackHole',
      isStatic: true,
      isSensor: true,
    });
    return setMeta(body, {
      toyId: 'blackHole',
      kind: 'hole',
      color: '#1a0f2e',
      accent: '#b07cff',
      w: HOLE_R * 2,
      h: HOLE_R * 2,
      hole: { reach: 320, pull: 1.2, swirl: 0.5, core: HOLE_R - 2, ate: 0 },
    });
  },
};

// --- ropes and chains -------------------------------------------------------
//
// Tied between two points rather than dropped: press on a toy (or on empty
// space, which puts a pin there) and let go on another. The links are bodies,
// joined end to end in `physics/rope.ts`; here is only what each style is made
// of and how one link is built.

const ROPE: RopeSpec = {
  style: 'rope',
  link: 12,
  thick: 4,
  density: 0.0008,
  frictionAir: 0.02,
  slack: 1.06,
  stiffness: 0.9,
  damping: 0.05,
  snapAt: 14,
  maxLinks: 70,
};

const CHAIN: RopeSpec = {
  style: 'chain',
  link: 15,
  thick: 7,
  density: 0.006,
  frictionAir: 0.01,
  slack: 1.03,
  stiffness: 0.95,
  damping: 0.05,
  snapAt: 40,
  maxLinks: 60,
};

const ROPE_COLOR = '#c8a46b';
const CHAIN_COLOR = '#9aa3b2';

/**
 * One link of a rope or a chain, centred at (x, y) along `angle`. `group` is the
 * rope's own (negative) collision group, so its links never fight each other
 * where they overlap at the joints. An end link (`free`) collides with nothing:
 * it lies on whatever it is tied to.
 */
export function makeLink(
  spec: RopeSpec,
  x: number,
  y: number,
  angle: number,
  length: number,
  index: number,
  group: number,
  free = false,
): Matter.Body {
  const body = Matter.Bodies.rectangle(x, y, length, spec.thick, {
    label: spec.style,
    angle,
    density: spec.density,
    friction: 0.6,
    frictionStatic: 0.8,
    frictionAir: spec.frictionAir,
    restitution: 0.02,
    collisionFilter: { group, category: 0x0001, mask: free ? 0 : 0xffffffff },
  });
  const color = spec.style === 'rope' ? ROPE_COLOR : CHAIN_COLOR;
  return setMeta(body, {
    toyId: spec.style,
    kind: 'link',
    color,
    accent: shade(color, -0.35),
    w: length,
    h: spec.thick,
    link: { style: spec.style, index },
  });
}

function makeRope(id: 'rope' | 'chain', spec: RopeSpec, nameKey: string): ToyDef {
  const color = spec.style === 'rope' ? ROPE_COLOR : CHAIN_COLOR;
  return {
    id,
    kind: 'link',
    nameKey,
    color,
    accent: shade(color, -0.35),
    swatch: 'belt',
    w: spec.link,
    h: spec.thick,
    rope: spec,
    // Dropped on its own, a rope is one loose link.
    build: (x, y) => makeLink(spec, x, y, 0, spec.link, 0, Matter.Body.nextGroup(true)),
  };
}

export const PIN_R = 5;

/**
 * The peg a rope is tied to when one of its ends is in empty space. Static, so
 * it hangs where it was put; it can be dragged and deleted like any toy, and a
 * rope can be draped over it.
 */
export function makePin(x: number, y: number): Matter.Body {
  const body = Matter.Bodies.circle(x, y, PIN_R, {
    label: 'pin',
    isStatic: true,
    friction: 0.5,
    frictionStatic: 0.7,
    restitution: 0.1,
  });
  return setMeta(body, {
    toyId: 'pin',
    kind: 'pin',
    color: '#d7dde8',
    accent: '#5b6578',
    w: PIN_R * 2,
    h: PIN_R * 2,
  });
}

export const TOYS: ToyDef[] = [
  makeBall({ id: 'ballBouncy', nameKey: 'toy_ballBouncy', color: '#ff6b8b', r: 14, restitution: 0.9, density: 0.0012 }),
  makeBall({ id: 'ballMarble', nameKey: 'toy_ballMarble', color: '#66d9ff', r: 9, restitution: 0.65, density: 0.004 }),
  makeBall({ id: 'ballHeavy', nameKey: 'toy_ballHeavy', color: '#ffa94d', r: 26, restitution: 0.25, density: 0.007 }),
  makeBall({ id: 'ballBeach', nameKey: 'toy_ballBeach', color: '#a78bfa', r: 34, restitution: 0.75, density: 0.0005 }),

  makeBlock({ id: 'crate', nameKey: 'toy_crate', color: '#c98b5a', w: 56, h: 56, density: 0.002 }),
  makeBlock({ id: 'plank', nameKey: 'toy_plank', color: '#b9805a', w: 176, h: 18, density: 0.0018 }),
  makeRamp(),
  makeBlock({ id: 'glass', nameKey: 'toy_glass', color: '#9fe3ff', w: 58, h: 76, density: 0.0016, friction: 0.3, breaksAt: 7 }),
  makeBlock({ id: 'brick', nameKey: 'toy_brick', color: '#d9705f', w: 86, h: 38, density: 0.0025, breaksAt: 11 }),

  makeBelt('beltRight', 1, 'toy_beltRight'),
  makeBelt('beltLeft', -1, 'toy_beltLeft'),

  makeSpawner(),

  makeSource('sandSource', GRAIN.sand, 'toy_sandSource', 200),
  makeSource('waterSource', GRAIN.water, 'toy_waterSource', 150),

  noteBlock,

  bomb,
  balloon,
  fan,
  trampoline,
  blackHole,

  makeRope('rope', ROPE, 'toy_rope'),
  makeRope('chain', CHAIN, 'toy_chain'),
];

const BY_ID = new Map<string, ToyDef>(TOYS.map((toy) => [toy.id, toy]));

export function toyById(id: string): ToyDef | undefined {
  return BY_ID.get(id);
}

/** Palette layout: one row of groups, in this order. */
export const PALETTE_GROUPS: { titleKey: string; ids: ToyId[] }[] = [
  { titleKey: 'group_balls', ids: ['ballBouncy', 'ballMarble', 'ballHeavy', 'ballBeach'] },
  { titleKey: 'group_blocks', ids: ['crate', 'plank', 'ramp', 'glass', 'brick'] },
  { titleKey: 'group_fluids', ids: ['sandSource', 'waterSource'] },
  { titleKey: 'group_belts', ids: ['beltRight', 'beltLeft'] },
  { titleKey: 'group_spawners', ids: ['ballSpawner'] },
  { titleKey: 'group_music', ids: ['noteBlock'] },
  { titleKey: 'group_gadgets', ids: ['bomb', 'balloon', 'fan', 'trampoline', 'blackHole'] },
  { titleKey: 'group_ropes', ids: ['rope', 'chain'] },
];
