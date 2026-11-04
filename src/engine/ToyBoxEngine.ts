import Matter from 'matter-js';
import type { Synth } from '../audio/synth';
import { FrameMeter } from '../lib/frame-meter';
import { carryBodies } from '../physics/conveyor';
import {
  GRAIN,
  GRAIN_FORCE,
  GrainWorld,
  scatterGrains,
  type GrainCollider,
  type GrainMaterial,
} from '../physics/grains';
import { shardGrid, shardLayout } from '../physics/shatter';
import { planEmissions } from '../physics/spawner';
import { clampIntoBounds, createWorld, removeBody, resizeWorld, STEP_MS } from '../physics/world';
import { toyById } from '../toys/catalog';
import { isShard, metaOf, setMeta } from '../toys/meta';
import type { ToyDef, ToyId } from '../toys/types';
import { createPainter } from './painter';
import type { Ghost, Painter, Scene } from './scene';

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
    for (const body of [...this.bodies]) this.remove(body);
    this.grainWorld?.clear();
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
    if (!belt || !note || !bouncy || !marble || !beach || !crate) return;

    this.spawn(belt, { x: w * 0.72, y: h - 40 });
    this.spawn(note, { x: w * 0.26, y: h - 42 });
    this.spawn(crate, { x: w * 0.72, y: h - 78 });
    // Clear of the intro hint at the top of the canvas.
    this.spawn(bouncy, { x: w * 0.36, y: 100 });
    this.spawn(marble, { x: w * 0.52, y: 150 });
    this.spawn(beach, { x: w * 0.63, y: 108 });
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
    carryBodies(this.bodies);
    Matter.Engine.update(this.world.engine, STEP_MS);
    this.evictEscaped();
    this.stepGrains();
  }

  // --- granular layer ----------------------------------------------------

  /**
   * One grain step, then hand the bodies back the weight that rested on them.
   *
   * Matter clears `force`/`torque` at the end of every update, so this load is
   * integrated on the *next* step - a 16 ms delay that nothing can see, in
   * exchange for not having to run the grain solver inside Matter's step.
   */
  private stepGrains(): void {
    const grains = this.grainWorld;
    if (!grains) return;

    this.buildColliders();
    grains.step(this.colliderView);

    const load = GRAIN_FORCE;
    for (let i = 0; i < this.colliderView.length; i++) {
      const body = this.colliderView[i].body;
      if (body.isStatic) continue;

      const fx = grains.loadFx[i];
      const fy = grains.loadFy[i];
      const torque = grains.loadTorque[i];
      if (fx === 0 && fy === 0 && torque === 0) continue;

      body.force.x += fx * load;
      body.force.y += fy * load;
      body.torque += torque * load;
    }
  }

  /**
   * Wrap every body for the granular layer. The pool is indexed by position in
   * `this.bodies`, so a steady box reuses the same wrapper objects for ever.
   */
  private buildColliders(): void {
    const view = this.colliderView;
    const pool = this.colliderPool;
    view.length = 0;

    for (const body of this.bodies) {
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

      const belt = metaOf(body)?.belt;
      collider.surface.x = belt ? belt.dir * belt.speed : 0;
      collider.surface.y = 0;

      view.push(collider);
    }
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

    for (const pair of event.pairs) {
      const { bodyA, bodyB } = pair;
      const impact = Matter.Vector.magnitude(
        Matter.Vector.sub(bodyA.velocity, bodyB.velocity),
      );

      this.strike(bodyA, impact);
      this.strike(bodyB, impact);

      for (const body of [bodyA, bodyB]) {
        const limit = metaOf(body)?.breaksAt;
        if (limit !== undefined && impact > limit) broken.push(body);
      }
    }

    for (const body of broken) this.shatter(body);
  };

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
    for (const body of this.bodies) if (!isShard(body)) toys++;

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
    const toys = this.bodies.filter((body) => !isShard(body)).length;
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
      this.grainWorld?.wakeIn(min.x - 8, min.y - 8, max.x + 8, max.y + 8);
    }
  };

  private onPointerUp = (): void => {
    this.erasing = false;
    if (this.drag) this.endDrag();
  };

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
      };
    } else {
      const local = Matter.Vector.rotate(Matter.Vector.sub(point, body.position), -body.angle);
      const constraint = Matter.Constraint.create({
        pointA: { x: point.x, y: point.y },
        bodyB: body,
        pointB: local,
        stiffness: 0.16,
        damping: 0.1,
        length: 0,
      });
      Matter.Composite.add(this.world.engine.world, constraint);
      Matter.Sleeping.set(body, false);
      this.drag = { body, constraint, offset: { x: 0, y: 0 } };
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
    if (found.length === 0) return null;

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
    if (this.tool === 'delete') {
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
    };
    this.painter.draw(scene);
  }

  private currentGhost(): Ghost | null {
    if (!this.pointerInside || this.drag) return null;

    const toy = toyById(this.tool);
    if (!toy) return null;

    return {
      x: this.pointer.x,
      y: this.pointer.y,
      w: toy.w,
      h: toy.h,
      color: toy.color,
      shape: toy.kind === 'ball' ? 'circle' : 'rect',
    };
  }
}
