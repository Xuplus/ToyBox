import { describe, expect, it } from 'vitest';
import { alpha, shade, shadeRgb, toRgb } from './color';

describe('toRgb', () => {
  it('parses the six-digit hex the toy catalog uses', () => {
    expect(toRgb('#ff6b8b')).toEqual([255, 107, 139]);
    expect(toRgb('ff6b8b')).toEqual([255, 107, 139]);
  });

  it('expands three-digit hex', () => {
    expect(toRgb('#abc')).toEqual([170, 187, 204]);
  });

  it('parses rgb() and rgba(), which is what shade() produces', () => {
    expect(toRgb('rgb(160, 174, 192)')).toEqual([160, 174, 192]);
    expect(toRgb('rgba(10, 12, 18, 0.78)')).toEqual([10, 12, 18]);
    expect(toRgb('rgb(1 2 3 / 50%)')).toEqual([1, 2, 3]);
  });

  it('falls back to black rather than NaN', () => {
    expect(toRgb('not a colour')).toEqual([0, 0, 0]);
    expect(toRgb('')).toEqual([0, 0, 0]);
  });
});

describe('shade', () => {
  it('mixes toward white and black', () => {
    expect(shade('#000000', 0.5)).toBe('rgb(128, 128, 128)');
    expect(shade('#ffffff', -0.5)).toBe('rgb(128, 128, 128)');
    expect(shade('#5b8cff', 0)).toBe('rgb(91, 140, 255)');
  });

  it('clamps the amount', () => {
    expect(shade('#204060', 4)).toBe('rgb(255, 255, 255)');
    expect(shade('#204060', -4)).toBe('rgb(0, 0, 0)');
  });
});

describe('alpha', () => {
  it('applies an alpha to a hex colour', () => {
    expect(alpha('#55617a', 0.75)).toBe('rgba(85, 97, 122, 0.75)');
  });

  // Regression: `shade()` returns `rgb(...)`, and the toy metadata feeds those
  // straight back into `alpha()` for belt and spout accents. Parsing hex only
  // produced `rgba(NaN, …)`, which the canvas silently ignored — so those toys
  // were drawn with whatever stroke colour the previous body left behind.
  it('accepts the rgb() string that shade() returns', () => {
    expect(alpha(shade('#55617a', 0.45), 0.75)).toBe('rgba(162, 168, 182, 0.75)');
  });
});

describe('shadeRgb', () => {
  it('agrees with shade()', () => {
    const rgb = shadeRgb(toRgb('#c98b5a'), -0.55);
    expect(shade('#c98b5a', -0.55)).toBe(`rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`);
  });
});
