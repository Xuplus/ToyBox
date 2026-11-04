import { describe, expect, it } from 'vitest';
import { shardGrid, shardLayout } from './shatter';

describe('shardGrid', () => {
  it('never goes below 2x2', () => {
    expect(shardGrid(20, 20)).toEqual({ cols: 2, rows: 2 });
  });

  it('never goes above 4x4', () => {
    expect(shardGrid(400, 400)).toEqual({ cols: 4, rows: 4 });
  });

  it('scales with the body size', () => {
    expect(shardGrid(86, 38)).toEqual({ cols: 3, rows: 2 });
  });
});

describe('shardLayout', () => {
  it('produces one shard per cell', () => {
    const shards = shardLayout(0, 0, 100, 60, 0, 3, 2);
    expect(shards).toHaveLength(6);
  });

  it('covers the original rectangle', () => {
    const shards = shardLayout(10, 20, 100, 60, 0, 3, 2, 1);
    for (const shard of shards) {
      expect(shard.x - shard.w / 2).toBeGreaterThanOrEqual(10 - 50 - 1e-9);
      expect(shard.x + shard.w / 2).toBeLessThanOrEqual(10 + 50 + 1e-9);
      expect(shard.y - shard.h / 2).toBeGreaterThanOrEqual(20 - 30 - 1e-9);
      expect(shard.y + shard.h / 2).toBeLessThanOrEqual(20 + 30 + 1e-9);
    }
  });

  it('shrinks the shards so fragments do not start overlapping', () => {
    const shards = shardLayout(0, 0, 100, 100, 0, 2, 2);
    expect(shards[0].w).toBeLessThan(50);
    expect(shards[0].h).toBeLessThan(50);
  });

  it('rotates the layout with the body', () => {
    // A quarter turn maps a local +x offset onto +y in world space.
    const shards = shardLayout(0, 0, 100, 40, Math.PI / 2, 2, 1, 1);
    expect(shards[0].x).toBeCloseTo(0, 6);
    expect(shards[1].x).toBeCloseTo(0, 6);
    expect(shards[0].y).toBeCloseTo(-25, 6);
    expect(shards[1].y).toBeCloseTo(25, 6);
  });
});
