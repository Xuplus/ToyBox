// Scene to instance buffers.
//
// This is the whole of the old `render.ts` body, turned inside out: instead of
// issuing canvas calls, it writes numbers into flat arrays. It is pure - the
// only things it touches are the scene, the toy metadata and the buffer
// objects - so the packing (which pattern a crate gets, how many instances a
// belt emits, where a note's label lands) is unit-testable without a GPU.

import type Matter from 'matter-js';
import { shadeRgb, toRgb, type RGB } from '../../lib/color';
import { GRAIN, MATERIALS, type GrainWorld } from '../../physics/grains';
import { metaOf } from '../../toys/meta';
import type { ToyMeta } from '../../toys/types';
import {
  balloonString,
  bombDanger,
  effectRings,
  fanSpin,
  fanStreaks,
  fuseLeft,
  fusePoints,
  GADGET,
  holeOrbits,
  holeThrob,
  sparkRadius,
  trampolineDip,
  type Orbit,
  type Streak,
} from '../gadgets';
import type { Effect, Ghost, Scene } from '../scene';
import {
  CIRCLE_STYLE,
  DOT,
  DOT_STRIDE,
  Instances,
  PATTERN,
  RECT,
  RECT_STRIDE,
  SPRITE,
  SPRITE_STRIDE,
} from './instances';
import type { LabelLookup } from './labels';

const K = 1 / 255;

/** Outlines every ball gets: `shade(color, -0.55)`. */
const BALL_BORDER = -0.55;

/** Fill of every grain, per material, ready to write into an instance. */
const GRAIN_FILL = MATERIALS.map((material) => {
  const [r, g, b] = toRgb(material.color);
  return [r * K, g * K, b * K, material.alpha];
});

/** How strong the shared rim is on each material; 0 merges water into a mass. */
const GRAIN_RIM = MATERIALS.map((material) => material.border);

/** 1 for a material drawn as a liquid: soft edge, flat fill, no specular. */
const GRAIN_LIQUID = MATERIALS.map((material) => (material.liquid ? 1 : 0));

/**
 * Outline + halo colour every grain shares, as a constant vertex attribute. The
 * per-instance float scales it: sand keeps the rim, water switches it off.
 */
export const GRAIN_BORDER: RGB = shadeRgb(toRgb(MATERIALS[GRAIN.sand].color), BALL_BORDER);

/** One reusable set of buffers - reset, refilled and uploaded every frame. */
export class SceneBuffers {
  readonly dots = new Instances(DOT_STRIDE, 4096);
  readonly circles = new Instances(DOT_STRIDE);
  readonly styles = new Instances(CIRCLE_STYLE.dash + 1);
  readonly rects = new Instances(RECT_STRIDE);
  readonly sprites = new Instances(SPRITE_STRIDE);
  readonly polys = new Instances(6);
  readonly ghostCircle = new Instances(DOT_STRIDE, 1);
  readonly ghostStyle = new Instances(CIRCLE_STYLE.dash + 1, 1);
  readonly ghostRect = new Instances(RECT_STRIDE, 1);

  reset(): void {
    this.dots.reset();
    this.circles.reset();
    this.styles.reset();
    this.rects.reset();
    this.sprites.reset();
    this.polys.reset();
    this.ghostCircle.reset();
    this.ghostStyle.reset();
    this.ghostRect.reset();
  }
}

/**
 * Fill one frame's buffers. `labels` may be null when the atlas could not be
 * built - the note bodies still draw, they just arrive without their name.
 */
export function packScene(
  out: SceneBuffers,
  scene: Scene,
  labels: LabelLookup | null,
): void {
  out.reset();

  if (scene.grains) packGrains(out.dots, scene.grains);

  const { bodies, time, draggingId } = scene;
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i];
    const meta = metaOf(body);
    if (!meta) continue;

    const glow = body.id === draggingId ? 1 : 0;

    switch (meta.kind) {
      case 'ball':
        packBall(out, body, meta, glow);
        break;
      case 'belt':
        packBelt(out, body, meta, time, glow);
        break;
      case 'note':
        packNote(out, body, meta, time, labels, glow);
        break;
      case 'spawner':
        packSpawner(out, body, meta, time, glow);
        break;
      case 'source':
        packSource(out, body, meta, time, glow);
        break;
      case 'bomb':
        packBomb(out, body, meta, time, glow);
        break;
      case 'balloon':
        packBalloon(out, body, meta, time, glow);
        break;
      case 'fan':
        packFan(out, body, meta, time, glow);
        break;
      case 'trampoline':
        packTrampoline(out, body, meta, time, glow);
        break;
      case 'hole':
        packHole(out, body, meta, time, glow);
        break;
      default:
        packBlock(out, body, meta, glow);
        break;
    }
  }

  for (const effect of scene.effects) packEffect(out, effect, time);
  if (scene.ghost) packGhost(out, scene.ghost);
}

