import type Matter from 'matter-js';
import { alpha, shade } from '../lib/color';
import { metaOf } from '../toys/meta';
import type { ToyMeta } from '../toys/types';

/** Translucent preview of the toy that is about to be dropped. */
export interface Ghost {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  shape: 'circle' | 'rect';
}

export interface RenderInput {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  /** milliseconds, same clock as `performance.now()` */
  time: number;
  bodies: Matter.Body[];
  ghost: Ghost | null;
  grid: Path2D | null;
  draggingId: number | null;
  /** world px per css px; hairlines are widened by it so they survive a zoom-out */
  scale: number;
}

export function renderScene(input: RenderInput): void {
  const { ctx, width, height, grid, scale } = input;

  drawBackground(ctx, width, height, grid, scale);

  for (const body of input.bodies) {
    drawBody(ctx, body, input.time, body.id === input.draggingId);
  }

  if (input.ghost) drawGhost(ctx, input.ghost);
  drawFrame(ctx, width, height, scale);
}

/** Build the repeating grid path once per size change. */
export function buildGrid(width: number, height: number, spacing = 34): Path2D {
  const path = new Path2D();
  for (let x = spacing; x < width; x += spacing) {
    path.moveTo(Math.round(x) + 0.5, 0);
    path.lineTo(Math.round(x) + 0.5, height);
  }
  for (let y = spacing; y < height; y += spacing) {
    path.moveTo(0, Math.round(y) + 0.5);
    path.lineTo(width, Math.round(y) + 0.5);
  }
  return path;
}

function drawBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  grid: Path2D | null,
  scale: number,
): void {
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, '#141823');
  gradient.addColorStop(0.6, '#0e1017');
  gradient.addColorStop(1, '#0a0c11');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  if (grid) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.035)';
    ctx.lineWidth = scale;
    ctx.stroke(grid);
  }
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  scale: number,
): void {
  // Inner shadow along the bottom, so the floor reads as the bottom of a box.
  const shadow = ctx.createLinearGradient(0, height - 90, 0, height);
  shadow.addColorStop(0, 'rgba(0, 0, 0, 0)');
  shadow.addColorStop(1, 'rgba(0, 0, 0, 0.45)');
  ctx.fillStyle = shadow;
  ctx.fillRect(0, height - 90, width, 90);

  // A lit strip and a hard line at the very bottom: without it, bodies resting
  // on the floor look like they are floating in the dark.
  const floor = ctx.createLinearGradient(0, height - 26, 0, height);
  floor.addColorStop(0, 'rgba(255, 255, 255, 0)');
  floor.addColorStop(1, 'rgba(255, 255, 255, 0.06)');
  ctx.fillStyle = floor;
  ctx.fillRect(0, height - 26, width, 26);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.11)';
  ctx.fillRect(0, height - 2 * scale, width, 2 * scale);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.lineWidth = 2 * scale;
  ctx.strokeRect(scale, scale, width - 2 * scale, height - 2 * scale);
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawBody(
  ctx: CanvasRenderingContext2D,
  body: Matter.Body,
  time: number,
  dragging: boolean,
): void {
  const meta = metaOf(body);
  if (!meta) return;

  ctx.save();
  ctx.translate(body.position.x, body.position.y);

  if (dragging) {
    ctx.shadowColor = alpha(meta.color, 0.75);
    ctx.shadowBlur = 22;
  }

  switch (meta.kind) {
    case 'ball':
      drawBall(ctx, body, meta);
      break;
    case 'belt':
      ctx.rotate(body.angle);
      drawBelt(ctx, meta, time);
      break;
    case 'note':
      ctx.rotate(body.angle);
      drawNote(ctx, meta, time);
      break;
    case 'spawner':
      ctx.rotate(body.angle);
      drawSpawner(ctx, meta, time);
      break;
    default:
      // Polygons are drawn from their world vertices, so no extra rotation.
      if (meta.shape !== 'poly') ctx.rotate(body.angle);
      drawBlock(ctx, body, meta);
      break;
  }

  ctx.restore();
}

function drawBall(ctx: CanvasRenderingContext2D, body: Matter.Body, meta: ToyMeta): void {
  const r = body.circleRadius ?? meta.w / 2;

  const fill = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r * 1.05);
  fill.addColorStop(0, shade(meta.color, 0.55));
  fill.addColorStop(0.55, meta.color);
  fill.addColorStop(1, shade(meta.color, -0.45));

  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = shade(meta.color, -0.55);
  ctx.stroke();

  // Specular highlight, always top-left (balls don't rotate their shading).
  const spec = ctx.createRadialGradient(-r * 0.34, -r * 0.4, 0, -r * 0.34, -r * 0.4, r * 0.6);
  spec.addColorStop(0, 'rgba(255, 255, 255, 0.6)');
  spec.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = spec;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
}

