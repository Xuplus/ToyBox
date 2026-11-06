import Matter from 'matter-js';
import { describe, expect, it } from 'vitest';
import { toRgb, shadeRgb } from '../../lib/color';
import { GRAIN, GrainWorld, MATERIALS, scatterGrains } from '../../physics/grains';
import { NOTE_H, TOYS, toyById } from '../../toys/catalog';
import type { SpawnContext, ToyId } from '../../toys/types';
import { metaOf, setMeta } from '../../toys/meta';
import type { Scene } from '../scene';
import { CIRCLE_STYLE, DOT, DOT_STRIDE, Instances, PATTERN, RECT, SPRITE } from './instances';
import type { LabelCell, LabelLookup } from './labels';
import { packScene, SceneBuffers } from './pack';

const K = 1 / 255;

function one(body: Matter.Body | Matter.Body[]): Matter.Body {
  return Array.isArray(body) ? body[0] : body;
}

/** Build a toy the way the engine does. */
function make(
  id: ToyId,
  x = 0,
  y = 0,
  ctx: SpawnContext = { noteIndex: 0 },
): Matter.Body {
  return one(toyById(id)!.build(x, y, ctx));
}

function scene(bodies: Matter.Body[], extra: Partial<Scene> = {}): Scene {
  return {
    worldW: 800,
    worldH: 600,
    time: 0,
    bodies,
    draggingId: null,
    ghost: null,
    grains: null,
    effects: [],
    scale: 1,
    pixelRatio: 1,
    useSprites: true,
    ...extra,
  };
}

function pack(bodies: Matter.Body[], extra: Partial<Scene> = {}, labels: LabelLookup | null = null) {
  const out = new SceneBuffers();
  packScene(out, scene(bodies, extra), labels);
  return out;
}

/** A one-cell atlas, so the note label tests don't need a canvas. */
function fakeAtlas(fontPx = 14): LabelLookup {
  const cell: LabelCell = { u0: 0, v0: 0.5, u1: 1, v1: 1, w: 40, h: 24 };
  return { fontPx, cell: (text) => (text ? cell : undefined) };
}

function rectAt(list: Instances, index = 0): Record<string, number> {
  const d = list.data;
  const at = index * list.stride;
  const named: Record<string, number> = {};
  for (const [key, offset] of Object.entries(RECT)) named[key] = d[at + offset];
  return named;
}

describe('packScene — balls', () => {
  it('packs one circle plus one style record', () => {
    const out = pack([make('ballBouncy', 120, 80)]);

    expect(out.circles.count).toBe(1);
    expect(out.styles.count).toBe(1);
    expect(out.rects.count).toBe(0);

    const d = out.circles.data;
    expect(d[DOT.x]).toBe(120);
    expect(d[DOT.y]).toBe(80);
    expect(d[DOT.radius]).toBe(14);
    expect(d[DOT.color]).toBeCloseTo(255 * K, 5);
    expect(d[DOT.color + 3]).toBe(1);

    const s = out.styles.data;
    expect(s[CIRCLE_STYLE.glow]).toBe(0);
    expect(s[CIRCLE_STYLE.dash]).toBe(0);
    expect(s[CIRCLE_STYLE.border + 3]).toBe(1);
  });

  it('gives the dragged body a halo and nothing else', () => {
    const ball = make('ballBouncy', 120, 80);
    const out = pack([ball], { draggingId: ball.id });

    expect(out.styles.data[CIRCLE_STYLE.glow]).toBe(1);
  });

  it('outlines a ball with shade(color, -0.55)', () => {
    const out = pack([make('ballMarble', 0, 0)]);
    const expected = shadeRgb(toRgb('#66d9ff'), -0.55);
    const s = out.styles.data;

    expect(s[CIRCLE_STYLE.border]).toBeCloseTo(expected[0] * K, 5);
    expect(s[CIRCLE_STYLE.border + 1]).toBeCloseTo(expected[1] * K, 5);
    expect(s[CIRCLE_STYLE.border + 2]).toBeCloseTo(expected[2] * K, 5);
  });
});