// --- grains --------------------------------------------------------------

/**
 * The granular layer: position, radius, material. The outline colour is a
 * constant vertex attribute, so a grain costs eight floats instead of thirteen
 * - which at twenty thousand grains is most of a millisecond of upload.
 */
function packGrains(dots: Instances, grains: GrainWorld): void {
  const count = grains.count;
  if (count === 0) return;

  dots.reserve(count);
  const d = dots.data;
  const radius = grains.options.radius;
  const kind = grains.kind;
  const x = grains.x;
  const y = grains.y;

  let at = dots.count * DOT_STRIDE;
  for (let i = 0; i < count; i++) {
    const fill = GRAIN_FILL[kind[i]];
    d[at + DOT.x] = x[i];
    d[at + DOT.y] = y[i];
    d[at + DOT.radius] = radius;
    d[at + DOT.color] = fill[0];
    d[at + DOT.color + 1] = fill[1];
    d[at + DOT.color + 2] = fill[2];
    d[at + DOT.color + 3] = fill[3];
    d[at + DOT.border] = GRAIN_RIM[kind[i]];
    d[at + DOT.liquid] = GRAIN_LIQUID[kind[i]];
    at += DOT_STRIDE;
  }
  dots.count += count;
}

// --- circles -------------------------------------------------------------

function pushCircle(
  out: SceneBuffers,
  x: number,
  y: number,
  radius: number,
  color: RGB,
  fillAlpha: number,
  border: RGB | null,
  borderAlpha: number,
  glow = 0,
  dash = 0,
  rim = 1,
  liquid = 0,
): void {
  const at = out.circles.slot();
  const d = out.circles.data;
  d[at + DOT.x] = x;
  d[at + DOT.y] = y;
  d[at + DOT.radius] = radius;
  d[at + DOT.color] = color[0] * K;
  d[at + DOT.color + 1] = color[1] * K;
  d[at + DOT.color + 2] = color[2] * K;
  d[at + DOT.color + 3] = fillAlpha;
  d[at + DOT.border] = rim;
  d[at + DOT.liquid] = liquid;

  const st = out.styles.slot();
  const s = out.styles.data;
  s[st + CIRCLE_STYLE.glow] = glow;
  s[st + CIRCLE_STYLE.border] = border ? border[0] * K : 0;
  s[st + CIRCLE_STYLE.border + 1] = border ? border[1] * K : 0;
  s[st + CIRCLE_STYLE.border + 2] = border ? border[2] * K : 0;
  s[st + CIRCLE_STYLE.border + 3] = border ? borderAlpha : 0;
  s[st + CIRCLE_STYLE.dash] = dash;
}

function packBall(out: SceneBuffers, body: Matter.Body, meta: ToyMeta, glow: number): void {
  const color = toRgb(meta.color);
  const radius = body.circleRadius ?? meta.w / 2;
  pushCircle(
    out,
    body.position.x,
    body.position.y,
    radius,
    color,
    1,
    shadeRgb(color, BALL_BORDER),
    1,
    glow,
  );
}

// --- rounded rects -------------------------------------------------------

interface RectSpec {
  x: number;
  y: number;
  halfW: number;
  halfH: number;
  radius: number;
  angle: number;
  color: RGB;
  /** fill alpha */
  alpha: number;
  shadeTop: number;
  shadeBottom: number;
  border: RGB | null;
  borderAlpha: number;
  borderW: number;
  pattern: number;
  paramX: number;
  paramY: number;
  glow: number;
  patternRgb: RGB;
}

const BLACK: RGB = [0, 0, 0];
const WHITE: RGB = [255, 255, 255];

