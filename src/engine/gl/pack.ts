// Scene → instance buffers.
//
// This is the whole of the old `render.ts` body, turned inside out: instead of
// issuing canvas calls, it writes numbers into flat arrays. It is pure — the
// only things it touches are the scene, the toy metadata and the buffer
// objects — so the packing (which pattern a crate gets, how many instances a
// belt emits, where a note's label lands) is unit-testable without a GPU.

import type Matter from 'matter-js';
import { shadeRgb, toRgb, type RGB } from '../../lib/color';
import type { GrainWorld } from '../../physics/grains';
import { metaOf } from '../../toys/meta';
import type { ToyMeta } from '../../toys/types';
import type { Ghost, Scene } from '../scene';
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

/** Sand-coloured grains, so the granular layer reads as its own material. */
export const GRAIN_COLOR = '#e0a458';

const K = 1 / 255;

/** Outlines every ball gets: `shade(color, -0.55)`. */
const BALL_BORDER = -0.55;

/** One reusable set of buffers — reset, refilled and uploaded every frame. */
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

/** Outline + halo colour every grain shares, as a generic vertex attribute. */
export const GRAIN_BORDER: RGB = shadeRgb(toRgb(GRAIN_COLOR), BALL_BORDER);

/**
 * Fill one frame's buffers. `labels` may be null when the atlas could not be
 * built — the note bodies still draw, they just arrive without their name.
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
      default:
        packBlock(out, body, meta, glow);
        break;
    }
  }

  if (scene.ghost) packGhost(out, scene.ghost);
}

// --- grains --------------------------------------------------------------

/**
 * The granular layer: position and radius, nothing else. All grains share a
 * colour *and* an outline, which the renderer supplies as a constant vertex
 * attribute — so 20,000 grains cost 7 floats each, not 13.
 */
function packGrains(dots: Instances, grains: GrainWorld): void {
  const count = grains.count;
  if (count === 0) return;

  dots.reserve(count);
  const d = dots.data;
  const radius = grains.options.radius;
  const color = toRgb(GRAIN_COLOR);
  const r = color[0] * K;
  const g = color[1] * K;
  const b = color[2] * K;

  let at = dots.count * DOT_STRIDE;
  for (let i = 0; i < count; i++) {
    d[at + DOT.x] = grains.x[i];
    d[at + DOT.y] = grains.y[i];
    d[at + DOT.radius] = radius;
    d[at + DOT.color] = r;
    d[at + DOT.color + 1] = g;
    d[at + DOT.color + 2] = b;
    d[at + DOT.color + 3] = 1;
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

// --- polygons ------------------------------------------------------------

/**
 * Wedges and anything else built from vertices. A triangle fan for the fill,
 * then a quad per edge for the outline, then one lit edge for the bevel — the
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
