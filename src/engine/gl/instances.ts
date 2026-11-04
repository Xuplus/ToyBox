// Instance buffers for the WebGL painter.
//
// Every toy is packed into a handful of flat Float32Arrays, one per *pipeline*
// (dots, circles, rects, sprites, polys). The layouts below are the contract
// with the shaders in `shaders.ts`: the attribute order there must match the
// offsets here. Keeping them in one place, with named offsets, is what makes
// that checkable instead of guesswork.

/**
 * A growable Float32Array of fixed-stride records.
 *
 * `slot()` hands back the float index of the next record and bumps the count;
 * the caller writes `stride` floats at it. That is the whole API — no per-entry
 * objects, no allocation once warm, and no `push(...args)` spread (which
 * allocates and is slow in a 20k-instance loop).
 */
export class Instances {
  data: Float32Array;
  count = 0;

  constructor(readonly stride: number, capacity = 256) {
    this.data = new Float32Array(stride * capacity);
  }

  reset(): void {
    this.count = 0;
  }

  /** Make room for `n` more records, so a hot loop can hoist `data`. */
  reserve(n: number): void {
    const needed = (this.count + n) * this.stride;
    if (needed <= this.data.length) return;
    const next = new Float32Array(Math.max(this.data.length * 2, needed));
    next.set(this.data);
    this.data = next;
  }

  /**
   * Float index of the next record. Write `stride` floats there. Read `data`
   * *after* calling this — a growth replaces the array.
   */
  slot(): number {
    const at = this.count * this.stride;
    if (at + this.stride > this.data.length) {
      const next = new Float32Array(Math.max(this.data.length * 2, at + this.stride));
      next.set(this.data);
      this.data = next;
    }
    this.count++;
    return at;
  }

  /** The written part, as something that can be handed to `bufferSubData`. */
  view(): Float32Array {
    return this.data.subarray(0, this.count * this.stride);
  }
}

/**
 * dot / circle core: position, radius, premultiply-safe RGBA fill, and a 0..1
 * scale on the outline.
 *
 * The outline colour itself is not per instance: it is a *constant* vertex
 * attribute, which is what keeps a grain down to eight floats. The scalar is
 * what varies — sand wants a rim, water must not have one or its droplets read
 * as beads instead of a puddle.
 */
export const DOT_STRIDE = 8;
export const DOT = { x: 0, y: 1, radius: 2, color: 3, border: 7 } as const;

/** per-circle styling: halo strength, outline RGBA, dash period (0 = solid) */
export const CIRCLE_STYLE_STRIDE = 6;
export const CIRCLE_STYLE = { glow: 0, border: 1, dash: 5 } as const;

export const RECT_STRIDE = 24;
export const RECT = {
  x: 0,
  y: 1,
  halfW: 2,
  halfH: 3,
  radius: 4,
  angle: 5,
  color: 6, // rgba — a is the fill alpha
  shadeTop: 10,
  shadeBottom: 11,
  border: 12, // rgba
  borderW: 16,
  pattern: 17,
  paramX: 18,
  paramY: 19,
  glow: 20,
  patternRgb: 21,
} as const;

/** textured label quad: position, half-size, angle, uv rect */
export const SPRITE_STRIDE = 9;
export const SPRITE = { x: 0, y: 1, halfW: 2, halfH: 3, angle: 4, uv: 5 } as const;

/** triangle soup: position + RGBA, in world px */
export const POLY_STRIDE = 6;

/**
 * Procedural detail drawn inside a rounded rect. The shader switches on this,
 * so a toy costs an instance instead of a hand-written painter branch.
 */
export const PATTERN = {
  none: 0,
  /** inset light stroke — the standard block bevel */
  bevel: 1,
  /** diagonal cross brace: shipping crate */
  crate: 2,
  /** mortar joint across the middle */
  brick: 3,
  /** single grain line */
  plank: 4,
  /** two diagonal glints, clipped to the body */
  glass: 5,
  /** moving chevrons; params carry the phase and the direction */
  belt: 6,
  /** inset white ring */
  note: 7,
  /** inset accent ring */
  spawner: 8,
  /** dashed outline, for the drop preview */
  dash: 9,
} as const;

export type PatternId = (typeof PATTERN)[keyof typeof PATTERN];
