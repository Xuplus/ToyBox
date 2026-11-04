import Matter from 'matter-js';
import type { Synth } from '../audio/synth';
import { carryBodies } from '../physics/conveyor';
import { shardGrid, shardLayout } from '../physics/shatter';
import { clampIntoBounds, createWorld, removeBody, resizeWorld, STEP_MS } from '../physics/world';
import { toyById } from '../toys/catalog';
import { isShard, metaOf, setMeta } from '../toys/meta';
import type { ToyDef, ToyId } from '../toys/types';
import { buildGrid, renderScene, type Ghost } from './render';

export type Tool = 'drag' | 'delete' | ToyId;

/** Hard cap on bodies. Shatter storms are the only way to approach it. */
const MAX_BODIES = 280;
/** Impact speed (px/step) below which a note block stays quiet. */
const NOTE_THRESHOLD = 1.2;
/** Minimum gap between two sounds from the same block, in ms. */
const NOTE_COOLDOWN = 70;

export interface EngineCallbacks {
  /** Fired when the toy count changes. `toys` excludes shards, `bodies` is
   *  everything in the box (used to tell "empty" from "only debris"). */
  onCount: (toys: number, bodies: number) => void;
  /** Fired on the first user gesture — used to dismiss the hint. */
  onFirstInteraction: () => void;
}

interface DragState {
  body: Matter.Body;
  /** null for static bodies, which are moved directly instead */
  constraint: Matter.Constraint | null;
  offset: Matter.Vector;
}

export class ToyBoxEngine {
  private readonly ctx: CanvasRenderingContext2D;
  private world = createWorld(1, 1);
  private bodies: Matter.Body[] = [];
  private tool: Tool = 'drag';
  private paused = false;
  private drag: DragState | null = null;
  private pointer: Matter.Vector = { x: 0, y: 0 };
  private pointerInside = false;
  private cursor = '';
  private size = { w: 1, h: 1 };
  private grid: Path2D | null = null;
  private time = 0;
  private last = 0;
  private acc = 0;
  private raf = 0;
  private noteCounter = 0;
  private seeded = false;
  private destroyed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly synth: Synth,
    private readonly callbacks: EngineCallbacks,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;

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
  }

  resize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.size = { w, h };
    this.grid = buildGrid(w, h);
    resizeWorld(this.world, w, h);
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
    this.noteCounter = 0;
    this.emitCount();
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

    const dt = Math.min(now - this.last, 100);
    this.last = now;
    this.time += dt;

    if (!this.paused) {
      this.acc = Math.min(this.acc + dt, STEP_MS * 5);
      while (this.acc >= STEP_MS) {
        this.step();
        this.acc -= STEP_MS;
      }
    }

    this.draw();
  };

  private step(): void {
    carryBodies(this.bodies);
    Matter.Engine.update(this.world.engine, STEP_MS);
    this.evictEscaped();
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
    const built = toy.build(at.x, at.y, { noteIndex: this.noteCounter++ });
    const bodies = Array.isArray(built) ? built : [built];

    for (const body of bodies) {
      clampIntoBounds(body, this.size.w, this.size.h);
      this.add(body);
    }

    this.emitCount();
  }

  private emitCount(): void {
    const toys = this.bodies.filter((body) => !isShard(body)).length;
    this.callbacks.onCount(toys, this.bodies.length);
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
    }
  };

  private onPointerUp = (): void => {
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
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
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
    renderScene({
      ctx: this.ctx,
      width: this.size.w,
      height: this.size.h,
      time: this.time,
      bodies: this.bodies,
      ghost: this.currentGhost(),
      grid: this.grid,
      draggingId: this.drag?.body.id ?? null,
    });
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