/** Wedges and other non-rectangular bodies: the path comes from world vertices. */
function drawPolygon(
  ctx: CanvasRenderingContext2D,
  body: Matter.Body,
  meta: ToyMeta,
): void {
  const { x, y } = body.position;
  const vertices = body.vertices;

  ctx.beginPath();
  ctx.moveTo(vertices[0].x - x, vertices[0].y - y);
  for (let i = 1; i < vertices.length; i++) {
    ctx.lineTo(vertices[i].x - x, vertices[i].y - y);
  }
  ctx.closePath();

  const fill = ctx.createLinearGradient(0, -meta.h / 2, 0, meta.h / 2);
  fill.addColorStop(0, shade(meta.color, 0.25));
  fill.addColorStop(1, shade(meta.color, -0.35));
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = shade(meta.color, -0.55);
  ctx.stroke();

  // A light stroke along one edge reads as a worn, bevelled side.
  if (vertices.length >= 3) {
    ctx.beginPath();
    ctx.moveTo(vertices[1].x - x, vertices[1].y - y);
    ctx.lineTo(vertices[2].x - x, vertices[2].y - y);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawBlock(ctx: CanvasRenderingContext2D, body: Matter.Body, meta: ToyMeta): void {
  const { w, h } = meta;
  const radius = Math.min(9, Math.min(w, h) * 0.2);

  if (meta.shape === 'poly') {
    drawPolygon(ctx, body, meta);
    return;
  }

  // Shards are many and short-lived: a flat fill keeps a big break cheap.
  if (w < 34 || h < 34) {
    ctx.fillStyle = shade(meta.color, -0.08);
    roundedRect(ctx, -w / 2, -h / 2, w, h, Math.min(3, radius));
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();
    return;
  }

  if (meta.toyId === 'glass') {
    roundedRect(ctx, -w / 2, -h / 2, w, h, radius);
    ctx.fillStyle = alpha(meta.color, 0.2);
    ctx.fill();
    ctx.strokeStyle = alpha(meta.color, 0.9);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // A diagonal glint, plus a second thin one.
    ctx.save();
    roundedRect(ctx, -w / 2, -h / 2, w, h, radius);
    ctx.clip();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-w * 0.1, -h * 0.6);
    ctx.lineTo(-w * 0.55, h * 0.1);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(w * 0.12, -h * 0.6);
    ctx.lineTo(-w * 0.3, h * 0.05);
    ctx.stroke();
    ctx.restore();
    return;
  }

  const fill = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
  fill.addColorStop(0, shade(meta.color, 0.22));
  fill.addColorStop(1, shade(meta.color, -0.32));

  roundedRect(ctx, -w / 2, -h / 2, w, h, radius);
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = shade(meta.color, -0.55);
  ctx.stroke();

  // Bevel highlight.
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  roundedRect(ctx, -w / 2 + 1.5, -h / 2 + 1.5, w - 3, h - 3, Math.max(1, radius - 1));
  ctx.stroke();

  ctx.strokeStyle = 'rgba(0, 0, 0, 0.22)';

  if (meta.toyId === 'crate') {
    // Cross brace, like a shipping crate.
    const inset = Math.min(w, h) * 0.16;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-w / 2 + inset, -h / 2 + inset);
    ctx.lineTo(w / 2 - inset, h / 2 - inset);
    ctx.moveTo(w / 2 - inset, -h / 2 + inset);
    ctx.lineTo(-w / 2 + inset, h / 2 - inset);
    ctx.stroke();
  } else if (meta.toyId === 'brick') {
    // Mortar joint across the middle.
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-w / 2 + 3, 0);
    ctx.lineTo(w / 2 - 3, 0);
    ctx.stroke();
  } else if (meta.toyId === 'plank') {
    // Grain line.
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-w / 2 + 4, -h * 0.18);
    ctx.lineTo(w / 2 - 4, -h * 0.18);
    ctx.stroke();
  }
}