describe('packScene — blocks', () => {
  it('packs a crate as one rect with the cross-brace pattern', () => {
    const out = pack([make('crate', 200, 150)]);
    const rect = rectAt(out.rects);

    expect(out.rects.count).toBe(1);
    expect(rect.pattern).toBe(PATTERN.crate);
    expect(rect.x).toBe(200);
    expect(rect.y).toBe(150);
    expect(rect.halfW).toBe(28);
    expect(rect.halfH).toBe(28);
    expect(rect.radius).toBeCloseTo(9, 5);
    expect(rect.shadeTop).toBeCloseTo(0.22, 5);
    expect(rect.shadeBottom).toBeCloseTo(-0.32, 5);
    expect(rect.borderW).toBeCloseTo(1.5, 5);
    expect(out.rects.data[RECT.border + 3]).toBe(1);
  });

  it('carries the body angle so the gradient turns with it', () => {
    const crate = make('crate', 0, 0);
    crate.angle = 0.5;
    const out = pack([crate]);

    expect(rectAt(out.rects).angle).toBeCloseTo(0.5, 5);
  });

  it('gives glass a translucent fill and the glint pattern', () => {
    const out = pack([make('glass', 0, 0)]);
    const rect = rectAt(out.rects);

    expect(rect.pattern).toBe(PATTERN.glass);
    expect(out.rects.data[RECT.color + 3]).toBeCloseTo(0.2, 5);
    expect(out.rects.data[RECT.border + 3]).toBeCloseTo(0.9, 5);
  });

  it('gives brick and plank their own detail patterns', () => {
    const brick = make('brick');
    const plank = make('plank');

    expect(rectAt(pack([one(brick)]).rects).pattern).toBe(PATTERN.brick);
    expect(rectAt(pack([one(plank)]).rects).pattern).toBe(PATTERN.plank);
  });

  it('flat-fills a shard instead of shading it', () => {
    // Shards are cloned from the parent with a small footprint and no gradient.
    const shard = make('glass', 0, 0);
    setMeta(shard, { ...metaOf(shard)!, w: 12, h: 16, shard: true });
    const rect = rectAt(pack([shard]).rects);

    expect(rect.pattern).toBe(PATTERN.none);
    expect(rect.shadeTop).toBe(0);
    expect(rect.shadeBottom).toBe(0);
    expect(rect.radius).toBeLessThanOrEqual(3);
    expect(pack([shard]).rects.count).toBe(1);
  });
});

describe('packScene — polys', () => {
  it('emits a triangle fan plus an outline per edge', () => {
    const out = pack([make('ramp', 300, 300)]);

    expect(out.rects.count).toBe(0);
    expect(out.circles.count).toBe(0);
    // A triangle: one fan triangle (3) + three outline quads (18) + a bevel (6).
    expect(out.polys.count).toBe(27);
    expect(out.polys.count % 3).toBe(0);
  });
});

describe('packScene — belts', () => {
  it('packs the belt body plus two rollers', () => {
    const out = pack([make('beltRight', 400, 300)]);
    const rect = rectAt(out.rects);

    expect(out.rects.count).toBe(1);
    expect(rect.pattern).toBe(PATTERN.belt);
    expect(rect.halfW).toBe(100);
    expect(rect.halfH).toBe(11);
    expect(rect.paramY).toBe(1);

    // Rollers: dark discs with the accent ring, one at each end.
    expect(out.circles.count).toBe(2);
    expect(out.circles.data[DOT.radius]).toBe(9);
    expect(out.circles.data[DOT.x]).toBeCloseTo(400 - (100 - 9 - 1), 5);
    expect(out.circles.data[DOT.x + DOT_STRIDE]).toBeCloseTo(400 + (100 - 9 - 1), 5);
  });

  it('flips the chevrons for a left belt', () => {
    const out = pack([make('beltLeft', 0, 0)]);
    expect(rectAt(out.rects).paramY).toBe(-1);
  });

  it('animates the chevron phase with the clock', () => {
    const belt = make('beltRight', 0, 0);
    const at0 = rectAt(pack([belt], { time: 0 }).rects).paramX;
    const at100 = rectAt(pack([belt], { time: 100 }).rects).paramX;

    expect(at100).not.toBeCloseTo(at0, 3);
    expect(at100).toBeGreaterThanOrEqual(0);
    expect(at100).toBeLessThan(30);
  });
});

