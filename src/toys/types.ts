import type Matter from 'matter-js';

export type ToyId =
  | 'ballBouncy'
  | 'ballMarble'
  | 'ballHeavy'
  | 'ballBeach'
  | 'crate'
  | 'plank'
  | 'ramp'
  | 'glass'
  | 'brick'
  | 'beltRight'
  | 'beltLeft'
  | 'noteBlock';

export type ToyKind = 'ball' | 'block' | 'belt' | 'note';

/** Everything the renderer, the conveyor pass and the break logic need to know
 *  about a body that came out of the toy box. */
export interface ToyMeta {
  toyId: ToyId;
  kind: ToyKind;
  /** body fill colour, also used for the palette swatch */
  color: string;
  /** lighter/darker companion colour for gradients */
  accent: string;
  /** footprint the body was built from, in px (shards inherit the parent's) */
  w: number;
  h: number;
  /** how the body is drawn; rectangles are the default */
  shape?: 'rect' | 'poly';
  /** short text drawn on the body (note blocks) */
  label?: string;
  /** sounding pitch of a note block */
  midi?: number;
  /** conveyor carry behaviour */
  belt?: { dir: 1 | -1; speed: number };
  /** impact speed (px/step) above which this body shatters */
  breaksAt?: number;
  /** true for a piece produced by shattering */
  shard?: boolean;
  /** performance.now() of the last strike, for the glow animation */
  hitAt?: number;
}

/** Per-spawn context: the note block needs its place in the scale. */
export interface SpawnContext {
  noteIndex: number;
}

export interface ToyDef {
  id: ToyId;
  kind: ToyKind;
  /** i18n key for the palette label */
  nameKey: string;
  color: string;
  accent: string;
  /** shape of the palette swatch */
  swatch: 'circle' | 'rect' | 'belt' | 'note';
  /** default footprint, for the cursor ghost */
  w: number;
  h: number;
  build: (x: number, y: number, ctx: SpawnContext) => Matter.Body | Matter.Body[];
}
