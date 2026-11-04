// The label atlas: the only text in the scene.
//
// Note blocks carry a pitch name ("C4", "F#5"…). Text is the one thing a
// fragment shader can't draw, so each distinct label is rasterised once into a
// shared texture and drawn as a textured quad. There are at most a dozen
// distinct labels and they never change per body, so this is a one-off cost —
// no per-glyph atlas, no font loader, no SDF machinery.

export interface LabelCell {
  /** uv rect, 0..1, top-down */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** cell size in atlas px — the quad is this scaled by fontPx → world px */
  w: number;
  h: number;
}

/** What the packer needs from an atlas, and nothing else. */
export interface LabelLookup {
  /** the px size the text was rasterised at */
  fontPx: number;
  cell(text: string): LabelCell | undefined;
}

export interface LabelAtlas extends LabelLookup {
  canvas: HTMLCanvasElement;
  /** padded cell size, before the uvs are normalised */
  cellW: number;
  cellH: number;
}

/** Matches the canvas painter's note label: bold system UI at h*0.5. */
export function labelFont(px: number): string {
  return `700 ${Math.max(1, Math.round(px))}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
}

/** Same colour as `drawNote` writes, so both painters match. */
const LABEL_COLOR = 'rgba(10, 12, 18, 0.78)';

/**
 * Rasterise `labels` at `fontPx` device px into one canvas, stacked vertically.
 * Ten labels at 64 px is ~960 px tall — comfortably inside any texture limit.
 */
export function buildLabelAtlas(labels: readonly string[], fontPx: number): LabelAtlas {
  const canvas = document.createElement('canvas');
  const measure = canvas.getContext('2d');
  const font = labelFont(fontPx);
  const pad = Math.ceil(fontPx * 0.3);
  const cellH = Math.ceil(fontPx * 1.6);

  const cells = new Map<string, LabelCell>();
  if (!measure) {
    return { canvas, fontPx, cellW: 0, cellH, cell: (text) => cells.get(text) };
  }

  measure.font = font;
  let cellW = Math.ceil(fontPx * 1.2);
  for (const label of labels) {
    cellW = Math.max(cellW, Math.ceil(measure.measureText(label).width) + pad * 2);
  }
  const count = Math.max(1, labels.length);
  canvas.width = Math.max(1, cellW);
  canvas.height = Math.max(1, cellH * count);

  const g = canvas.getContext('2d');
  if (!g) {
    return { canvas, fontPx, cellW, cellH, cell: (text) => cells.get(text) };
  }

  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = LABEL_COLOR;

  labels.forEach((label, index) => {
    const top = index * cellH;
    g.fillText(label, cellW / 2, top + cellH / 2 + fontPx * 0.02);
    cells.set(label, {
      u0: 0,
      v0: top / canvas.height,
      u1: 1,
      v1: (top + cellH) / canvas.height,
      w: cellW,
      h: cellH,
    });
  });

  return { canvas, fontPx, cellW, cellH, cell: (text) => cells.get(text) };
}
