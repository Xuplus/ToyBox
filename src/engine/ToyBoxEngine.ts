import Matter from 'matter-js';
import type { Synth } from '../audio/synth';
import { FrameMeter } from '../lib/frame-meter';
import { carryBodies } from '../physics/conveyor';
import {
  blastSpeed,
  direction,
  falloff,
  holePull,
  launchVelocity,
  liftSpeed,
  windAt,
  windDelta,
} from '../physics/fields';
import {
  bodyResponse,
  GRAIN,
  GrainWorld,
  scatterGrains,
  type GrainCollider,
  type GrainMaterial,
} from '../physics/grains';
import { shardGrid, shardLayout } from '../physics/shatter';
import { planEmissions } from '../physics/spawner';
import { jointGap } from '../physics/rope';
import {
  clampIntoBounds,
  CONSTRAINT_ITERATIONS,
  createWorld,
  removeBody,
  resizeWorld,
  STEP_MS,
} from '../physics/world';
import { makePin, toyById } from '../toys/catalog';
import { countsAsToy, metaOf, setMeta } from '../toys/meta';
import { tiePoint, tieRope } from '../toys/tie';
import type { RopeSpec, ToyDef, ToyId } from '../toys/types';
import { createPainter } from './painter';
import type { Effect, Ghost, Painter, Scene, Tether } from './scene';

export type Tool = 'drag' | 'delete' | ToyId;

/** Hard cap on bodies. A spawner nobody turns off is the only realistic way to
 *  get here; the measured frame cost at 2000 bodies is roughly 40 fps on a
 *  60 Hz display, which is slow but still interactive, so the tab survives. */
const MAX_BODIES = 2000;
/** Hard cap on grains. A source nobody turns off is the only way here, and the
 *  ceiling is memory rather than frame time: settled grains sleep, so a full
 *  box of sand is close to free. */
const MAX_GRAINS = 12000;
/** Radius of the delete tool's bite into a sand pile, in world px. */
const ERASE_RADIUS = 22;
/** Impact speed (px/step) below which a note block stays quiet. */
const NOTE_THRESHOLD = 1.2;
/** Minimum gap between two sounds from the same block, in ms. */
const NOTE_COOLDOWN = 70;
/** Impact speed (px/step) that sets a bomb off before its fuse has burnt down.
 *  A drop from most of the way up a normal box, or a hard throw. */
const BOMB_TOUCHY = 22;
/** How far a blast reaches, world px. */
const BLAST_RADIUS = 200;
/** Speed (px/step) a blast gives a body of mass 1 right next to it. */
const BLAST_STRENGTH = 26;
/** Grains a blast simply removes, world px around the bomb. */
const BLAST_CRATER = 34;
/** Outward speed (px/step) a blast gives the grains next to it. */
const BLAST_GRAINS = 9;
/** Delay before a bomb caught in another bomb's blast goes off, ms. */
const CHAIN_MS = 110;
/** Wind on grains: push per step and the speed of the air, at strength 1. */
const GRAIN_WIND = 0.55;
const GRAIN_AIR = 7;
/** A black hole's pull on grains: inward and sideways, px/step² at its middle. */
const GRAIN_PULL = 0.7;
const GRAIN_SWIRL = 0.3;
/** Half-width of a fan's air column, as a fraction of the fan's width. */
const FAN_SPREAD = 0.7;
/** A sleeping body near a gadget is woken once the push on it is this big. */
const WAKE_PUSH = 0.05;
/** Gaps between two of the same gadget sound, ms. */
const GULP_COOLDOWN = 90;
const BOING_COOLDOWN = 60;
/** A press that moves less than this (css px) is a tap: it turns a fan or a
 *  trampoline instead of dragging it. */
const TAP_SLOP = 5;
/** A constraint setting tuned at Matter's default of two passes, as the same
 *  pull over the passes the world runs now (see `CONSTRAINT_ITERATIONS`). */
const perPass = (atTwo: number) => 1 - Math.pow(1 - atTwo, 2 / CONSTRAINT_ITERATIONS);
/** The drag constraint: 0.16 stiffness and 0.1 damping, at two passes. */
const DRAG_STIFFNESS = perPass(0.16);
const DRAG_DAMPING = perPass(0.1);
/** A rope shorter than this (css px) is a tap, not a rope. */
const ROPE_MIN = 16;
/** How close (css px) a press has to be to a thin rope link to pick it up. */
const LINK_PICK = 7;
/** How often the FPS readout is pushed to React, in ms. Fast enough to feel
 *  live, slow enough that the readout can't become part of the problem. */
const STAT_EVERY = 250;
/** Playfield multipliers offered by the size control (world px per css px). */
export const PLAYFIELD_SIZES = [1, 1.5, 2, 2.5] as const;

/** Throughput knobs used by the benchmark harness. */
export interface Tuning {
  sleeping?: boolean;
  positionIterations?: number;
  velocityIterations?: number;
  sprites?: boolean;
}

/** A snapshot of what the box is costing, pushed to the UI a few times a second. */
export interface PerfStats {
  /** frames per second at the median frame time */
  fps: number;
  /** the slow tail: fps at the 95th percentile frame */
  fpsLow: number;
  /** mean wall-clock frame time in ms, idle wait for vsync included */
  frameMs: number;
  /** mean main-thread cost of the physics steps in a frame, ms */
  physicsMs: number;
  /** mean main-thread cost of one canvas redraw, ms */
  drawMs: number;
  bodies: number;
  toys: number;
  /** grains in the box (a subset of `bodies`) */
  grains: number;
  /** how many of those moved last step - the part that costs anything */
  grainsAwake: number;
  /** which painter is running - `webgl` unless the browser refused one */
  renderer: Painter['kind'];
}

export interface EngineCallbacks {
  /** Fired when the toy count changes. `toys` excludes shards, `bodies` is
   *  everything in the box (used to tell "empty" from "only debris"). */
  onCount: (toys: number, bodies: number) => void;
  /** Fired on the first user gesture - used to dismiss the hint. */
  onFirstInteraction: () => void;
  /** Fired every `STAT_EVERY` ms with the performance readout. */
  onStats: (stats: PerfStats) => void;
}

interface DragState {
  body: Matter.Body;
  /** null for static bodies, which are moved directly instead */
  constraint: Matter.Constraint | null;
  offset: Matter.Vector;
  /** where the press started, world px - a tap is a press that stays put */
  start: Matter.Vector;
  /** true once the pointer has gone further than `TAP_SLOP` */
  moved: boolean;
}

/** A body that touched a trampoline this step, and how fast it was coming. */
interface Landing {
  body: Matter.Body;
  pad: Matter.Body;
  vx: number;
  vy: number;
}

/**
 * A rigid body, in the shape the granular layer expects. The pool is rebuilt
 * in place every step - the wrapped objects are reused, so the solver never
 * sees an allocation.
 */