describe('packScene — notes', () => {
  it('packs the bar and its label quad', () => {
    const note = make('noteBlock', 0, 0, { noteIndex: 0 });
    const atlas = fakeAtlas(14);
    const out = pack([note], {}, atlas);

    expect(out.rects.count).toBe(1);
    expect(rectAt(out.rects).pattern).toBe(PATTERN.note);
    expect(out.sprites.count).toBe(1);

    const d = out.sprites.data;
    // The label is drawn at half the bar's height: 0.5 * 28 = 14 world px.
    const scale = (0.5 * NOTE_H) / 14;
    expect(d[SPRITE.halfW]).toBeCloseTo((40 * scale) / 2, 5);
    expect(d[SPRITE.halfH]).toBeCloseTo((24 * scale) / 2, 5);
    expect(d[SPRITE.uv]).toBe(0);
    expect(d[SPRITE.uv + 1]).toBeCloseTo(0.5, 5);
  });

  it('scales the label with the atlas resolution', () => {
    const note = make('noteBlock', 0, 0, { noteIndex: 0 });
    const coarse = pack([note], {}, fakeAtlas(7));
    const fine = pack([note], {}, fakeAtlas(28));

    expect(coarse.sprites.data[SPRITE.halfW]).toBeCloseTo(fine.sprites.data[SPRITE.halfW] * 4, 4);
  });

  it('drops the label when there is no atlas', () => {
    const note = make('noteBlock', 0, 0, { noteIndex: 0 });
    const out = pack([note], {}, null);

    expect(out.rects.count).toBe(1);
    expect(out.sprites.count).toBe(0);
  });

  it('lights up for a moment after a strike', () => {
    const note = make('noteBlock', 0, 0, { noteIndex: 0 });
    const meta = metaOf(note)!;
    const glowAt = (hitAt: number) => {
      meta.hitAt = hitAt;
      return rectAt(pack([note], { time: 10_000 }).rects).glow;
    };

    expect(glowAt(9_950)).toBeGreaterThan(0.5); // struck 50 ms ago
    expect(glowAt(9_800)).toBeGreaterThan(0); // 200 ms ago — fading out
    expect(glowAt(5_000)).toBe(0); // long gone
  });
});

describe('packScene — spouts', () => {
  it('packs the housing, the mouth, two bolts and three falling dots', () => {
    const out = pack([make('ballSpawner', 400, 60)]);

    expect(out.rects.count).toBe(4);
    expect(out.circles.count).toBe(3);
    expect(rectAt(out.rects).pattern).toBe(PATTERN.spawner);
    // The three dots sweep down the housing over one emission interval.
    const ys = [0, 1, 2].map((i) => out.circles.data[i * DOT_STRIDE + DOT.y]);
    expect(new Set(ys).size).toBe(3);
  });
});

describe('packScene — grains', () => {
  it('packs one dot per grain, in the sand colour and with its rim', () => {
    const world = new GrainWorld(6, 200, 200, { radius: 6 });
    scatterGrains(world, 6);
    const out = pack([], { grains: world });

    expect(out.dots.count).toBe(world.count);
    expect(out.dots.count).toBeGreaterThan(0);

    const d = out.dots.data;
    expect(d[DOT.x]).toBeCloseTo(world.x[0], 5);
    expect(d[DOT.y]).toBeCloseTo(world.y[0], 5);
    expect(d[DOT.radius]).toBe(6);
    expect(d[DOT.color]).toBeCloseTo(toRgb(MATERIALS[GRAIN.sand].color)[0] * K, 5);
    expect(d[DOT.color + 3]).toBe(1);
    expect(d[DOT.border]).toBe(MATERIALS[GRAIN.sand].border);

    // Grains never allocate per-instance style records.
    expect(out.circles.count).toBe(0);
    expect(out.styles.count).toBe(0);
  });

  it('gives water its own colour, alpha and no rim', () => {
    const world = new GrainWorld(3, 200, 200, { radius: 5 });
    world.add(50, 50, 0, 0, GRAIN.water);
    world.add(60, 50, 0, 0, GRAIN.water);
    world.add(70, 50, 0, 0, GRAIN.sand);

    const out = pack([], { grains: world });
    const d = out.dots.data;
    const water = MATERIALS[GRAIN.water];

    expect(d[DOT.color]).toBeCloseTo(toRgb(water.color)[0] * K, 5);
    expect(d[DOT.color + 3]).toBeCloseTo(water.alpha, 5);
    expect(d[DOT.border]).toBe(0);

    // ...and it is flagged for the liquid path in the shader: soft edge, flat
    // fill, no specular. Sand keeps its hard rim and its lit ball shading.
    expect(d[DOT.liquid]).toBe(1);
    expect(d[DOT_STRIDE + DOT.liquid]).toBe(1);

    // ...and sand in the same buffer keeps its rim and its lit shading.
    const last = 2 * DOT_STRIDE;
    expect(d[last + DOT.border]).toBe(MATERIALS[GRAIN.sand].border);
    expect(d[last + DOT.liquid]).toBe(0);
    // Two materials, one draw call: still nothing in the ball buffers.
    expect(out.circles.count).toBe(0);
  });

  it('does not touch the ball buffers', () => {
    const world = new GrainWorld(4, 200, 200, { radius: 5 });
    scatterGrains(world, 4);
    const out = pack([make('ballBouncy', 0, 0)], { grains: world });

    expect(out.dots.count).toBe(world.count);
    expect(out.circles.count).toBe(1);
  });
});