function pushRect(target: Instances, spec: RectSpec): void {
  const at = target.slot();
  const d = target.data;
  d[at + RECT.x] = spec.x;
  d[at + RECT.y] = spec.y;
  d[at + RECT.halfW] = spec.halfW;
  d[at + RECT.halfH] = spec.halfH;
  d[at + RECT.radius] = spec.radius;
  d[at + RECT.angle] = spec.angle;
  d[at + RECT.color] = spec.color[0] * K;
  d[at + RECT.color + 1] = spec.color[1] * K;
  d[at + RECT.color + 2] = spec.color[2] * K;
  d[at + RECT.color + 3] = spec.alpha;
  d[at + RECT.shadeTop] = spec.shadeTop;
  d[at + RECT.shadeBottom] = spec.shadeBottom;
  d[at + RECT.border] = spec.border ? spec.border[0] * K : 0;
  d[at + RECT.border + 1] = spec.border ? spec.border[1] * K : 0;
  d[at + RECT.border + 2] = spec.border ? spec.border[2] * K : 0;
  d[at + RECT.border + 3] = spec.border ? spec.borderAlpha : 0;
  d[at + RECT.borderW] = spec.borderW;
  d[at + RECT.pattern] = spec.pattern;
  d[at + RECT.paramX] = spec.paramX;
  d[at + RECT.paramY] = spec.paramY;
  d[at + RECT.glow] = spec.glow;
  d[at + RECT.patternRgb] = spec.patternRgb[0] * K;
  d[at + RECT.patternRgb + 1] = spec.patternRgb[1] * K;
  d[at + RECT.patternRgb + 2] = spec.patternRgb[2] * K;
}

/** Every field spelled out, so a caller can never inherit a stale value. */
function rect(overrides: Partial<RectSpec> & Pick<RectSpec, 'x' | 'y' | 'halfW' | 'halfH' | 'color'>): RectSpec {
  return {
    radius: 0,
    angle: 0,
    alpha: 1,
    shadeTop: 0,
    shadeBottom: 0,
    border: null,
    borderAlpha: 1,
    borderW: 0,
    pattern: PATTERN.none,
    paramX: 0,
    paramY: 0,
    glow: 0,
    patternRgb: WHITE,
    ...overrides,
  };
}

/** A rect in a body's own frame: local offset rotated by its angle. */
function placeRect(
  out: SceneBuffers,
  body: Matter.Body,
  localX: number,
  localY: number,
  spec: RectSpec,
): void {
  const s = Math.sin(body.angle);
  const c = Math.cos(body.angle);
  spec.x = body.position.x + localX * c - localY * s;
  spec.y = body.position.y + localX * s + localY * c;
  spec.angle = body.angle;
  pushRect(out.rects, spec);
}

function packBlock(out: SceneBuffers, body: Matter.Body, meta: ToyMeta, glow: number): void {
  if (meta.shape === 'poly') {
    packPoly(out.polys, body, meta);
    return;
  }

  const { w, h } = meta;
  const color = toRgb(meta.color);
  const radius = Math.min(9, Math.min(w, h) * 0.2);

  // Shards are many and short-lived: a flat fill keeps a big break cheap.
  if (meta.shard) {
    placeRect(
      out,
      body,
      0,
      0,
      rect({
        x: 0,
        y: 0,
        halfW: w / 2,
        halfH: h / 2,
        radius: Math.min(3, radius),
        color: shadeRgb(color, -0.08),
        shadeTop: 0,
        shadeBottom: 0,
        border: BLACK,
        borderAlpha: 0.28,
        borderW: 1,
        glow,
      }),
    );
    return;
  }

  if (meta.toyId === 'glass') {
    placeRect(
      out,
      body,
      0,
      0,
      rect({
        x: 0,
        y: 0,
        halfW: w / 2,
        halfH: h / 2,
        radius,
        color,
        alpha: 0.2,
        border: color,
        borderAlpha: 0.9,
        borderW: 1.5,
        pattern: PATTERN.glass,
        glow,
      }),
    );
    return;
  }

  const pattern =
    meta.toyId === 'crate'
      ? PATTERN.crate
      : meta.toyId === 'brick'
        ? PATTERN.brick
        : meta.toyId === 'plank'
          ? PATTERN.plank
          : PATTERN.bevel;

  placeRect(
    out,
    body,
    0,
    0,
    rect({
      x: 0,
      y: 0,
      halfW: w / 2,
      halfH: h / 2,
      radius,
      color,
      alpha: 1,
      shadeTop: 0.22,
      shadeBottom: -0.32,
      border: shadeRgb(color, -0.55),
      borderAlpha: 1,
      borderW: 1.5,
      pattern,
      glow,
    }),
  );
}

