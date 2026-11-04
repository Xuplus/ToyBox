import Matter from 'matter-js';
import { noteForIndex, noteName } from '../audio/notes';
import { shade } from '../lib/color';
import { setMeta } from './meta';
import type { SpawnContext, ToyDef, ToyId } from './types';

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
 * A static wedge — the one non-rectangular block. Static so it stays where it is
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

  noteBlock,
];

const BY_ID = new Map<string, ToyDef>(TOYS.map((toy) => [toy.id, toy]));

export function toyById(id: string): ToyDef | undefined {
  return BY_ID.get(id);
}

/** Palette layout: one row of groups, in this order. */
export const PALETTE_GROUPS: { titleKey: string; ids: ToyId[] }[] = [
  { titleKey: 'group_balls', ids: ['ballBouncy', 'ballMarble', 'ballHeavy', 'ballBeach'] },
  { titleKey: 'group_blocks', ids: ['crate', 'plank', 'ramp', 'glass', 'brick'] },
  { titleKey: 'group_belts', ids: ['beltRight', 'beltLeft'] },
  { titleKey: 'group_spawners', ids: ['ballSpawner'] },
  { titleKey: 'group_music', ids: ['noteBlock'] },
];
