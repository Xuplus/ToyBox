import { describe, expect, it } from 'vitest';
import { SCALE, midiToHz, noteForIndex, noteName } from './notes';

describe('noteForIndex', () => {
  it('starts at the bottom of the scale', () => {
    expect(noteForIndex(0)).toBe(SCALE[0]);
  });

  it('walks up one degree per note', () => {
    expect(noteForIndex(1)).toBe(SCALE[1]);
    expect(noteForIndex(5)).toBe(SCALE[5]);
  });

  it('wraps around the scale', () => {
    expect(noteForIndex(SCALE.length)).toBe(SCALE[0]);
    expect(noteForIndex(SCALE.length + 2)).toBe(SCALE[2]);
  });

  it('handles negative indices', () => {
    expect(noteForIndex(-1)).toBe(SCALE[SCALE.length - 1]);
  });
});

describe('noteName', () => {
  it('names middle C', () => {
    expect(noteName(60)).toBe('C4');
  });

  it('names concert A', () => {
    expect(noteName(69)).toBe('A4');
  });

  it('handles sharps', () => {
    expect(noteName(61)).toBe('C#4');
  });

  it('crosses the octave boundary', () => {
    expect(noteName(72)).toBe('C5');
    expect(noteName(81)).toBe('A5');
  });
});

describe('midiToHz', () => {
  it('maps A4 to 440 Hz', () => {
    expect(midiToHz(69)).toBeCloseTo(440, 6);
  });

  it('doubles frequency per octave', () => {
    expect(midiToHz(81)).toBeCloseTo(880, 6);
  });
});