function packBelt(
  out: SceneBuffers,
  body: Matter.Body,
  meta: ToyMeta,
  time: number,
  glow: number,
): void {
  const { w, h } = meta;
  const belt = meta.belt;
  const dir = belt?.dir ?? 1;
  const accent = toRgb(meta.accent);
  const spacing = 30;
  const pxPerMs = (belt?.speed ?? 0) * (1000 / 16.666);
  const shift = (((time * pxPerMs * 0.001 * dir) % spacing) + spacing) % spacing;

  placeRect(
    out,
    body,
    0,
    0,
    rect({
      x: 0,
      y: 0,
      halfW: w / 2,
      halfH: h / 2,
      radius: 7,
      color: toRgb('#242c3c'),
      shadeTop: 0,
      shadeBottom: 0,
      border: accent,
      borderAlpha: 0.75,
      borderW: 1.5,
      pattern: PATTERN.belt,
      paramX: shift,
      paramY: dir,
      glow,
    }),
  );

  // End rollers.
  const rollerR = h / 2 - 2;
  for (const side of [-1, 1]) {
    const localX = side * (w / 2 - rollerR - 1);
    const c = Math.cos(body.angle);
    const s = Math.sin(body.angle);
    pushCircle(
      out,
      body.position.x + localX * c,
      body.position.y + localX * s,
      rollerR,
      toRgb('#0e1118'),
      1,
      accent,
      0.7,
      glow,
    );
  }
}

function packNote(
  out: SceneBuffers,
  body: Matter.Body,
  meta: ToyMeta,
  time: number,
  labels: LabelLookup | null,
  glow: number,
): void {
  const { w, h } = meta;
  const color = toRgb(meta.color);

  const age = meta.hitAt === undefined ? Infinity : time - meta.hitAt;
  const flash = age < 320 ? 1 - Math.max(0, age) / 320 : 0;

  placeRect(
    out,
    body,
    0,
    0,
    rect({
      x: 0,
      y: 0,
      halfW: w / 2,
      halfH: h / 2,
      radius: 6,
      color,
      shadeTop: 0.3,
      shadeBottom: -0.3,
      border: shadeRgb(color, -0.5),
      borderAlpha: 1,
      borderW: 1.5,
      pattern: PATTERN.note,
      glow: Math.max(glow, flash),
    }),
  );

  if (!meta.label || !labels) return;
  const cell = labels.cell(meta.label);
  if (!cell) return;

  // The label is drawn at half the body height; the atlas was rasterised at
  // `fontPx`, so that ratio is the whole scale factor.
  const scale = (0.5 * h) / labels.fontPx;
  // `drawNote` puts the text one world px below the centre, so it sits right
  // on the bar's midline rather than on the optical centre.
  const localY = 1;
  const c = Math.cos(body.angle);
  const s = Math.sin(body.angle);

  const at = out.sprites.slot();
  const d = out.sprites.data;
  d[at + SPRITE.x] = body.position.x - localY * s;
  d[at + SPRITE.y] = body.position.y + localY * c;
  d[at + SPRITE.halfW] = (cell.w * scale) / 2;
  d[at + SPRITE.halfH] = (cell.h * scale) / 2;
  d[at + SPRITE.angle] = body.angle;
  d[at + SPRITE.uv] = cell.u0;
  d[at + SPRITE.uv + 1] = cell.v0;
  d[at + SPRITE.uv + 2] = cell.u1;
  d[at + SPRITE.uv + 3] = cell.v1;
}

/** A little machine: housing, a mouth along the bottom edge, and three dots
 *  falling through it once per emission interval. */
function packSpawner(
  out: SceneBuffers,
  body: Matter.Body,
  meta: ToyMeta,
  time: number,
  glow: number,
): void {
  const { w, h } = meta;
  const color = toRgb(meta.color);
  const accent = toRgb(meta.accent);

  placeRect(
    out,
    body,
    0,
    0,
    rect({
      x: 0,
      y: 0,
      halfW: w / 2,
      halfH: h / 2,
      radius: 8,
      color,
      shadeTop: 0.34,
      shadeBottom: -0.42,
      border: shadeRgb(color, -0.6),
      borderAlpha: 1,
      borderW: 1.5,
      pattern: PATTERN.spawner,
      patternRgb: accent,
      glow,
    }),
  );

  // The mouth: a dark slot on the bottom edge, where the balls come out.
  placeRect(
    out,
    body,
    0,
    h / 2 - 4.5,
    rect({
      x: 0,
      y: 0,
      halfW: w * 0.28,
      halfH: 4.5,
      radius: 4,
      color: toRgb('#0a0d14'),
      glow,
    }),
  );

  const spec = meta.spawner;
  if (spec) {
    const phase = (((time % spec.rateMs) + spec.rateMs) % spec.rateMs) / spec.rateMs;
    for (let i = 0; i < 3; i++) {
      const t = (phase + i / 3) % 1;
      const localY = -h * 0.2 + t * h * 0.6;
      const r = 3.4 - t * 1.6;
      const c = Math.cos(body.angle);
      const s = Math.sin(body.angle);
      pushCircle(out, body.position.x - localY * s, body.position.y + localY * c, r, accent, 0.9, null, 0, glow);
    }
  }

  // Two bolts, so it reads as a bolted-on machine rather than a block.
  for (const side of [-1, 1]) {
    placeRect(
      out,
      body,
      side * (w / 2 - 8),
      -h / 2 + 8,
      rect({
        x: 0,
        y: 0,
        halfW: 2.4,
        halfH: 2.4,
        radius: 2.4,
        color: BLACK,
        alpha: 0.35,
        glow,
      }),
    );
  }
}

