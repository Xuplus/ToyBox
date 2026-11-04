// Pre-rendered body sprites.
//
// Drawing a ball from scratch is a handful of path operations and two freshly
// allocated radial gradients; at a thousand balls that is a measurable slice of
// every frame. A ball never changes shape, so it can be rendered once per
// (colour, radius, device scale) and blitted with a single drawImage — which is
// also what makes a canvas of thousands of bodies possible at all.

import { shade } from '../lib/color';

type Sprite = HTMLCanvasElement;

const cache = new Map<string, BallSprite>();

/** Margin around a ball, in world px, so the stroke can't clip at the edge. */
const PAD = 2;

export interface BallSprite {
  canvas: Sprite;
  /** width in world px — draw it with `drawImage(canvas, -extent/2, -extent/2, extent, extent)` */
  extent: number;
}

/**
 * A ball of `radius` world px, rendered at `k` device px per world px.
 *
 * The canvas is sized so that drawing it back at `extent` world px maps it
 * one-to-one onto device pixels: no resampling, no blur.
 */
export function ballSprite(color: string, radius: number, k: number): BallSprite {
  const extent = radius * 2 + PAD;
  const key = `${color}|${radius}|${k}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const size = Math.max(2, Math.ceil(extent * k));
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const g = canvas.getContext('2d');
  if (!g) return { canvas, extent };

  g.setTransform(k, 0, 0, k, 0, 0);

  const c = extent / 2;
  const r = radius;

  const fill = g.createRadialGradient(c - r * 0.35, c - r * 0.4, r * 0.1, c, c, r * 1.05);
  fill.addColorStop(0, shade(color, 0.55));
  fill.addColorStop(0.55, color);
  fill.addColorStop(1, shade(color, -0.45));

  g.beginPath();
  g.arc(c, c, r, 0, Math.PI * 2);
  g.fillStyle = fill;
  g.fill();

  g.lineWidth = 1.5;
  g.strokeStyle = shade(color, -0.55);
  g.stroke();

  // Specular highlight, top-left: balls don't rotate their shading.
  const spec = g.createRadialGradient(c - r * 0.34, c - r * 0.4, 0, c - r * 0.34, c - r * 0.4, r * 0.6);
  spec.addColorStop(0, 'rgba(255, 255, 255, 0.6)');
  spec.addColorStop(1, 'rgba(255, 255, 255, 0)');
  g.fillStyle = spec;
  g.beginPath();
  g.arc(c, c, r, 0, Math.PI * 2);
  g.fill();

  const sprite: BallSprite = { canvas, extent };
  cache.set(key, sprite);
  return sprite;
}

/** Drop everything — device scale and playfield zoom are part of the key. */
export function resetSprites(): void {
  cache.clear();
}
