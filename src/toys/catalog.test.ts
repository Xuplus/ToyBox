import { describe, expect, it } from 'vitest';
import { PALETTE_GROUPS, TOYS, toyById } from './catalog';
import { metaOf } from './meta';

describe('catalog', () => {
  it('has unique toy ids', () => {
    const ids = TOYS.map((toy) => toy.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves every toy by id', () => {
    for (const toy of TOYS) expect(toyById(toy.id)).toBe(toy);
    expect(toyById('nope')).toBeUndefined();
  });

  it('lists every toy in exactly one palette group', () => {
    const listed = PALETTE_GROUPS.flatMap((group) => group.ids);
    expect(listed).toHaveLength(TOYS.length);
    expect(new Set(listed).size).toBe(TOYS.length);
    for (const id of listed) expect(toyById(id)).toBeDefined();
  });

  it('gives every toy a positive footprint', () => {
    for (const toy of TOYS) {
      expect(toy.w).toBeGreaterThan(0);
      expect(toy.h).toBeGreaterThan(0);
    }
  });
});

describe('toy bodies', () => {
  for (const toy of TOYS) {
    it(`builds a ${toy.id} with metadata`, () => {
      const built = toy.build(120, 80, { noteIndex: 0 });
      const bodies = Array.isArray(built) ? built : [built];

      expect(bodies).toHaveLength(1);
      const meta = metaOf(bodies[0]);
      expect(meta).toBeDefined();
      expect(meta?.toyId).toBe(toy.id);
      expect(meta?.kind).toBe(toy.kind);
      expect(meta?.w).toBeGreaterThan(0);
      expect(meta?.h).toBeGreaterThan(0);
    });

    it(`places a ${toy.id} where it was dropped`, () => {
      const built = toy.build(120, 80, { noteIndex: 0 });
      const body = Array.isArray(built) ? built[0] : built;
      expect(body.position.x).toBeCloseTo(120, 6);
      expect(body.position.y).toBeCloseTo(80, 6);
    });
  }

  it('makes belts, ramps and note blocks immovable', () => {
    for (const id of ['beltRight', 'beltLeft', 'ramp', 'noteBlock'] as const) {
      const toy = toyById(id)!;
      const built = toy.build(0, 0, { noteIndex: 0 });
      const body = Array.isArray(built) ? built[0] : built;
      expect(body.isStatic).toBe(true);
    }
  });

  it('makes balls and blocks dynamic', () => {
    for (const id of ['ballBouncy', 'crate', 'glass'] as const) {
      const toy = toyById(id)!;
      const built = toy.build(0, 0, { noteIndex: 0 });
      const body = Array.isArray(built) ? built[0] : built;
      expect(body.isStatic).toBe(false);
    }
  });

  it('only marks glass and brick as breakable', () => {
    const breakable = TOYS.filter((toy) => {
      const built = toy.build(0, 0, { noteIndex: 0 });
      const body = Array.isArray(built) ? built[0] : built;
      return metaOf(body)?.breaksAt !== undefined;
    }).map((toy) => toy.id);

    expect(breakable.sort()).toEqual(['brick', 'glass']);
  });

  it('gives each spawned note block the next scale degree', () => {
    const toy = toyById('noteBlock')!;
    const pitches = Array.from({ length: 10 }, (_, index) => {
      const built = toy.build(0, 0, { noteIndex: index });
      const body = Array.isArray(built) ? built[0] : built;
      return metaOf(body)?.midi;
    });

    expect(new Set(pitches).size).toBe(10);
    expect(pitches[0]).toBe(60);
  });

  it('labels note blocks with their pitch', () => {
    const toy = toyById('noteBlock')!;
    const built = toy.build(0, 0, { noteIndex: 0 });
    const body = Array.isArray(built) ? built[0] : built;
    expect(metaOf(body)?.label).toBe('C4');
  });
});