// --- granular sources ----------------------------------------------------

/** The hopper housing. Fixed slate, so the material colour is the only signal. */
const SOURCE_HOUSING = '#333b4c';

/**
 * A sand or water hopper: a dark housing, a mouth along the bottom edge in the
 * material's own colour, and a short stream falling out of it. The stream runs
 * on its own clock rather than the pour rate - at 340 grains a second the real
 * interval is three milliseconds, far too fast to read.
 */
function packSource(
  out: SceneBuffers,
  body: Matter.Body,
  meta: ToyMeta,
  time: number,
  glow: number,
): void {
  const { w, h } = meta;
  const housing = toRgb(SOURCE_HOUSING);
  const accent = toRgb(meta.accent);

  placeRect(
    out,
    body,
    0,
    0,
    rect({
      x: 0,
      y: 0,
      halfW: w / 2,
      halfH: h / 2,
      radius: 9,
      color: housing,
      shadeTop: 0.26,
      shadeBottom: -0.4,
      border: shadeRgb(housing, -0.6),
      borderAlpha: 1,
      borderW: 1.5,
      pattern: PATTERN.spawner,
      patternRgb: accent,
      glow,
    }),
  );

  // The mouth: a bright slot along the bottom edge, where the material leaves.
  placeRect(
    out,
    body,
    0,
    h / 2 - 5,
    rect({
      x: 0,
      y: 0,
      halfW: w * 0.34,
      halfH: 5,
      radius: 5,
      color: accent,
      alpha: 0.92,
      glow,
    }),
  );

  // Falling stream. Four dots on a looping stagger, fading as they fall.
  const period = 380;
  const phase = (((time % period) + period) % period) / period;
  const c = Math.cos(body.angle);
  const s = Math.sin(body.angle);

  for (let i = 0; i < 4; i++) {
    const t = (phase + i / 4) % 1;
    const localY = h / 2 + t * h * 1.15;
    pushCircle(
      out,
      body.position.x - localY * s,
      body.position.y + localY * c,
      3.4 - t * 1.7,
      accent,
      0.85 * (1 - t * 0.6),
      null,
      0,
      glow,
    );
  }
}

// --- polygons ------------------------------------------------------------

/**
 * Wedges and anything else built from vertices. A triangle fan for the fill,
 * then a quad per edge for the outline, then one lit edge for the bevel - the
 * canvas painter strokes paths, and there is no line primitive here.
 */
function packPoly(target: Instances, body: Matter.Body, meta: ToyMeta): void {
  const vertices = body.vertices;
  if (vertices.length < 3) return;

  const color = toRgb(meta.color);
  const top = shadeRgb(color, 0.25);
  const bottom = shadeRgb(color, -0.35);
  const border = shadeRgb(color, -0.55);

  // Gradient along the body's own y axis, so a rotated ramp still shades
  // top-to-bottom of the shape rather than of the screen.
  const upX = -Math.sin(body.angle);
  const upY = Math.cos(body.angle);
  const halfH = Math.max(1, meta.h / 2);

  const vertexColor = (x: number, y: number): RGB => {
    const t = Math.min(1, Math.max(0, 0.5 + ((x - body.position.x) * upX + (y - body.position.y) * upY) / (2 * halfH)));
    return [
      top[0] + (bottom[0] - top[0]) * t,
      top[1] + (bottom[1] - top[1]) * t,
      top[2] + (bottom[2] - top[2]) * t,
    ];
  };

  // Fill: fan from vertex 0.
  for (let i = 1; i < vertices.length - 1; i++) {
    emitPolyVertex(target, vertices[0].x, vertices[0].y, vertexColor(vertices[0].x, vertices[0].y), 1);
    emitPolyVertex(target, vertices[i].x, vertices[i].y, vertexColor(vertices[i].x, vertices[i].y), 1);
    emitPolyVertex(target, vertices[i + 1].x, vertices[i + 1].y, vertexColor(vertices[i + 1].x, vertices[i + 1].y), 1);
  }

  // Outline: a quad straddling each edge.
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    emitEdge(target, a.x, a.y, b.x, b.y, 0.75, border, 1);
  }

  // One lit edge reads as a worn, bevelled side.
  if (n >= 3) {
    emitEdge(target, vertices[1].x, vertices[1].y, vertices[2].x, vertices[2].y, 1, WHITE, 0.18);
  }
}

