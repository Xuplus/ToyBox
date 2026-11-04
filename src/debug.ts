import type { PerfStats, Tool, ToyBoxEngine, Tuning } from './engine/ToyBoxEngine';
import type { ToyId } from './toys/types';

/** Small surface for automated measurement. See `installBenchHook`. */
export interface BenchApi {
  stats(): PerfStats;
  /** add `n` more balls without clearing */
  fill(n: number, toyId?: ToyId): void;
  /** drop one toy at a world coordinate */
  place(id: ToyId, x: number, y: number): void;
  /** the simulated box size in world px */
  bounds(): { w: number; h: number };
  clear(): void;
  /** forget the frame window, so the next `stats()` describes the new state */
  reset(): void;
  /** playfield multiplier, same values as the size control */
  scale(n: number): void;
  /** quality/throughput knobs — sleeping, solver iterations, sprite renderer */
  tune(options: Tuning): Tuning;
  /** replace the box with `n` grains (the granular prototype) */
  grains(n: number, radius?: number): number;
  /** select a tool, as the palette would — for reproducible screenshots */
  tool(id: Tool): void;
}

declare global {
  interface Window {
    __toybox?: BenchApi;
  }
}

/**
 * `?bench=N` is a switch for benchmarking, not a feature: it empties the box,
 * fills it with N balls and hangs a tiny API on `window` so a headless browser
 * can drive the simulation and read the frame meter.
 *
 * Without the parameter nothing happens and no global is created, so a normal
 * player never has one.
 */
export function installBenchHook(engine: ToyBoxEngine): void {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('bench')) return;

  const requested = Number(params.get('bench'));
  const count = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0;

  // The starter scene and the opening hint would otherwise sit inside the
  // measurement; a benchmark wants a known box and nothing else.
  engine.skipSeed();
  engine.clear();
  if (count > 0) engine.fill(count);

  window.__toybox = {
    stats: () => engine.stats(),
    fill: (n: number, toyId?: ToyId) => engine.fill(n, toyId),
    place: (id: ToyId, x: number, y: number) => engine.placeToy(id, x, y),
    bounds: () => engine.bounds,
    clear: () => engine.clear(),
    reset: () => engine.resetStats(),
    scale: (n: number) => engine.setScale(n),
    tune: (options: Tuning) => engine.tune(options),
    grains: (n: number, radius?: number) => engine.spawnGrains(n, radius),
    tool: (id: Tool) => engine.setTool(id),
  };
}