describe('packScene — the drop preview', () => {
  it('packs a dashed rect for a block', () => {
    const out = pack([], { ghost: { x: 10, y: 20, w: 56, h: 56, color: '#c98b5a', shape: 'rect' } });
    const rect = rectAt(out.ghostRect);

    expect(out.ghostRect.count).toBe(1);
    expect(rect.pattern).toBe(PATTERN.dash);
    expect(rect.paramX).toBe(12);
    expect(rect.x).toBe(10);
    expect(rect.y).toBe(20);
  });

  it('packs a dashed circle for a ball', () => {
    const out = pack([], { ghost: { x: 10, y: 20, w: 28, h: 28, color: '#ff6b8b', shape: 'circle' } });

    expect(out.ghostCircle.count).toBe(1);
    expect(out.ghostStyle.count).toBe(1);
    expect(out.ghostCircle.data[DOT.radius]).toBe(14);
    expect(out.ghostStyle.data[CIRCLE_STYLE.dash]).toBe(12);
    // The preview is drawn at half alpha, like the canvas painter's globalAlpha.
    expect(out.ghostCircle.data[DOT.color + 3]).toBeCloseTo(0.06, 5);
  });

  it('keeps the preview out of the body buffers', () => {
    const out = pack([make('crate', 0, 0)], {
      ghost: { x: 0, y: 0, w: 56, h: 56, color: '#000', shape: 'rect' },
    });

    expect(out.rects.count).toBe(1);
    expect(out.ghostRect.count).toBe(1);
  });
});

describe('packScene — bookkeeping', () => {
  it('clears the previous frame', () => {
    const out = new SceneBuffers();
    const bodies = [make('crate', 0, 0), make('ballBouncy', 0, 0)];

    packScene(out, scene(bodies), null);
    const first = { rects: out.rects.count, circles: out.circles.count };
    packScene(out, scene(bodies), null);

    expect(out.rects.count).toBe(first.rects);
    expect(out.circles.count).toBe(first.circles);
  });

  it('packs every registered toy without throwing', () => {
    const bodies = TOYS.map((toy) => one(toy.build(100, 100, { noteIndex: 3 })));
    const out = pack(bodies, {}, fakeAtlas());

    expect(out.rects.count).toBeGreaterThan(0);
    expect(out.circles.count).toBeGreaterThan(0);
    expect(out.polys.count).toBeGreaterThan(0);
    expect(out.sprites.count).toBeGreaterThan(0);
    expect(out.rects.count).toBeLessThan(64);
  });

  it('skips bodies with no toy metadata', () => {
    const out = pack([]);
    expect(out.rects.count + out.circles.count).toBe(0);
  });
});

describe('Instances', () => {
  it('grows without losing what was already written', () => {
    const list = new Instances(3, 1);
    for (let i = 0; i < 300; i++) {
      const at = list.slot();
      const d = list.data;
      d[at] = i;
      d[at + 1] = i * 2;
      d[at + 2] = i * 3;
    }

    expect(list.count).toBe(300);
    for (const i of [0, 1, 7, 128, 299]) {
      expect(list.data[i * 3]).toBe(i);
      expect(list.data[i * 3 + 1]).toBe(i * 2);
      expect(list.data[i * 3 + 2]).toBe(i * 3);
    }
  });

  it('reserve() makes room for a hot loop to hoist data', () => {
    const list = new Instances(2, 1);
    list.reserve(100);
    expect(list.data.length).toBeGreaterThanOrEqual(200);

    const d = list.data;
    d[0] = 42;
    expect(list.data[0]).toBe(42);
  });

  it('view() exposes exactly the written records', () => {
    const list = new Instances(4);
    list.slot();
    list.slot();
    expect(list.view().length).toBe(8);
  });
});