function emitPolyVertex(target: Instances, x: number, y: number, color: RGB, alpha: number): void {
  const at = target.slot();
  const d = target.data;
  d[at] = x;
  d[at + 1] = y;
  d[at + 2] = color[0] * K;
  d[at + 3] = color[1] * K;
  d[at + 4] = color[2] * K;
  d[at + 5] = alpha;
}

function emitEdge(
  target: Instances,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  halfWidth: number,
  color: RGB,
  alpha: number,
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * halfWidth;
  const ny = (dx / len) * halfWidth;

  const corners: [number, number][] = [
    [ax + nx, ay + ny],
    [ax - nx, ay - ny],
    [bx + nx, by + ny],
    [bx - nx, by - ny],
  ];
  for (const index of [0, 1, 2, 1, 3, 2]) {
    emitPolyVertex(target, corners[index][0], corners[index][1], color, alpha);
  }
}

// --- gadgets -------------------------------------------------------------
//
// Same shapes as the canvas painter's gadget section, in the instance families
// that exist: circles for anything round, rects for housings, mats and blades,
// and poly edges for the fuse, the string and the wind (polys draw first, so a
// line never covers a body). The animation numbers come from `gadgets.ts`.

const RGB_CAP = toRgb(GADGET.bombCap);
const RGB_FUSE = toRgb(GADGET.fuse);
const RGB_SPARK = toRgb(GADGET.spark);
const RGB_DANGER = toRgb(GADGET.danger);
const RGB_WELL = toRgb(GADGET.fanWell);
const RGB_BLADE = toRgb(GADGET.fanBlade);
const RGB_HUB = toRgb(GADGET.fanHub);
const RGB_FRAME = toRgb(GADGET.trampolineFrame);
const RGB_TCAP = toRgb(GADGET.trampolineCap);
const RGB_CORE = toRgb(GADGET.holeCore);
const RGB_STRING = toRgb(GADGET.string);

/** A body-frame point, in world px. */
function toWorldPoint(body: Matter.Body, x: number, y: number): [number, number] {
  const c = Math.cos(body.angle);
  const s = Math.sin(body.angle);
  return [body.position.x + x * c - y * s, body.position.y + x * s + y * c];
}

function emitLine(
  target: Instances,
  points: { x: number; y: number }[],
  map: (x: number, y: number) => [number, number],
  halfWidth: number,
  color: RGB,
  alpha: number,
): void {
  let [ax, ay] = map(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    const [bx, by] = map(points[i].x, points[i].y);
    emitEdge(target, ax, ay, bx, by, halfWidth, color, alpha);
    ax = bx;
    ay = by;
  }
}

function packBomb(out: SceneBuffers, body: Matter.Body, meta: ToyMeta, time: number, glow: number): void {
  const r = body.circleRadius ?? meta.w / 2;
  const points = fusePoints(r, fuseLeft(meta));
  const inBody = (x: number, y: number) => toWorldPoint(body, x, y);
  emitLine(out.polys, points, inBody, 1, RGB_FUSE, 1);

  placeRect(out, body, 0, -r - 3, rect({ x: 0, y: 0, halfW: 5, halfH: 4, radius: 2, color: RGB_CAP, glow }));

  const color = toRgb(meta.color);
  pushCircle(out, body.position.x, body.position.y, r, color, 1, shadeRgb(color, BALL_BORDER), 1, glow);

  const danger = bombDanger(meta, time);
  if (danger > 0) {
    // Flat (the liquid path) so the sheen is not painted twice.
    pushCircle(out, body.position.x, body.position.y, r * 0.86, RGB_DANGER, danger * 0.55, null, 0, 0, 0, 1, 1);
  }

  const tip = points[points.length - 1];
  const [sx, sy] = inBody(tip.x, tip.y);
  // The halo is a soft flat disc: a small `glow` value leaves a visible square
  // at the edge of the quad, because the falloff has not reached zero there.
  const spark = sparkRadius(time);
  pushCircle(out, sx, sy, spark * 2.6, RGB_SPARK, 0.35, null, 0, 0, 0, 1, 1);
  pushCircle(out, sx, sy, spark, RGB_SPARK, 1, null, 0);
}

