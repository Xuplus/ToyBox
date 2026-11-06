import type Matter from 'matter-js';
import type { GrainMaterial } from '../physics/grains';

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
  | 'noteBlock'
  | 'ballSpawner'
  | 'sandSource'
  | 'waterSource'
  | 'bomb'
  | 'balloon'
  | 'fan'
  | 'trampoline'
  | 'blackHole';

export type ToyKind =
  | 'ball'
  | 'block'
  | 'belt'
  | 'note'
  | 'spawner'
  | 'source'
  | 'bomb'
  | 'balloon'
  | 'fan'
  | 'trampoline'
  | 'hole';

/** A bomb's fuse, in simulated ms - so pausing the box pauses the countdown. */
export interface FuseSpec {
  left: number;
  total: number;
}

/** A fan: wind along the body's "up" (its angle turns it). */
export interface FanSpec {
  /** 1 is a normal fan; scales both the push on bodies and on grains */
  strength: number;
  /** how far the wind carries, world px */
  reach: number;
}

/** A trampoline: what it does to a body that lands on its top face. */
export interface BounceSpec {
  /** minimum speed it throws a body back out at, px/step */
  launch: number;
  /** the fastest it will ever throw anything, px/step */
  max: number;
}

/** A black hole: pulls everything in range and swallows what reaches the core. */
export interface HoleSpec {
  /** world px */
  reach: number;
  /** change of speed per step near the middle, px/step² */
  pull: number;
  /** sideways part of the pull, as a fraction of it: makes things spiral */
  swirl: number;
  /** radius inside which things are gone, world px */
  core: number;
  /** what it has eaten so far (bodies and grains), for the readout */
  ate: number;
}

/** A toy that releases balls on its own - the stress-test workhorse. */
export interface SpawnerSpec {
  /** milliseconds between balls */
  rateMs: number;
  /** the toy it emits; balls only, so the spawn never shatters or rings */
  toy: ToyId;
  /** downward speed given to a fresh ball, px per step */
  speed: number;
  /** random horizontal spread, px per step, centred on zero */
  spread: number;
  /** time owed since the last emission. Mutated by the engine. */
  acc: number;
}

/** A toy that pours a granular material - sand or water - into the box. */
export interface SourceSpec {
  /** which material, see `GRAIN` in `physics/grains.ts` */
  material: GrainMaterial;
  /** grains per second */
  perSecond: number;
  /** downward speed given to a fresh grain, px per step */
  speed: number;
  /** half-width of the mouth stream, world px */
  spread: number;
  /** grains owed since the last emission; fractional. Mutated by the engine. */
  acc: number;
  /** grains already poured, for the readout */
  poured: number;
}

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
  /** ball spawner behaviour */
  spawner?: SpawnerSpec;
  /** granular source behaviour */
  source?: SourceSpec;
  /** impact speed (px/step) above which this body shatters */
  breaksAt?: number;
  /** true for a piece produced by shattering */
  shard?: boolean;
  /** performance.now() of the last strike, for the glow animation */
  hitAt?: number;
  /** bomb: counts down every step, goes off at zero */
  fuse?: FuseSpec;
  /** balloon: upward push per step, as a multiple of gravity */
  lift?: number;
  /** balloon: impact speed (px/step) that pops it */
  popsAt?: number;
  fan?: FanSpec;
  bounce?: BounceSpec;
  hole?: HoleSpec;
  /** a tap (press and release without dragging) turns a static toy by this
   *  many radians - how a fan or a trampoline is aimed */
  turn?: number;
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
  swatch: 'circle' | 'rect' | 'belt' | 'note' | 'spawner';
  /** default footprint, for the cursor ghost */
  w: number;
  h: number;
  build: (x: number, y: number, ctx: SpawnContext) => Matter.Body | Matter.Body[];
}
