// Pure geometry for shattering a rectangular body into a grid of fragments.
// Kept free of Matter so the maths is unit-testable.

export interface ShardSpec {
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
}

/** How many pieces a body of this size breaks into. */
export function shardGrid(w: number, h: number): { cols: number; rows: number } {
  const cols = Math.max(2, Math.min(4, Math.round(w / 26)));
  const rows = Math.max(2, Math.min(4, Math.round(h / 26)));
  return { cols, rows };
}

/**
 * Lay a grid of rotated shards over a rectangle centred at (cx, cy).
 *
 * `gap` shrinks every shard slightly so the fragments don't start life
 * overlapping each other (overlapping bodies explode apart on the first step).
 */
export function shardLayout(
  cx: number,
  cy: number,
  w: number,
  h: number,
  angle: number,
  cols: number,
  rows: number,
  gap = 0.9,
): ShardSpec[] {
  const shards: ShardSpec[] = [];
  const cellW = w / cols;
  const cellH = h / rows;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      // Offset from the rectangle's centre, in the body's local frame.
      const lx = -w / 2 + (col + 0.5) * cellW;
      const ly = -h / 2 + (row + 0.5) * cellH;

      shards.push({
        x: cx + lx * cos - ly * sin,
        y: cy + lx * sin + ly * cos,
        w: cellW * gap,
        h: cellH * gap,
        angle,
      });
    }
  }

  return shards;
}