function packBalloon(out: SceneBuffers, body: Matter.Body, meta: ToyMeta, time: number, glow: number): void {
  const r = body.circleRadius ?? meta.w / 2;
  const { x, y } = body.position;
  // Screen frame, not the body's: a balloon's string always hangs down.
  const inScreen = (px: number, py: number): [number, number] => [x + px, y + py];
  emitLine(out.polys, balloonString(r, time, body.id, body.velocity.x), inScreen, 0.6, RGB_STRING, 0.8);

  const color = toRgb(meta.color);
  const knot = shadeRgb(color, -0.25);
  emitPolyVertex(out.polys, x - 3.5, y + r + 4, knot, 1);
  emitPolyVertex(out.polys, x + 3.5, y + r + 4, knot, 1);
  emitPolyVertex(out.polys, x, y + r - 1, knot, 1);

  pushCircle(out, x, y, r, color, 1, shadeRgb(color, BALL_BORDER), 1, glow);
}

const STREAKS: Streak[] = [];

function packFan(out: SceneBuffers, body: Matter.Body, meta: ToyMeta, time: number, glow: number): void {
  const { w, h } = meta;
  const spec = meta.fan;
  const color = toRgb(meta.color);
  const accent = toRgb(meta.accent);
  const inBody = (x: number, y: number) => toWorldPoint(body, x, y);

  for (const streak of fanStreaks(time, w * 1.3, spec?.reach ?? 300, STREAKS)) {
    const y0 = -h / 2 - streak.along;
    const [ax, ay] = inBody(streak.across, y0);
    const [bx, by] = inBody(streak.across, y0 - streak.length);
    emitEdge(out.polys, ax, ay, bx, by, 1.2, accent, streak.alpha);
  }

  placeRect(
    out,
    body,
    0,
    0,
    rect({
      x: 0,
      y: 0,
      halfW: w / 2,
      halfH: h / 2,
      radius: 8,
      color,
      shadeTop: 0.3,
      shadeBottom: -0.4,
      border: shadeRgb(color, -0.6),
      borderW: 1.5,
      glow,
    }),
  );
  placeRect(out, body, 0, -h / 2 + 3.5, rect({ x: 0, y: 0, halfW: w / 2 - 6, halfH: 1.5, radius: 1.5, color: accent, alpha: 0.85 }));

  const wellR = h / 2 - 4;
  placeRect(out, body, 0, 2, rect({ x: 0, y: 0, halfW: wellR, halfH: wellR, radius: wellR, color: RGB_WELL }));

  // Blades: each a rounded bar from the hub outwards, at its own angle.
  const spin = fanSpin(time, spec?.strength ?? 1);
  const [hx, hy] = inBody(0, 2);
  const bladeLen = wellR - 2;
  for (let k = 0; k < 3; k++) {
    const a = body.angle + spin + (k * Math.PI * 2) / 3;
    // Local "up" of the blade, rotated by `a`: the bar's centre is half a blade out.
    const cx = hx + Math.sin(a) * (bladeLen / 2);
    const cy = hy - Math.cos(a) * (bladeLen / 2);
    pushRect(out.rects, rect({ x: cx, y: cy, halfW: 2.6, halfH: bladeLen / 2, radius: 2.6, angle: a, color: RGB_BLADE }));
  }
  pushCircle(out, hx, hy, 3.2, RGB_HUB, 1, null, 0);
}

function packTrampoline(out: SceneBuffers, body: Matter.Body, meta: ToyMeta, time: number, glow: number): void {
  const { w, h } = meta;
  const dip = trampolineDip(meta, time);
  const flash = Math.max(0, dip);
  const color = toRgb(meta.color);
  const inBody = (x: number, y: number) => toWorldPoint(body, x, y);

  placeRect(
    out,
    body,
    0,
    0,
    rect({
      x: 0,
      y: 0,
      halfW: w / 2,
      halfH: h / 2,
      radius: h / 2,
      color: RGB_FRAME,
      border: shadeRgb(RGB_FRAME, -0.5),
      borderW: 1.5,
      glow,
    }),
  );

  // Springs: thin rects, not poly edges - polys draw before rects, so an edge
  // would vanish under the frame.
  for (let x = -w / 2 + 16; x <= w / 2 - 16; x += 10) {
    const [ax, ay] = inBody(x - 2, h / 2 - 3);
    const [bx, by] = inBody(x + 2, -h / 2 + 7);
    pushRect(
      out.rects,
      rect({
        x: (ax + bx) / 2,
        y: (ay + by) / 2,
        halfW: 0.6,
        halfH: Math.hypot(bx - ax, by - ay) / 2,
        angle: Math.atan2(bx - ax, -(by - ay)),
        color: RGB_TCAP,
        alpha: 0.55,
      }),
    );
  }

  placeRect(
    out,
    body,
    0,
    -h / 2 + 4 + dip * 4,
    rect({ x: 0, y: 0, halfW: w / 2 - 8, halfH: 3, radius: 3, color: shadeRgb(color, 0.1 * flash), glow: Math.max(glow, flash) }),
  );

  for (const side of [-1, 1]) {
    const [cx, cy] = inBody(side * (w / 2 - h / 2), 0);
    pushCircle(out, cx, cy, h / 2 - 2, RGB_TCAP, 1, shadeRgb(RGB_TCAP, -0.5), 1);
  }
}

