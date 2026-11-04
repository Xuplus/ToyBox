import type Matter from 'matter-js';
import type { GrainWorld } from '../physics/grains';

/** Translucent preview of the toy that is about to be dropped. */
export interface Ghost {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  shape: 'circle' | 'rect';
}

/**
 * Everything a painter needs for one frame, as plain data — no canvas, no GL
 * context, no engine. The WebGL painter turns it into instance buffers; the
 * canvas painter draws it directly. They read the same struct, which is what
 * keeps the two paths from drifting apart.
 */
export interface Scene {
  /** simulated box size, world px */
  worldW: number;
  worldH: number;
  /** ms on the `performance.now()` clock */
  time: number;
  bodies: Matter.Body[];
  draggingId: number | null;
  ghost: Ghost | null;
  grains: GrainWorld | null;
  /** world px per css px — the playfield zoom */
  scale: number;
  /** device px per world px */
  pixelRatio: number;
  /** canvas path only: blit cached ball sprites instead of rebuilding gradients */
  useSprites: boolean;
}

export type PainterKind = 'webgl' | 'canvas2d';

/** The one interface the engine draws through. */
export interface Painter {
  readonly kind: PainterKind;
  /** drawing buffer size, in device px — not the css box */
  resize(deviceW: number, deviceH: number): void;
  draw(scene: Scene): void;
  dispose(): void;
}
