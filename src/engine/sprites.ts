// Pre-rendered body sprites.
//
// Drawing a ball from scratch is a handful of path operations and two freshly
// allocated radial gradients; at a thousand balls that is a measurable slice of
// every frame. A ball never changes shape, so it can be rendered once per
// (colour, radius, device scale) and blitted with a single drawImage - which is
// also what makes a canvas of thousands of bodies possible at all.

import { alpha, shade } from '../lib/color';

type Sprite = HTMLCanvasElement;

const cache = new Map<string, BallSprite>();

/** Margin around a ball, in world px, so the stroke can't clip at the edge. */
const PAD = 2;

export interface BallSprite {
  canvas: Sprite;
  /** width in world px - draw it with `drawImage(canvas, -extent/2, -extent/2, extent, extent)` */
  extent: number;
}

export interface SpriteStyle {
  /** draw the dark rim; false lets neighbouring grains merge into one mass */
  rim?: boolean;
  /** fill opacity - the granular layer's water is translucent */
  alpha?: number;
  /** a liquid: flat translucent fill, feathered edge, no rim and no specular,
   *  so a cluster of them reads as one body of water (see the GL shader) */
  soft?: boolean;
}

/**
 * A ball of `radius` world px, rendered at `k` device px per world px.
 *
 * The canvas is sized so that drawing it back at `extent` world px maps it
 * one-to-one onto device pixels: no resampling, no blur.
 */
export function ballSprite(
  color: string,
  radius: number,
  k: number,
  style: SpriteStyle = {},
): BallSprite {
  const rim = style.rim !== false && style.soft !== true;
  const soft = style.soft === true;
  const opacity = style.alpha ?? 1;
  const extent = radius * 2 + PAD;
  const key = `${color}|${radius}|${k}|${rim ? 1 : 0}|${opacity}|${soft ? 1 : 0}`;
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

  if (soft) {
    // Flat colour fading out at the rim, exactly like the shader's liquid path.
    const blob = g.createRadialGradient(c, c, 0, c, c, r * 1.18);
    blob.addColorStop(0, alpha(color, opacity));
    blob.addColorStop(0.62, alpha(color, opacity));
    blob.addColorStop(1, alpha(color, 0));
    g.fillStyle = blob;
    g.beginPath();
    g.arc(c, c, r * 1.18, 0, Math.PI * 2);
    g.fill();

    const liquid: BallSprite = { canvas, extent };
    cache.set(key, liquid);
    return liquid;
  }

  g.globalAlpha = opacity;

  const fill = g.createRadialGradient(c - r * 0.35, c - r * 0.4, r * 0.1, c, c, r * 1.05);
  fill.addColorStop(0, shade(color, 0.55));
  fill.addColorStop(0.55, color);
  fill.addColorStop(1, shade(color, -0.45));

  g.beginPath();
  g.arc(c, c, r, 0, Math.PI * 2);
  g.fillStyle = fill;
  g.fill();

  if (rim) {
    g.lineWidth = 1.5;
    g.strokeStyle = shade(color, -0.55);
    g.stroke();
  }

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

/** Drop everything - device scale and playfield zoom are part of the key. */
export function resetSprites(): void {
  cache.clear();
}
