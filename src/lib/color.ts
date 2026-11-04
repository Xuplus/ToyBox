/** Small colour helpers shared by the palette and the canvas renderer. */

function parse(hex: string): [number, number, number] {
  const raw = hex.replace('#', '');
  return [
    parseInt(raw.slice(0, 2), 16),
    parseInt(raw.slice(2, 4), 16),
    parseInt(raw.slice(4, 6), 16),
  ];
}

/**
 * Mix a hex colour toward white (positive amount) or black (negative), e.g.
 * `shade('#5b8cff', 0.3)` is a lighter blue. Returns a CSS `rgb()` string.
 */
export function shade(hex: string, amount: number): string {
  const [r, g, b] = parse(hex);
  const target = amount < 0 ? 0 : 255;
  const p = Math.min(1, Math.abs(amount));
  const mix = (channel: number) => Math.round(channel + (target - channel) * p);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

/** Same colour with an alpha channel, as a CSS `rgba()` string. */
export function alpha(hex: string, a: number): string {
  const [r, g, b] = parse(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
