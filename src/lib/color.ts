/** Small colour helpers shared by the palette and both renderers. */

export type RGB = readonly [number, number, number];

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
const FUNC = /^rgba?\(([^)]*)\)$/i;

/**
 * Anything a CSS `fillStyle` would accept *from our own code* — `#rrggbb`,
 * `#rgb`, `rgb(...)`, `rgba(...)` — as 8-bit channels.
 *
 * This used to parse hex only, and `shade()` returns `rgb(...)`. So
 * `alpha(shade('#55617a', 0.45), 0.75)` quietly produced `rgba(NaN, …)` and the
 * canvas ignored it, leaving belts and the spout with whatever stroke colour
 * the previous toy happened to leave behind. Both renderers now go through
 * here, so the two paths agree on the colour of every toy.
 */
export function toRgb(color: string): RGB {
  const value = color.trim();

  const hex = HEX.exec(value);
  if (hex) {
    const raw = hex[1];
    const full =
      raw.length === 3
        ? raw
            .split('')
            .map((c) => c + c)
            .join('')
        : raw;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ];
  }

  const fn = FUNC.exec(value);
  if (fn) {
    const parts = fn[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
      return [parts[0], parts[1], parts[2]];
    }
  }

  return [0, 0, 0];
}

/**
 * Mix a colour toward white (positive amount) or black (negative), in place of
 * a hex string.
 */
export function shadeRgb(rgb: RGB, amount: number): RGB {
  const target = amount < 0 ? 0 : 255;
  const p = Math.min(1, Math.abs(amount));
  const mix = (channel: number) => Math.round(channel + (target - channel) * p);
  return [mix(rgb[0]), mix(rgb[1]), mix(rgb[2])];
}

/**
 * Mix a hex colour toward white (positive amount) or black (negative), e.g.
 * `shade('#5b8cff', 0.3)` is a lighter blue. Returns a CSS `rgb()` string.
 */
export function shade(color: string, amount: number): string {
  const [r, g, b] = shadeRgb(toRgb(color), amount);
  return `rgb(${r}, ${g}, ${b})`;
}

/** Same colour with an alpha channel, as a CSS `rgba()` string. */
export function alpha(color: string, a: number): string {
  const [r, g, b] = toRgb(color);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