function drawBelt(ctx: CanvasRenderingContext2D, meta: ToyMeta, time: number): void {
  const { w, h } = meta;
  const belt = meta.belt;
  const dir = belt?.dir ?? 1;
  const radius = 7;

  ctx.fillStyle = '#242c3c';
  roundedRect(ctx, -w / 2, -h / 2, w, h, radius);
  ctx.fill();

  ctx.strokeStyle = alpha(meta.accent, 0.75);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Moving chevrons, clipped to the belt body.
  const spacing = 30;
  const pxPerMs = (belt?.speed ?? 0) * (1000 / 16.666);
  const shift = (((time * pxPerMs * 0.001 * dir) % spacing) + spacing) % spacing;

  ctx.save();
  roundedRect(ctx, -w / 2, -h / 2, w, h, radius);
  ctx.clip();

  ctx.strokeStyle = alpha(meta.accent, 0.8);
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (let x = -w / 2 - spacing; x < w / 2 + spacing; x += spacing) {
    const cx = x + shift;
    ctx.beginPath();
    ctx.moveTo(cx - 5 * dir, -h * 0.24);
    ctx.lineTo(cx + 3 * dir, 0);
    ctx.lineTo(cx - 5 * dir, h * 0.24);
    ctx.stroke();
  }
  ctx.restore();

  // End rollers.
  const rollerR = h / 2 - 2;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(side * (w / 2 - rollerR - 1), 0, rollerR, 0, Math.PI * 2);
    ctx.fillStyle = '#0e1118';
    ctx.fill();
    ctx.strokeStyle = alpha(meta.accent, 0.7);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

/** A little machine: housing, a mouth along the bottom edge, and three dots
 *  falling through it once per emission interval. */
function drawSpawner(ctx: CanvasRenderingContext2D, meta: ToyMeta, time: number): void {
  const { w, h } = meta;
  const radius = 8;
  const spec = meta.spawner;

  const fill = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
  fill.addColorStop(0, shade(meta.color, 0.34));
  fill.addColorStop(1, shade(meta.color, -0.42));

  roundedRect(ctx, -w / 2, -h / 2, w, h, radius);
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.strokeStyle = shade(meta.color, -0.6);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.strokeStyle = alpha(meta.accent, 0.5);
  ctx.lineWidth = 1;
  roundedRect(ctx, -w / 2 + 3, -h / 2 + 3, w - 6, h - 6, Math.max(1, radius - 2));
  ctx.stroke();

  // The mouth: a dark slot on the bottom edge, where the balls come out.
  ctx.fillStyle = '#0a0d14';
  roundedRect(ctx, -w * 0.28, h / 2 - 9, w * 0.56, 9, 4);
  ctx.fill();

  if (spec) {
    const phase = (((time % spec.rateMs) + spec.rateMs) % spec.rateMs) / spec.rateMs;
    ctx.fillStyle = alpha(meta.accent, 0.9);
    for (let i = 0; i < 3; i++) {
      const t = (phase + i / 3) % 1;
      const y = -h * 0.2 + t * h * 0.6;
      const r = 3.4 - t * 1.6;
      ctx.beginPath();
      ctx.arc(0, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Two bolts, so it reads as a bolted-on machine rather than a block.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(side * (w / 2 - 8), -h / 2 + 8, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawNote(ctx: CanvasRenderingContext2D, meta: ToyMeta, time: number): void {
  const { w, h } = meta;
  const radius = 6;

  const age = meta.hitAt === undefined ? Infinity : time - meta.hitAt;
  const glow = age < 320 ? 1 - Math.max(0, age) / 320 : 0;

  if (glow > 0) {
    ctx.shadowColor = alpha(meta.color, 0.95);
    ctx.shadowBlur = 30 * glow;
  }

  const fill = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
  fill.addColorStop(0, shade(meta.color, 0.3));
  fill.addColorStop(1, shade(meta.color, -0.3));

  roundedRect(ctx, -w / 2, -h / 2, w, h, radius);
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.strokeStyle = shade(meta.color, -0.5);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.lineWidth = 1;
  roundedRect(ctx, -w / 2 + 2, -h / 2 + 2, w - 4, h - 4, radius - 1);
  ctx.stroke();

  if (meta.label) {
    ctx.font = `700 ${Math.round(h * 0.5)}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(10, 12, 18, 0.78)';
    ctx.fillText(meta.label, 0, 1);
  }
}

function drawGhost(ctx: CanvasRenderingContext2D, ghost: Ghost): void {
  ctx.save();
  ctx.translate(ghost.x, ghost.y);
  ctx.globalAlpha = 0.5;
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = alpha(ghost.color, 0.95);
  ctx.fillStyle = alpha(ghost.color, 0.12);

  if (ghost.shape === 'circle') {
    ctx.beginPath();
    ctx.arc(0, 0, ghost.w / 2, 0, Math.PI * 2);
  } else {
    roundedRect(ctx, -ghost.w / 2, -ghost.h / 2, ghost.w, ghost.h, 5);
  }

  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
