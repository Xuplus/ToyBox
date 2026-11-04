import type Matter from 'matter-js';
import type { ToyMeta } from './types';

// Body metadata lives in a WeakMap rather than Matter's `plugin` bag: it is
// typed, it can't collide with a future plugin, and it disappears with the body.
const META = new WeakMap<Matter.Body, ToyMeta>();

export function setMeta(body: Matter.Body, meta: ToyMeta): Matter.Body {
  META.set(body, meta);
  return body;
}

export function metaOf(body: Matter.Body): ToyMeta | undefined {
  return META.get(body);
}

/** True for extra decorations/fragments (not user-placed toys). */
export function isShard(body: Matter.Body): boolean {
  return META.get(body)?.shard === true;
}