describe('packScene — gadgets', () => {
  function everyFloatFinite(out: SceneBuffers): boolean {
    for (const list of [out.circles, out.styles, out.rects, out.polys]) {
      for (const value of list.view()) if (!Number.isFinite(value)) return false;
    }
    return true;
  }

  it('draws every gadget with finite numbers, at any angle and time', () => {
    for (const id of ['bomb', 'balloon', 'fan', 'trampoline', 'blackHole'] as const) {
      for (const angle of [0, Math.PI / 4, Math.PI]) {
        const body = make(id, 300, 200);
        Matter.Body.setAngle(body, angle);
        for (const time of [0, 1234, 98765]) {
          const out = pack([body], { time });
          expect(out.circles.count + out.rects.count + out.polys.count).toBeGreaterThan(0);
          expect(everyFloatFinite(out)).toBe(true);
        }
      }
    }
  });

  it('a bomb is a circle with a cap, a fuse and a spark', () => {
    const out = pack([make('bomb', 100, 100)]);
    expect(out.rects.count).toBe(1);
    // ball + spark halo + spark; no red flash on a fresh fuse
    expect(out.circles.count).toBe(3);
    expect(out.polys.count).toBeGreaterThan(0);
  });

  it('a bomb flashes red once its fuse is mostly burnt', () => {
    const bomb = make('bomb', 100, 100);
    const fresh = pack([bomb]).circles.count;
    metaOf(bomb)!.fuse!.left = 200;
    // try a few moments: the blink can be at its dim point on any one frame
    const counts = [0, 40, 80].map((time) => pack([bomb], { time }).circles.count);
    expect(Math.max(...counts)).toBe(fresh + 1);
  });

  it('a balloon string hangs down even when the balloon is upside down', () => {
    const balloon = make('balloon', 100, 100);
    Matter.Body.setAngle(balloon, Math.PI);
    const out = pack([balloon]);
    const d = out.polys.data;
    let lowest = -Infinity;
    for (let i = 0; i < out.polys.count; i++) lowest = Math.max(lowest, d[i * out.polys.stride + 1]);
    expect(lowest).toBeGreaterThan(100 + 22);
  });

  it('a fan blows out of its front face: streaks are in front, not behind', () => {
    const fan = make('fan', 300, 300);
    const out = pack([fan], { time: 500 });
    const d = out.polys.data;
    for (let i = 0; i < out.polys.count; i++) expect(d[i * out.polys.stride + 1]).toBeLessThan(300);

    Matter.Body.setAngle(fan, Math.PI / 2);
    const turned = pack([fan], { time: 500 });
    const t = turned.polys.data;
    for (let i = 0; i < turned.polys.count; i++) expect(t[i * turned.polys.stride]).toBeGreaterThan(300);
  });

  it('a trampoline mat dips and glows right after a landing', () => {
    const pad = make('trampoline', 300, 300);
    const meta = metaOf(pad)!;
    const matOf = (out: SceneBuffers) => rectAt(out.rects, out.rects.count - 1);

    const still = matOf(pack([pad], { time: 1000 }));
    meta.hitAt = 1000;
    const hit = matOf(pack([pad], { time: 1010 }));
    expect(hit.y).toBeGreaterThan(still.y);
    expect(hit.glow).toBeGreaterThan(0);
  });

  it('effects are drawn while they last and not after', () => {
    const blast = { kind: 'blast' as const, x: 50, y: 60, born: 0, life: 700, radius: 200, color: '#ff8a3d' };
    expect(pack([], { effects: [blast], time: 100 }).circles.count).toBe(4);
    expect(pack([], { effects: [blast], time: 700 }).circles.count).toBe(0);
    const pop = { ...blast, kind: 'pop' as const, life: 260, radius: 30 };
    expect(pack([], { effects: [pop], time: 100 }).circles.count).toBe(1);
  });
});