interface BodyCollider extends GrainCollider {
  body: Matter.Body;
  surface: { x: number; y: number };
}

export class ToyBoxEngine {
  private readonly painter: Painter;
  private world = createWorld(1, 1);
  private bodies: Matter.Body[] = [];
  private tool: Tool = 'drag';
  private paused = false;
  private drag: DragState | null = null;
  private pointer: Matter.Vector = { x: 0, y: 0 };
  private pointerInside = false;
  private cursor = '';
  /** css size of the canvas */
  private view = { w: 1, h: 1 };
  /** world px per css px - the playfield control zooms the box, not the canvas */
  private scale = 1;
  /** simulated box size, `view * scale` */
  private size = { w: 1, h: 1 };
  private time = 0;
  private last = 0;
  private acc = 0;
  private raf = 0;
  private noteCounter = 0;
  private seeded = false;
  private destroyed = false;
  private readonly meter = new FrameMeter();
  private physicsMs = 0;
  private drawMs = 0;
  private statAcc = 0;
  /** device px per world px, i.e. the canvas transform scale */
  private pixelRatio = 1;
  private sprites = true;
  /** The granular layer. Created on first use, and it survives every resize. */
  private grainWorld: GrainWorld | null = null;
  /** Rigid bodies, wrapped once each and refilled every step. */
  private readonly colliderPool: BodyCollider[] = [];
  private readonly colliderView: BodyCollider[] = [];
  /** true while the delete tool is being dragged through the box */
  private erasing = false;
  /** flashes still on screen */
  private effects: Effect[] = [];
  /** trampoline contacts from this step's collisions, applied after it */
  private landings: Landing[] = [];
  /** bombs that were hit hard enough to go off, handled after the update */
  private fused: Matter.Body[] = [];
  /** the gadgets, gathered once per step */
  private readonly fans: Matter.Body[] = [];
  private readonly holes: Matter.Body[] = [];
  private readonly bombs: Matter.Body[] = [];
  private lastGulp = -Infinity;
  /** every rope and chain joint in the box, with how far it opens before it snaps */
  private joints: { joint: Matter.Constraint; snapAt: number }[] = [];
  /** the first end of a rope being tied; `armed` once the press that set it is
   *  over, so the next release ties the other end */
  private ropeStart: { body: Matter.Body | null; point: Matter.Vector; armed: boolean } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly synth: Synth,
    private readonly callbacks: EngineCallbacks,
  ) {
    this.painter = createPainter(canvas);

    Matter.Events.on(this.world.engine, 'collisionStart', this.onCollision);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
  }

  // --- lifecycle ---------------------------------------------------------

  start(): void {
    if (this.destroyed || this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;

    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);

    Matter.Events.off(this.world.engine, 'collisionStart', this.onCollision);
    this.endDrag();
    Matter.Engine.clear(this.world.engine);
    this.painter.dispose();
  }

  resize(width: number, height: number): void {
    this.view = {
      w: Math.max(1, Math.round(width)),
      h: Math.max(1, Math.round(height)),
    };
    this.applyScale();
  }

  /**
   * How many world pixels fit in one css pixel. 1 is the default; 2.5 gives a
   * box two and a half times as wide and tall in the same space on screen, so
   * there is room for a lot more stuff before it piles up.
   */
  setScale(scale: number): void {
    const next = Math.min(Math.max(scale, 0.5), 4);
    if (next === this.scale) return;
    this.scale = next;
    this.applyScale();
  }

  get playfieldScale(): number {
    return this.scale;
  }

  /** Simulated box size in world px. */
  get bounds(): { w: number; h: number } {
    return { w: this.size.w, h: this.size.h };
  }

  /** Debug/benchmark helper: drop one toy at a world coordinate. */
  placeToy(id: ToyId, x: number, y: number): void {
    const toy = toyById(id);
    if (toy) this.spawn(toy, { x, y });
  }

  /** Re-derive the backing store, the world size and the walls from `view`+`scale`. */
  private applyScale(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { w, h } = this.view;

    // The painter owns the drawing buffer; the zoom and the device pixel ratio
    // reach it through each frame's `Scene`.
    this.painter.resize(w * dpr, h * dpr);
    this.pixelRatio = dpr / this.scale;

    const worldW = Math.max(1, Math.round(w * this.scale));
    const worldH = Math.max(1, Math.round(h * this.scale));
    if (worldW === this.size.w && worldH === this.size.h) return;

    this.size = { w: worldW, h: worldH };
    resizeWorld(this.world, worldW, worldH);
    // The grains keep their positions; the box they are in changed shape.
    this.grainWorld?.resize(worldW, worldH);
  }

  // --- public controls ---------------------------------------------------

  setTool(tool: Tool): void {
    this.tool = tool;
    this.ropeStart = null;
    this.updateCursor(this.pointer);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  setMuted(muted: boolean): void {
    this.synth.setMuted(muted);
  }

  clear(): void {
    this.endDrag();
    this.ropeStart = null;
    for (const { joint } of this.joints) Matter.Composite.remove(this.world.engine.world, joint);
    this.joints.length = 0;
    for (const body of [...this.bodies]) this.remove(body);
    this.grainWorld?.clear();
    this.effects.length = 0;
    this.landings.length = 0;
    this.fused.length = 0;
    this.noteCounter = 0;
    this.emitCount();
  }

  /**
   * The granular layer, created on first use at the current box size. Passing a
   * different radius rebuilds it, because the uniform grid is sized from it.
   */
  private ensureGrains(radius?: number): GrainWorld {
    const existing = this.grainWorld;
    if (existing && (radius === undefined || existing.options.radius === radius)) return existing;

    const world = new GrainWorld(MAX_GRAINS, this.size.w, this.size.h, { radius });
    this.grainWorld = world;
    return world;
  }

  /**
   * Benchmark helper: fill the box with `n` grains of one material, replacing
   * whatever was there. Reached through `?bench` (`__toybox.grains(n)`), not by
   * playing - the toy pours its grains from a source instead.
   */
  spawnGrains(n: number, radius = 5, kind: GrainMaterial = GRAIN.sand): number {
    const world = this.ensureGrains(radius);
    world.clear();
    const added = scatterGrains(world, n, 1, kind);
    this.emitCount();
    return added;
  }

  /** Suppress the starter scene - a benchmark wants a known box. */
  skipSeed(): void {
    this.seeded = true;
  }

  /** A small starter scene, so the box is never a cold empty page. */
  seed(): void {
    if (this.seeded) return;
    this.seeded = true;

    const { w, h } = this.size;
    if (w < 240 || h < 260) return;

    const belt = toyById('beltRight');
    const note = toyById('noteBlock');
    const bouncy = toyById('ballBouncy');
    const marble = toyById('ballMarble');
    const beach = toyById('ballBeach');
    const crate = toyById('crate');
    const balloon = toyById('balloon');
    if (!belt || !note || !bouncy || !marble || !beach || !crate || !balloon) return;

    this.spawn(belt, { x: w * 0.72, y: h - 40 });
    this.spawn(note, { x: w * 0.26, y: h - 42 });
    this.spawn(crate, { x: w * 0.72, y: h - 78 });
    // Clear of the intro hint at the top of the canvas.
    this.spawn(bouncy, { x: w * 0.36, y: 100 });
    this.spawn(marble, { x: w * 0.52, y: 150 });
    this.spawn(beach, { x: w * 0.63, y: 108 });
    // It floats up on its own, which says "gadgets" before anyone reads a label.
    this.spawn(balloon, { x: w * 0.12, y: h - 60 });
  }

  // --- simulation --------------------------------------------------------

  private loop = (now: number): void => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.loop);

    const raw = now - this.last;
    this.last = now;

    // The meter sees the real frame delta; the simulation only ever sees a
    // clamped one, so a stall (or a hidden tab) can't teleport the bodies.
    this.meter.push(raw);
    const dt = Math.min(raw, 100);
    this.time += dt;

    const started = performance.now();

    if (!this.paused) {
      this.acc = Math.min(this.acc + dt, STEP_MS * 5);
      while (this.acc >= STEP_MS) {
        this.step();
        this.acc -= STEP_MS;
      }
    }

    const stepped = performance.now();
    this.draw();
    const drawn = performance.now();

    // EMAs: the readout should show a trend, not one unlucky frame.
    this.physicsMs += (stepped - started - this.physicsMs) * 0.1;
    this.drawMs += (drawn - stepped - this.drawMs) * 0.1;

    this.statAcc += raw;
    if (this.statAcc >= STAT_EVERY) {
      this.statAcc = 0;
      this.callbacks.onStats(this.stats());
    }
  };

  private step(): void {
    this.spawnFromSpawners(STEP_MS);
    this.pourSources(STEP_MS);
    this.applyFields();
    carryBodies(this.bodies);
    Matter.Engine.update(this.world.engine, STEP_MS);
    this.snapJoints();
    this.launchLandings();
    this.evictEscaped();
    this.burnFuses(STEP_MS);
    this.feedHoles();
    this.stepGrains();
  }

  // --- gadgets -----------------------------------------------------------
  //
  // The bomb, balloon, fan, trampoline and black hole. The maths is in
  // `physics/fields.ts`; this is the part that loops over bodies and grains.
  // Every push here is a change of speed handed to Matter as a force before
  // the update, so it is integrated with gravity on the one simulation clock.

  /** Turn a change of speed this step (px/step) into the force Matter wants. */
  private nudge(body: Matter.Body, dvx: number, dvy: number): void {
    const k = body.mass / (STEP_MS * STEP_MS);
    body.force.x += dvx * k;
    body.force.y += dvy * k;
    if (body.isSleeping && Math.abs(dvx) + Math.abs(dvy) > WAKE_PUSH) Matter.Sleeping.set(body, false);
  }

  /** Balloon lift, fan wind and black-hole pull, on bodies and on grains. */
  private applyFields(): void {
    const fans = this.fans;
    const holes = this.holes;
    const bombs = this.bombs;
    fans.length = 0;
    holes.length = 0;
    bombs.length = 0;

    for (const body of this.bodies) {
      const meta = metaOf(body);
      if (!meta) continue;
      if (meta.fan) fans.push(body);
      else if (meta.hole) holes.push(body);
      else if (meta.fuse) bombs.push(body);
      if (meta.lift !== undefined && !body.isStatic) this.nudge(body, 0, -liftSpeed(meta.lift));
    }
    if (fans.length === 0 && holes.length === 0) return;

    for (const fan of fans) {
      const meta = metaOf(fan);
      const spec = meta?.fan;
      if (!meta || !spec) continue;
      // A fan blows along its own "up", out of its front face.
      const dirX = Math.sin(fan.angle);
      const dirY = -Math.cos(fan.angle);
      const ox = fan.position.x + (dirX * meta.h) / 2;
      const oy = fan.position.y + (dirY * meta.h) / 2;
      // The air column is a little wider than the fan, or a ball blown
      // sideways drops out of it before it has gone anywhere.
      const half = meta.w * FAN_SPREAD;

      for (const body of this.bodies) {
        if (body.isStatic) continue;
        const dx = body.position.x - ox;
        const dy = body.position.y - oy;
        const f = windAt(dx * dirX + dy * dirY, dx * -dirY + dy * dirX, spec.reach, half);
        if (f <= 0) continue;
        const along = body.velocity.x * dirX + body.velocity.y * dirY;
        const dv = windDelta(f, spec.strength, body.area, body.mass, along);
        if (dv > 0) this.nudge(body, dirX * dv, dirY * dv);
      }

      this.grainWorld?.blow(ox, oy, dirX, dirY, spec.reach, half, GRAIN_WIND * spec.strength, GRAIN_AIR * spec.strength);
    }

    for (const hole of holes) {
      const spec = metaOf(hole)?.hole;
      if (!spec) continue;
      const { x, y } = hole.position;

      for (const body of this.bodies) {
        if (body.isStatic || body === this.drag?.body) continue;
        const pull = holePull(body.position.x - x, body.position.y - y, spec.reach, spec.pull, spec.swirl);
        if (pull.x !== 0 || pull.y !== 0) this.nudge(body, pull.x, pull.y);
      }

      // `push` is outward-positive with its tangent the other way round from
      // `holePull`'s, so both signs flip to make grains swirl the same way.
      this.grainWorld?.push(x, y, spec.reach, -GRAIN_PULL * spec.pull, -GRAIN_SWIRL * spec.swirl);
    }
  }

  /** Whatever reaches a black hole's core is gone: bodies and grains alike. */
  private feedHoles(): void {
    if (this.holes.length === 0) return;
    let eaten = 0;

    for (const hole of this.holes) {
      const meta = metaOf(hole);
      const spec = meta?.hole;
      if (!meta || !spec || !this.bodies.includes(hole)) continue;
      const { x, y } = hole.position;

      let gone: Matter.Body[] | null = null;
      for (const body of this.bodies) {
        if (body.isStatic || body === this.drag?.body) continue;
        const other = metaOf(body);
        // A body is in once its middle is a quarter of its size past the rim.
        const size = other ? Math.min(other.w, other.h) : 10;
        const reach = spec.core + size / 4;
        const dx = body.position.x - x;
        const dy = body.position.y - y;
        if (dx * dx + dy * dy < reach * reach) (gone ??= []).push(body);
      }

      // A grain is in once it overlaps the core, not once its middle is.
      const sand = this.grainWorld;
      const grains = sand ? sand.removeIn(x, y, spec.core + sand.options.radius) : 0;
      if (!gone && grains === 0) continue;

      for (const body of gone ?? []) {
        const other = metaOf(body);
        this.addEffect('gulp', x, y, Math.max(spec.core, 18), other?.color ?? meta.accent, 420);
        this.remove(body);
      }
      const count = (gone?.length ?? 0) + grains;
      spec.ate += count;
      eaten += count;
      meta.hitAt = this.time;
      if (gone && this.time - this.lastGulp > GULP_COOLDOWN) {
        this.lastGulp = this.time;
        this.synth.gulp();
      }
    }

    if (eaten > 0) this.emitCount();
  }

  /** Burn every fuse down a step; bombs that reach zero go off. */
  private burnFuses(dt: number): void {
    let due: Matter.Body[] | null = this.fused.length > 0 ? this.fused.splice(0) : null;

    for (const bomb of this.bombs) {
      const fuse = metaOf(bomb)?.fuse;
      if (!fuse) continue;
      fuse.left -= dt;
      if (fuse.left <= 0 && !due?.includes(bomb)) (due ??= []).push(bomb);
    }

    if (!due) return;
    for (const bomb of due) {
      // A chain reaction can have removed it already.
      if (this.bodies.includes(bomb)) this.detonate(bomb);
    }
    this.emitCount();
  }

  /**
   * A bomb goes off: everything near it is thrown outward, glass and brick
   * break, balloons pop, other bombs are set off a moment later, note blocks
   * ring, and a crater is blown in any sand.
   */
  private detonate(bomb: Matter.Body): void {
    const { x, y } = bomb.position;
    this.remove(bomb);
    this.addEffect('blast', x, y, BLAST_RADIUS, '#ff8a3d', 700);
    this.synth.boom();

    const breaking: Matter.Body[] = [];
    const popping: Matter.Body[] = [];

    for (const body of this.bodies) {
      const meta = metaOf(body);
      const dx = body.position.x - x;
      const dy = body.position.y - y;
      // Measure to the near side of a big body, not its middle.
      const size = meta ? Math.min(meta.w, meta.h) / 2 : 0;
      const dist = Math.max(0, Math.hypot(dx, dy) - size);
      if (dist >= BLAST_RADIUS) continue;

      if (meta?.kind === 'note') this.strike(body, 6);
      if (body.isStatic) continue;

      if (meta?.fuse) meta.fuse.left = Math.min(meta.fuse.left, CHAIN_MS + Math.random() * CHAIN_MS);
      if (meta?.popsAt !== undefined) {
        popping.push(body);
        continue;
      }

      const speed = blastSpeed(dist, BLAST_RADIUS, BLAST_STRENGTH, body.mass);
      const dir = direction(x, y, body.position.x, body.position.y);
      Matter.Sleeping.set(body, false);
      Matter.Body.setVelocity(body, {
        x: body.velocity.x + dir.x * speed,
        // A little extra lift, so a blast on the floor throws things up.
        y: body.velocity.y + dir.y * speed - speed * 0.2,
      });
      Matter.Body.setAngularVelocity(
        body,
        body.angularVelocity + (Math.random() - 0.5) * 0.5 * falloff(dist, BLAST_RADIUS),
      );
      if (meta?.breaksAt !== undefined && speed > 4) breaking.push(body);
    }

    for (const body of popping) this.pop(body);
    for (const body of breaking) if (this.bodies.includes(body)) this.shatter(body);

    const grains = this.grainWorld;
    if (grains && grains.count > 0) {
      grains.removeIn(x, y, BLAST_CRATER);
      grains.push(x, y, BLAST_RADIUS * 0.85, BLAST_GRAINS);
    }
  }

  /** A balloon pops: gone with a bang, leaving a few scraps of rubber. */
  private pop(body: Matter.Body): void {
    const meta = metaOf(body);
    if (!meta || !this.bodies.includes(body)) return;
    const { x, y } = body.position;
    const vx = body.velocity.x;
    const vy = body.velocity.y;
    this.remove(body);
    this.addEffect('pop', x, y, meta.w * 0.75, meta.color, 260);
    this.synth.pop();

    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.random();
      const px = x + Math.cos(a) * meta.w * 0.25;
      const py = y + Math.sin(a) * meta.w * 0.25;
      const scrap = Matter.Bodies.rectangle(px, py, 9, 5, {
        angle: Math.random() * Math.PI,
        friction: 0.6,
        frictionAir: 0.04,
        restitution: 0.1,
        density: 0.001,
      });
      Matter.Body.setVelocity(scrap, { x: vx + Math.cos(a) * 2.5, y: vy + Math.sin(a) * 2.5 - 1 });
      Matter.Body.setAngularVelocity(scrap, (Math.random() - 0.5) * 0.4);
      setMeta(scrap, {
        toyId: meta.toyId,
        kind: 'block',
        color: meta.color,
        accent: meta.accent,
        w: 9,
        h: 5,
        shard: true,
      });
      this.add(scrap);
    }
    this.emitCount();
  }

  /**
   * Throw back out whatever landed on a trampoline this step. It is done after
   * the update because Matter's contact solver runs after `collisionStart` and
   * would overwrite a velocity set in the handler.
   */
  private launchLandings(): void {
    if (this.landings.length === 0) return;
    for (const { body, pad, vx, vy } of this.landings) {
      const meta = metaOf(pad);
      const bounce = meta?.bounce;
      if (!meta || !bounce || !this.bodies.includes(body)) continue;

      const normal = { x: Math.sin(pad.angle), y: -Math.cos(pad.angle) };
      const v = launchVelocity(normal, { x: vx, y: vy }, bounce.launch, bounce.max);
      Matter.Sleeping.set(body, false);
      Matter.Body.setVelocity(body, v);

      if (meta.hitAt === undefined || this.time - meta.hitAt > BOING_COOLDOWN) {
        this.synth.boing(Math.min(1, 0.35 + Math.hypot(vx, vy) / 30));
      }
      meta.hitAt = this.time;
    }
    this.landings.length = 0;
  }

  private addEffect(kind: Effect['kind'], x: number, y: number, radius: number, color: string, life: number): void {
    this.effects.push({ kind, x, y, born: this.time, life, radius, color });
    // A spout feeding a black hole should not be able to grow this for ever.
    if (this.effects.length > 64) this.effects.shift();
  }

  // --- granular layer ----------------------------------------------------

  /**
   * One grain step, then hand the bodies back what the pile did to them.
   *
   * Matter clears `force`/`torque` at the end of every update, so the load is
   * integrated on the *next* step - a 16 ms delay that nothing can see. The
   * velocity changes are applied straight to the body, because an impulse that
   * arrives a step late is a spring with a delay in it, and that is what used
   * to make a dune throw a ball back out.
   */
  private stepGrains(): void {
    const grains = this.grainWorld;
    if (!grains) return;

    this.buildColliders();
    grains.step(this.colliderView);

    for (let i = 0; i < this.colliderView.length; i++) {
      const body = this.colliderView[i].body;
      if (body.isStatic || grains.contacts[i] === 0) continue;

      // Sand holds the body up where it is standing, water only drags at it.
      const out = bodyResponse(grains, i, body);
      if (out.vx !== body.velocity.x || out.vy !== body.velocity.y) {
        Matter.Body.setVelocity(body, { x: out.vx, y: out.vy });
      }
      if (out.w !== body.angularVelocity) Matter.Body.setAngularVelocity(body, out.w);
      body.force.x += out.fx;
      body.force.y += out.fy;
      body.torque += out.torque;
    }
  }

  /**
   * Wrap every body for the granular layer. The pool is indexed by position in
   * `this.bodies`, so a steady box reuses the same wrapper objects for ever.
   */
  private buildColliders(): void {
    this.colliderView.length = 0;
    // Rope links go last: the grain pass takes at most `MAX_COLLIDERS`, and a
    // few long ropes must not push the crates out of it.
    for (const body of this.bodies) {
      // Grains fall into a black hole; they do not stand on it.
      if (!body.isSensor && metaOf(body)?.kind !== 'link') this.wrapCollider(body);
    }
    for (const body of this.bodies) {
      if (metaOf(body)?.kind === 'link') this.wrapCollider(body);
    }
  }

  private wrapCollider(body: Matter.Body): void {
    const view = this.colliderView;
    const pool = this.colliderPool;
    let collider = pool[view.length];
    if (!collider) {
      collider = {
        body,
        vertices: body.vertices,
        bounds: body.bounds,
        position: body.position,
        isStatic: body.isStatic,
        mass: body.mass,
        velocity: body.velocity,
        angularVelocity: body.angularVelocity,
        surface: { x: 0, y: 0 },
      };
      pool[view.length] = collider;
    }

    collider.body = body;
    collider.vertices = body.vertices;
    collider.bounds = body.bounds;
    collider.position = body.position;
    collider.isStatic = body.isStatic;
    collider.mass = body.mass;
    collider.velocity = body.velocity;
    collider.angularVelocity = body.angularVelocity;

    const belt = metaOf(body)?.belt;
    collider.surface.x = belt ? belt.dir * belt.speed : 0;
    collider.surface.y = 0;

    view.push(collider);
  }

  /**
   * Release what the sources owe this step. Emission is capped twice: a stall
   * must not dump a bucket in one step, and the box must not overflow.
   */
  private pourSources(dt: number): void {
    for (const body of this.bodies) {
      const meta = metaOf(body);
      const source = meta?.source;
      if (!source || !meta) continue;

      source.acc += (source.perSecond * dt) / 1000;
      let due = Math.floor(source.acc);
      if (due <= 0) continue;
      source.acc -= due;
      if (due > 64) due = 64;

      const grains = this.ensureGrains();
      if (grains.count >= grains.capacity) {
        source.acc = 0;
        continue;
      }
      due = Math.min(due, grains.capacity - grains.count);

      // The mouth is the bottom edge of the hopper: one grain radius clear of
      // its own collider, so a fresh grain is never born inside the housing.
      const radius = grains.options.radius;
      const offset = meta.h / 2 + radius + 1;
      const cos = Math.cos(body.angle);
      const sin = Math.sin(body.angle);
      const mouthX = body.position.x - offset * sin;
      const mouthY = body.position.y + offset * cos;

      for (let i = 0; i < due; i++) {
        grains.add(
          mouthX + (Math.random() - 0.5) * 2 * source.spread,
          mouthY + Math.random() * 3,
          (Math.random() - 0.5) * 0.6,
          source.speed + Math.random() * 0.4,
          source.material,
        );
      }
      source.poured += due;
    }
  }

  /** Erase the sand under the delete tool. Returns how many grains went. */
  private eraseAt(point: Matter.Vector): number {
    const grains = this.grainWorld;
    if (!grains || grains.count === 0) return 0;
    return grains.removeIn(point.x, point.y, ERASE_RADIUS);
  }

  /**
   * Release whatever the spawners owe this step.
   *
   * The emissions are collected first and placed afterwards: placing a body can
   * evict another one, and splicing `this.bodies` while iterating it would make
   * the loop skip a spawner.
   */
  private spawnFromSpawners(dt: number): void {
    let due: { toy: ToyDef; x: number; y: number; speed: number; spread: number }[] | null = null;

    for (const body of this.bodies) {
      const spec = metaOf(body)?.spawner;
      if (!spec) continue;

      spec.acc += dt;
      const plan = planEmissions(spec.acc, spec.rateMs);
      spec.acc = plan.carry;
      if (plan.count === 0) continue;

      const toy = toyById(spec.toy);
      if (!toy) continue;

      // Just below the mouth of the spout, clear of its own collision box.
      const y = body.position.y + (body.bounds.max.y - body.position.y) + toy.w / 2 + 2;
      for (let i = 0; i < plan.count; i++) {
        (due ??= []).push({ toy, x: body.position.x, y, speed: spec.speed, spread: spec.spread });
      }
    }

    if (!due) return;

    for (const item of due) {
      this.place(
        item.toy,
        { x: item.x, y: item.y },
        { x: (Math.random() - 0.5) * item.spread, y: item.speed },
      );
    }

    this.emitCount();
  }

  private evictEscaped(): void {
    const { w, h } = this.size;
    for (let i = this.bodies.length - 1; i >= 0; i--) {
      const body = this.bodies[i];
      if (body.position.y > h + 600 || body.position.x < -800 || body.position.x > w + 800) {
        this.remove(body);
      }
    }
  }

  private onCollision = (event: Matter.IEventCollision<Matter.Engine>): void => {
    const broken: Matter.Body[] = [];

    let popped: Matter.Body[] | null = null;

    for (const pair of event.pairs) {
      // A black hole is a sensor: things pass into it, they do not hit it.
      if (pair.isSensor) continue;
      const { bodyA, bodyB } = pair;
      const impact = Matter.Vector.magnitude(
        Matter.Vector.sub(bodyA.velocity, bodyB.velocity),
      );

      this.strike(bodyA, impact);
      this.strike(bodyB, impact);

      for (const [body, other] of [
        [bodyA, bodyB],
        [bodyB, bodyA],
      ]) {
        const meta = metaOf(body);
        if (!meta) continue;
        if (meta.breaksAt !== undefined && impact > meta.breaksAt) broken.push(body);
        if (meta.fuse && impact > BOMB_TOUCHY && !this.fused.includes(body)) this.fused.push(body);
        if (meta.popsAt !== undefined && impact > meta.popsAt) (popped ??= []).push(body);
        if (meta.bounce && !other.isStatic) this.land(body, other);
      }
    }

    for (const body of broken) this.shatter(body);
    if (popped) for (const body of popped) this.pop(body);
  };

  /** Queue a launch if `body` came down onto the springy face of `pad`. */
  private land(pad: Matter.Body, body: Matter.Body): void {
    const nx = Math.sin(pad.angle);
    const ny = -Math.cos(pad.angle);
    const above = (body.position.x - pad.position.x) * nx + (body.position.y - pad.position.y) * ny;
    const coming = body.velocity.x * nx + body.velocity.y * ny;
    if (above <= 0 || coming >= 0) return;
    if (this.landings.some((l) => l.body === body)) return;
    this.landings.push({ body, pad, vx: body.velocity.x, vy: body.velocity.y });
  }

  /** Ring a note block, with a short per-block cooldown. */
  private strike(body: Matter.Body, impact: number): void {
    const meta = metaOf(body);
    if (meta?.kind !== 'note' || meta.midi === undefined) return;
    if (impact < NOTE_THRESHOLD) return;
    if (meta.hitAt !== undefined && this.time - meta.hitAt < NOTE_COOLDOWN) return;

    meta.hitAt = this.time;
    this.synth.note(meta.midi, Math.min(1, 0.3 + impact / 14));
  }

  private shatter(body: Matter.Body): void {
    const meta = metaOf(body);
    if (!meta) return;

    const { cols, rows } = shardGrid(meta.w, meta.h);
    const shards = shardLayout(
      body.position.x,
      body.position.y,
      meta.w,
      meta.h,
      body.angle,
      cols,
      rows,
    );

    const vx = body.velocity.x;
    const vy = body.velocity.y;
    this.synth.crack(Math.min(1, 0.3 + Math.hypot(vx, vy) / 18));
    this.remove(body);

    for (const shard of shards) {
      const piece = Matter.Bodies.rectangle(shard.x, shard.y, shard.w, shard.h, {
        angle: shard.angle,
        friction: 0.45,
        frictionStatic: 0.6,
        frictionAir: 0.01,
        restitution: 0.06,
        density: 0.002,
      });

      const dx = shard.x - body.position.x;
      const dy = shard.y - body.position.y;
      const len = Math.hypot(dx, dy) || 1;

      Matter.Body.setVelocity(piece, {
        x: vx + (dx / len) * 2.4,
        y: vy + (dy / len) * 2.4 - 1.2,
      });
      Matter.Body.setAngularVelocity(piece, (Math.random() - 0.5) * 0.3);

      setMeta(piece, {
        ...meta,
        w: shard.w,
        h: shard.h,
        breaksAt: undefined,
        shard: true,
        label: undefined,
      });
      this.add(piece);
    }

    this.emitCount();
  }

  // --- ropes and chains -------------------------------------------------
  //
  // A rope is tied between two presses: on a toy, or on empty space, which puts
  // a pin there. Press, drag and let go; or tap one end and then the other. The
  // links are ordinary dynamic bodies (`toys/tie.ts`), so the delete tool cuts
  // a rope where it touches it, a bomb can blow one apart and a black hole eats
  // one a link at a time. What holds it together is `this.joints`.

  private releaseRope(point: Matter.Vector): void {
    const start = this.ropeStart;
    const spec = toyById(this.tool)?.rope;
    if (!start || !spec) {
      this.ropeStart = null;
      return;
    }
    const far = Math.hypot(point.x - start.point.x, point.y - start.point.y) >= ROPE_MIN * this.scale;
    if (far) {
      this.ropeStart = null;
      // The first end may have gone (eaten, blown up) while we waited.
      const from = start.body && this.bodies.includes(start.body) ? start.body : null;
      this.tie(spec, { body: from, point: start.point }, { body: this.hitTest(point), point });
      return;
    }
    // A tap: the first one sets the start, a second on the same spot cancels.
    if (!start.armed) start.armed = true;
    else this.ropeStart = null;
  }

  private tie(
    spec: RopeSpec,
    a: { body: Matter.Body | null; point: Matter.Vector },
    b: { body: Matter.Body | null; point: Matter.Vector },
  ): void {
    // Both ends on one body is not a rope, it is a loop of string on a crate.
    if (a.body && a.body === b.body) return;

    const bodyA = a.body ?? this.addPin(a.point);
    const bodyB = b.body ?? this.addPin(b.point);
    const pointA = tiePoint(bodyA, a.point, b.point);
    const pointB = tiePoint(bodyB, b.point, pointA);
    const { links, joints } = tieRope(spec, { body: bodyA, point: pointA }, { body: bodyB, point: pointB });

    // Joints first: adding the links may evict the oldest body in the box, and
    // if that is one of the ends, `detach` has to find its joints to drop them.
    for (const joint of joints) {
      Matter.Composite.add(this.world.engine.world, joint);
      this.joints.push({ joint, snapAt: spec.snapAt });
    }
    for (const link of links) this.add(link);
    for (const end of [bodyA, bodyB]) if (!end.isStatic) Matter.Sleeping.set(end, false);
    this.emitCount();
  }

  private addPin(point: Matter.Vector): Matter.Body {
    const pin = makePin(point.x, point.y);
    clampIntoBounds(pin, this.size.w, this.size.h);
    this.add(pin);
    return pin;
  }

  /** Drop every joint that holds `body`: it has left the box. */
  private detach(body: Matter.Body): void {
    const joints = this.joints;
    let keep = 0;
    for (const entry of joints) {
      if (entry.joint.bodyA === body || entry.joint.bodyB === body) {
        Matter.Composite.remove(this.world.engine.world, entry.joint);
      } else {
        joints[keep++] = entry;
      }
    }
    joints.length = keep;
  }

  /** A joint pulled further open than its rope can take snaps. */
  private snapJoints(): void {
    const joints = this.joints;
    let keep = 0;
    let snapped = 0;
    for (const entry of joints) {
      if (jointGap(entry.joint) > entry.snapAt) {
        Matter.Composite.remove(this.world.engine.world, entry.joint);
        snapped++;
      } else {
        joints[keep++] = entry;
      }
    }
    joints.length = keep;
    if (snapped > 0) this.synth.crack(0.35);
  }

  /**
   * A rope link is a few px thick, which is too thin to hit with a finger: the
   * link nearest the press, if it is within `LINK_PICK`.
   */
  private nearestLink(point: Matter.Vector): Matter.Body | null {
    let best: Matter.Body | null = null;
    let bestD = LINK_PICK * this.scale;
    for (const body of this.bodies) {
      const meta = metaOf(body);
      if (meta?.kind !== 'link') continue;
      const half = meta.w / 2;
      const c = Math.cos(body.angle);
      const s = Math.sin(body.angle);
      const along = (point.x - body.position.x) * c + (point.y - body.position.y) * s;
      const t = Math.max(-half, Math.min(half, along));
      const d =
        Math.hypot(point.x - (body.position.x + c * t), point.y - (body.position.y + s * t)) - meta.h / 2;
      if (d < bestD) {
        bestD = d;
        best = body;
      }
    }
    return best;
  }

  /** The line from a half-tied rope's first end to the pointer. */
  private currentTether(): Tether | null {
    const start = this.ropeStart;
    const toy = toyById(this.tool);
    if (!start || !toy?.rope) return null;
    const from = start.body && this.bodies.includes(start.body) ? start.body : null;
    const a = from ? tiePoint(from, start.point, this.pointer) : start.point;
    return { ax: a.x, ay: a.y, bx: this.pointer.x, by: this.pointer.y, color: toy.color };
  }

  // --- bodies ------------------------------------------------------------

  private add(body: Matter.Body): void {
    Matter.Composite.add(this.world.engine.world, body);
    this.bodies.push(body);
    this.enforceLimit();
  }

  private remove(body: Matter.Body): void {
    if (this.drag?.body === body) this.endDrag();
    // Sand resting on this body has to fall when it goes.
    const { min, max } = body.bounds;
    this.grainWorld?.wakeIn(min.x, min.y, max.x, max.y);
    removeBody(this.world, body);
    this.detach(body);
    const index = this.bodies.indexOf(body);
    if (index >= 0) this.bodies.splice(index, 1);
  }

  private enforceLimit(): void {
    while (this.bodies.length > MAX_BODIES) {
      const index = this.bodies.findIndex((body) => !body.isStatic);
      if (index < 0) break;
      const [oldest] = this.bodies.splice(index, 1);
      if (this.drag?.body === oldest) this.endDrag();
      removeBody(this.world, oldest);
      this.detach(oldest);
    }
  }

  private spawn(toy: ToyDef, at: Matter.Vector): void {
    this.place(toy, at);
    this.emitCount();
  }

  /** Build a toy and add its bodies. No count callback - see `spawn`. */
  private place(toy: ToyDef, at: Matter.Vector, velocity?: Matter.Vector): void {
    const built = toy.build(at.x, at.y, { noteIndex: this.noteCounter++ });
    const bodies = Array.isArray(built) ? built : [built];

    for (const body of bodies) {
      clampIntoBounds(body, this.size.w, this.size.h);
      if (velocity) Matter.Body.setVelocity(body, velocity);
      this.add(body);
    }
  }

  /**
   * Benchmark helper, reachable only through `?bench=N`: lay `n` balls over the
   * box in a loose grid. Not used by the toy itself.
   */
  fill(n: number, toyId: ToyId = 'ballBouncy'): void {
    const toy = toyById(toyId);
    if (!toy) return;

    const { w, h } = this.size;
    const total = Math.max(1, Math.floor(n));
    const cols = Math.max(1, Math.round(Math.sqrt((total * w) / h)));
    const rows = Math.max(1, Math.ceil(total / cols));
    const cellW = w / cols;
    // Keep the top tenth free, so nothing starts outside the box.
    const cellH = (h * 0.9) / rows;

    for (let i = 0; i < total; i++) {
      this.place(toy, {
        x: (i % cols + 0.5) * cellW,
        y: (Math.floor(i / cols) + 0.5) * cellH,
      });
    }

    this.emitCount();
  }

  /** Current cost of the box: frame rate plus where the milliseconds go. */
  stats(): PerfStats {
    const frame = this.meter.snapshot();
    const grains = this.grainWorld;
    let toys = 0;
    for (const body of this.bodies) if (countsAsToy(body)) toys++;

    return {
      fps: frame.fps,
      fpsLow: frame.fpsLow,
      frameMs: frame.frameMs,
      physicsMs: this.physicsMs,
      drawMs: this.drawMs,
      bodies: this.bodies.length + (grains?.count ?? 0),
      toys,
      grains: grains?.count ?? 0,
      grainsAwake: grains?.awake ?? 0,
      renderer: this.painter.kind,
    };
  }

  /**
   * Where every body is, for measuring a scene rather than looking at it - a
   * dropped ball that bounces shows up as a velocity that changes sign, and a
   * pile that will not settle shows up as a box that keeps moving.
   */
  probe(): { x: number; y: number; vx: number; vy: number; w: number }[] {
    const out: { x: number; y: number; vx: number; vy: number; w: number }[] = [];
    for (const body of this.bodies) {
      if (body.isStatic) continue;
      out.push({
        x: body.position.x,
        y: body.position.y,
        vx: body.velocity.x,
        vy: body.velocity.y,
        w: body.angularVelocity,
      });
    }
    return out;
  }

  /** Forget the timing window - call before measuring. */
  resetStats(): void {
    this.meter.reset();
    this.statAcc = 0;
  }

  /**
   * Benchmark knobs, reachable only through `?bench` (see `src/debug.ts`).
   * Everything here is a quality/throughput tradeoff worth measuring rather
   * than a setting a player should meet.
   */
  tune(options: Tuning): Tuning {
    const engine = this.world.engine;

    if (options.sleeping !== undefined) engine.enableSleeping = options.sleeping;
    if (options.positionIterations !== undefined) {
      engine.positionIterations = options.positionIterations;
    }
    if (options.velocityIterations !== undefined) {
      engine.velocityIterations = options.velocityIterations;
    }
    if (options.sprites !== undefined) this.sprites = options.sprites;

    return {
      sleeping: engine.enableSleeping,
      positionIterations: engine.positionIterations,
      velocityIterations: engine.velocityIterations,
      sprites: this.sprites,
    };
  }

  private emitCount(): void {
    // Grains count as bodies, not as toys: twelve thousand grains are one pile.
    const grains = this.grainWorld?.count ?? 0;
    const toys = this.bodies.filter(countsAsToy).length;
    this.callbacks.onCount(toys, this.bodies.length + grains);
  }

  // --- input -------------------------------------------------------------

  private onPointerDown = (event: PointerEvent): void => {
    this.synth.unlock();
    this.callbacks.onFirstInteraction();

    const point = this.toWorld(event);
    this.pointer = point;
    this.pointerInside = true;

    if (event.button === 2) return; // right click is handled by onContextMenu
    event.preventDefault();

    // A rope is tied, not dropped: this press is one of its ends.
    if (toyById(this.tool)?.rope) {
      if (!this.ropeStart) this.ropeStart = { body: this.hitTest(point), point, armed: false };
      return;
    }

    const hit = this.hitTest(point);

    if (this.tool === 'delete') {
      if (hit) {
        this.remove(hit);
        this.emitCount();
      } else {
        // No body under the pointer: this is a bite out of a sand pile.
        this.erasing = true;
        if (this.eraseAt(point) > 0) this.emitCount();
      }
      return;
    }

    if (hit) {
      this.beginDrag(hit, point);
      return;
    }

    const toy = toyById(this.tool);
    if (toy) this.spawn(toy, point);
  };

  private onPointerMove = (event: PointerEvent): void => {
    const point = this.toWorld(event);
    this.pointer = point;
    this.pointerInside = true;

    if (this.erasing) {
      if (this.eraseAt(point) > 0) this.emitCount();
      return;
    }

    const drag = this.drag;
    if (!drag) {
      this.updateCursor(point);
      return;
    }

    if (!drag.moved) {
      const slop = TAP_SLOP * this.scale;
      if (Math.hypot(point.x - drag.start.x, point.y - drag.start.y) < slop) return;
      drag.moved = true;
    }

    if (drag.constraint) {
      // Clamp the target so a drag can never pull a body out through a wall.
      drag.constraint.pointA = {
        x: Math.min(Math.max(point.x, 0), this.size.w),
        y: Math.min(Math.max(point.y, 0), this.size.h),
      };
    } else {
      Matter.Body.setPosition(drag.body, {
        x: Math.min(Math.max(point.x + drag.offset.x, 0), this.size.w),
        y: Math.min(Math.max(point.y + drag.offset.y, 0), this.size.h),
      });
      // Static bodies move by teleport, so the granular layer never sees a
      // velocity to wake a sleeping pile with. Do it explicitly.
      const { min, max } = drag.body.bounds;
      this.grainWorld?.wakeIn(min.x, min.y, max.x, max.y);
    }
  };

  private onPointerUp = (): void => {
    this.erasing = false;
    if (this.ropeStart) this.releaseRope(this.pointer);
    const drag = this.drag;
    if (!drag) return;
    this.endDrag();
    // A tap on a fan or a trampoline turns it instead of moving it.
    const turn = metaOf(drag.body)?.turn;
    if (!drag.constraint && !drag.moved && turn) this.turn(drag.body, turn);
  };

  /** Turn a static toy in place, and let anything resting on it fall. */
  private turn(body: Matter.Body, by: number): void {
    const before = body.bounds;
    this.grainWorld?.wakeIn(before.min.x, before.min.y, before.max.x, before.max.y);
    Matter.Body.setAngle(body, body.angle + by);
    clampIntoBounds(body, this.size.w, this.size.h);
    const after = body.bounds;
    this.grainWorld?.wakeIn(after.min.x, after.min.y, after.max.x, after.max.y);
    for (const other of Matter.Query.region(this.bodies, after)) {
      if (!other.isStatic) Matter.Sleeping.set(other, false);
    }
  }

  private onPointerLeave = (): void => {
    this.pointerInside = false;
    this.updateCursor(this.pointer);
  };

  private onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    const hit = this.hitTest(this.toWorld(event));
    if (hit) {
      this.remove(hit);
      this.emitCount();
    }
  };

  private beginDrag(body: Matter.Body, point: Matter.Vector): void {
    if (body.isStatic) {
      // Static toys are repositioned directly; a constraint can't move them.
      this.drag = {
        body,
        constraint: null,
        offset: { x: body.position.x - point.x, y: body.position.y - point.y },
        start: { x: point.x, y: point.y },
        moved: false,
      };
    } else {
      const local = Matter.Vector.rotate(Matter.Vector.sub(point, body.position), -body.angle);
      const constraint = Matter.Constraint.create({
        pointA: { x: point.x, y: point.y },
        bodyB: body,
        pointB: local,
        stiffness: DRAG_STIFFNESS,
        damping: DRAG_DAMPING,
        length: 0,
      });
      Matter.Composite.add(this.world.engine.world, constraint);
      Matter.Sleeping.set(body, false);
      // A dynamic body follows the pointer from the start: there is no tap.
      this.drag = { body, constraint, offset: { x: 0, y: 0 }, start: point, moved: true };
    }

    this.setCursor('grabbing');
  }

  private endDrag(): void {
    const drag = this.drag;
    this.drag = null;
    if (drag?.constraint) Matter.Composite.remove(this.world.engine.world, drag.constraint);
    this.updateCursor(this.pointer);
  }

  private hitTest(point: Matter.Vector): Matter.Body | null {
    const found = Matter.Query.point(this.bodies, point);
    if (found.length === 0) return this.nearestLink(point);

    // Highest id = most recently added = on top.
    let top = found[0];
    for (const body of found) if (body.id > top.id) top = body;
    return top;
  }

  private toWorld(event: PointerEvent | MouseEvent): Matter.Vector {
    const rect = this.canvas.getBoundingClientRect();
    // rect-based rather than scale-based, so a canvas that CSS has resized
    // behind our back still maps clicks onto the right place in the box.
    const sx = this.size.w / Math.max(1, rect.width);
    const sy = this.size.h / Math.max(1, rect.height);
    return { x: (event.clientX - rect.left) * sx, y: (event.clientY - rect.top) * sy };
  }

  private updateCursor(point: Matter.Vector): void {
    // A press ties a rope whatever is under it, so there is nothing to grab.
    if (this.tool === 'delete' || toyById(this.tool)?.rope) {
      this.setCursor('crosshair');
      return;
    }
    if (this.drag) {
      this.setCursor('grabbing');
      return;
    }
    if (this.pointerInside && this.hitTest(point)) {
      this.setCursor('grab');
      return;
    }
    this.setCursor(toyById(this.tool) ? 'crosshair' : 'default');
  }

  private setCursor(cursor: string): void {
    if (this.cursor === cursor) return;
    this.cursor = cursor;
    this.canvas.style.cursor = cursor;
  }

  // --- drawing -----------------------------------------------------------

  private draw(): void {
    const scene: Scene = {
      worldW: this.size.w,
      worldH: this.size.h,
      time: this.time,
      bodies: this.bodies,
      ghost: this.currentGhost(),
      draggingId: this.drag?.body.id ?? null,
      scale: this.scale,
      pixelRatio: this.pixelRatio,
      useSprites: this.sprites,
      grains: this.grainWorld,
      effects: this.liveEffects(),
      tether: this.currentTether(),
    };
    this.painter.draw(scene);
  }

  /** Drop the flashes that have finished; the rest are drawn this frame. */
  private liveEffects(): Effect[] {
    const effects = this.effects;
    let keep = 0;
    for (const effect of effects) if (this.time - effect.born < effect.life) effects[keep++] = effect;
    effects.length = keep;
    return effects;
  }

  private currentGhost(): Ghost | null {
    if (!this.pointerInside || this.drag) return null;

    const toy = toyById(this.tool);
    if (!toy) return null;
    if (toy.rope) {
      // Where the rope will tie on: a pin's worth of preview at the pointer.
      return { x: this.pointer.x, y: this.pointer.y, w: 10, h: 10, color: toy.color, shape: 'circle' };
    }

    return {
      x: this.pointer.x,
      y: this.pointer.y,
      w: toy.w,
      h: toy.h,
      color: toy.color,
      shape: toy.swatch === 'circle' ? 'circle' : 'rect',
    };
  }
}