const ORBITS: Orbit[] = [];

function packHole(out: SceneBuffers, body: Matter.Body, meta: ToyMeta, time: number, glow: number): void {
  const r = meta.w / 2;
  const { x, y } = body.position;
  const accent = toRgb(meta.accent);
  const throb = holeThrob(meta, time);

  if (meta.hole) pushCircle(out, x, y, meta.hole.reach, accent, 0, accent, 0.1, 0, 22);
  // The halo: a soft flat disc in the accent colour, under everything else.
  pushCircle(out, x, y, r * 2.4, accent, 0.4 + 0.25 * throb, null, 0, 0, 0, 1, 1);

  for (const orbit of holeOrbits(time, r, ORBITS)) {
    pushCircle(out, x + orbit.x, y + orbit.y, orbit.radius, accent, orbit.alpha, null, 0, 0, 0, 1, 1);
  }

  // The core: flat black (the liquid path has no sheen), then a lit rim as an
  // outline-only circle, which also carries the drag highlight.
  const core = r * (1 + 0.12 * throb);
  pushCircle(out, x, y, core / 1.1, RGB_CORE, 1, null, 0, 0, 0, 1, 1);
  pushCircle(out, x, y, core, accent, 0, accent, 0.9, glow);
}

function packEffect(out: SceneBuffers, effect: Effect, time: number): void {
  const ring = effectRings(effect, time);
  if (ring.alpha <= 0) return;
  const color = toRgb(effect.color);

  if (ring.flash > 0) {
    const r = effect.radius * 0.45 * (0.6 + ring.flash * 0.4);
    pushCircle(out, effect.x, effect.y, r, RGB_SPARK, ring.flash * 0.5, null, 0, 0, 0, 1, 1);
  }

  // A circle's outline is 1.5 px; a blast is drawn as three of them.
  const rings = effect.kind === 'blast' ? 3 : 1;
  for (let i = 0; i < rings; i++) {
    pushCircle(out, effect.x, effect.y, Math.max(1, ring.radius - i * 1.3), color, 0, color, ring.alpha);
  }
}

// --- ghost ---------------------------------------------------------------

/** The drop preview: a faint fill and a dashed outline, over everything else. */
function packGhost(out: SceneBuffers, ghost: Ghost): void {
  const color = toRgb(ghost.color);

  if (ghost.shape === 'circle') {
    const at = out.ghostCircle.slot();
    const d = out.ghostCircle.data;
    d[at + DOT.x] = ghost.x;
    d[at + DOT.y] = ghost.y;
    d[at + DOT.radius] = ghost.w / 2;
    d[at + DOT.color] = color[0] * K;
    d[at + DOT.color + 1] = color[1] * K;
    d[at + DOT.color + 2] = color[2] * K;
    d[at + DOT.color + 3] = 0.06;
    d[at + DOT.border] = 1;
    d[at + DOT.liquid] = 0;

    const st = out.ghostStyle.slot();
    const s = out.ghostStyle.data;
    s[st + CIRCLE_STYLE.glow] = 0;
    s[st + CIRCLE_STYLE.border] = color[0] * K;
    s[st + CIRCLE_STYLE.border + 1] = color[1] * K;
    s[st + CIRCLE_STYLE.border + 2] = color[2] * K;
    s[st + CIRCLE_STYLE.border + 3] = 0.48;
    s[st + CIRCLE_STYLE.dash] = 12;
    return;
  }

  pushRect(
    out.ghostRect,
    rect({
      x: ghost.x,
      y: ghost.y,
      halfW: ghost.w / 2,
      halfH: ghost.h / 2,
      radius: 5,
      color,
      alpha: 0.06,
      border: color,
      borderAlpha: 0.48,
      borderW: 1.5,
      pattern: PATTERN.dash,
      paramX: 12,
    }),
  );
}
