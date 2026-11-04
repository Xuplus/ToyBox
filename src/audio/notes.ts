// Musical material for the note blocks. Pure data + helpers so the note
// selection is testable without a browser audio context.

/** C major pentatonic across two octaves — pleasant in any order, no wrong notes. */
export const SCALE: readonly number[] = [60, 62, 64, 67, 69, 72, 74, 76, 79, 81];

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Pick the scale degree for the nth spawned note block (cycles forever). */
export function noteForIndex(index: number): number {
  const n = SCALE.length;
  return SCALE[((index % n) + n) % n];
}

/** MIDI number → display name such as "C4" or "F#5". */
export function noteName(midi: number): string {
  const pc = ((Math.round(midi) % 12) + 12) % 12;
  const octave = Math.floor(Math.round(midi) / 12) - 1;
  return NAMES[pc] + octave;
}

/** MIDI number → frequency in Hz (A4 = 69 = 440 Hz). */
export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
