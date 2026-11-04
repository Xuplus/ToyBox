# PERFORMANCE.md — where the milliseconds go, and how to buy more bodies

Goal on the table: **tens of thousands of physics bodies at 60 Hz**. This file
records what was measured, what it proves, and the cheapest order in which to
spend effort. Everything here is reproducible with `npm run bench` and
`npm run profile` (see [Tools](#tools)).

Machine: 14" laptop, Edge 156, 1416×672 canvas, device pixel ratio 1, headless
(so the compositor has no vsync and the canvas is CPU-rastered). Where a number
depends on that, it says so.

---

## 1. TL;DR

- Today: **~9 µs per body per step**, a 60 Hz ceiling of ~1350 bodies.
- **48% of a step is narrowphase collision detection**, and it is expensive
  because matter-js has no circle primitive — a "circle" is a 10–25-gon, so
  every ball–ball contact is polygon SAT. This is *not* the bottleneck anyone
  usually blames (the per-step `bodies.sort` is 0.7%).
- Solver is 29%, broadphase 9%, integration 2%, **rendering 2%** — the renderer
  stopped being the problem once balls were blitted from a sprite cache.
- A typed-array granular solver does the same for balls in **0.7–1.6 µs per
  body**, 5–12× cheaper, and is in the tree as `src/physics/grains.ts`
  (`?bench` only, prototype).
- Even so: **10k is the edge, 40k is 60 ms/step.** No JS/WASM rigid-body engine
  gets to tens of thousands at 60 Hz in a browser; that number only comes from a
  particle layer with a batched GPU renderer.

---

## 2. Tools

```bash
npm run build && npx vite preview --port 4173 &
npm run bench -- --url http://127.0.0.1:4173/ --sizes 0,500,1000,2000
npm run bench -- --url http://127.0.0.1:4173/ --grain-sweep --sizes 5000,10000,20000
npm run profile            # CPU profile, 4 s at 2000 bodies
```

`scripts/bench.mjs` drives the real build in a headless browser over the
DevTools protocol (dependency-free WebSocket client in `scripts/cdp.mjs`):

| flag | does |
|---|---|
| `--sizes 0,500,1000` | fill the box with N Matter balls, settle, sample |
| `--grain-sweep` | same, but N grains |
| `--scale 2.5` | playfield multiplier |
| `--sleeping` | `engine.enableSleeping = true` |
| `--iterations 3,2` | position/velocity solver iterations |
| `--no-sprites` | vector renderer instead of sprite blits |
| `--profile 4` | CPU profile, self time per function |
| `--spawners 6 --seconds 80` | let spouts fill the box and watch it degrade |
| `--shot out.png` | screenshot the result |

`?bench=N` in the URL is the switch the harness uses: it fills the box, clears
the starter scene and exposes `window.__toybox`
(`src/debug.ts`). It is inert without the parameter.

**Read `est-60hz`, not `fps`.** Headless has no vsync and its compositor ticks
at ~145 Hz, so the raw figure tops out at 145 and overstates a 60 Hz display.
The estimate converts the measured main-thread work into what a 60 Hz frame
would cost: physics runs at a fixed 60 Hz whatever the frame rate, so one step
costs `fps × sim ÷ 60`, and a 60 Hz frame is one step plus one draw.

---

## 3. Where the time actually goes

CPU profile, 2000 balls, unminified build so function names survive:

| % | function | what it is |
|---:|---|---|
| 29.3 | `Collision.collides` | narrowphase dispatch + record bookkeeping |
| 16.9 | `Collision._overlapAxes` | SAT over polygon axes |
| 15.9 | `Resolver.solveVelocity` | 4 iterations over every pair |
| 8.8 | `Resolver.solvePosition` | 6 iterations over every pair |
| 8.2 | `Detector.collisions` | sort-and-sweep broadphase |
| 2.8 | `Pairs.update` | pair table churn |
| 2.3 | `Body.update` | integrate + re-rotate every vertex |
| 1.9 | `Collision._findSupports` | contact points |
| 1.5 | `Resolver.postSolvePosition` | translate vertices + rebuild bounds |
| 1.5 | `drawImage` | **the entire canvas** |
| 0.7 | `Detector._compareBoundsX` | the sort comparator |

**≈48% narrowphase, 29% solver, 9% broadphase, 2% render.**

### The surprise: circles are polygons

`Bodies.circle` builds a polygon with `sides = ceil(max(10, min(25, radius)))`
vertices — a 14 px ball is a 14-gon. `Collision.collides` then runs SAT over both
bodies' vertices and axes. There is no `circleRadius` fast path in matter-js
0.20 at all. So the most common pair in this app — ball against ball — pays for
a polygon-polygon test to approximate a distance check.

That is why ball piles are so expensive, and it is the single biggest lever on
the current engine (see §5).

### The popular fix that isn't

The well-known matter-js advice is "the per-step `Array.sort` is 25% of the
frame, replace it with insertion sort" ([issue
#1329](https://github.com/liabru/matter-js/issues/1329)). Measured here, the
comparator is **0.7%** — because this scene has 2000 bodies, not 20,000, and the
sweep is dominated by narrowphase, not bookkeeping. Killing the sort would buy
~1.05×. Worth knowing before anyone spends a day on it.

---

## 4. What shipped this round

| change | effect (2000 bodies) |
|---|---|
| ball sprites instead of per-body gradients | draw **8.12 ms → 1.80 ms** (4.5×) |
| `FrameMeter` + fps readout, sim/draw split | the numbers above exist at all |
| `?bench` + `scripts/bench.mjs` + profiler | reproducible measurement |
| granular solver prototype (`physics/grains.ts`) | 5–12× cheaper per body |

Rendering is no longer a target until the physics is ~5× cheaper: at 2000
bodies the canvas is 1.8 ms of a 17 ms step.

---

## 5. Matter levers, measured

Same scene, 7 s settle, 2000 balls:

| config | step | Δ |
|---|---:|---|
| baseline (6 position / 4 velocity iterations) | 17.1 ms | — |
| `enableSleeping` | 17.2 ms | **none** |
| iterations 3 / 2 | 15.3 ms | −10% |
| vector renderer (for reference) | 18.1 ms (+6.3 ms draw) | +37% |

**Sleeping does nothing here**, and that is the correct result, not a bug: this
box holds 2000 balls of 28 px in 951k px², i.e. 1.4× the area they need, so the
pile is permanently over-packed and nothing ever holds still for 60 frames.
Sleeping helps a box that is *settled*; it cannot rescue an over-filled one.

**Fewer iterations** is a real −10% for a real quality cost (softer stacks).
Worth a slider, not a default.

**A circle fast path is the big one, and it is not implemented yet.** Patch
`Collision.collides` to test `bodyA.circleRadius && bodyB.circleRadius` first
and return the analytic record (`normal`, `depth`, one support point) instead of
running SAT on two 10–25-gons. Ball–ball contacts are the overwhelming majority
in this app, so the expected win is **1.8–2.5× on the whole step** — bigger than
every other Matter-level change available, for ~80 lines and one risk: the
contact record must match what `Pair.update`/`Resolver` expect, which is why it
wants a unit test against the SAT result rather than a quick patch at midnight.

---

## 6. The granular prototype (how to actually get to tens of thousands)

`src/physics/grains.ts` is a second, much smaller engine for the case that
dominates: thousands of *circles*. Positions and velocities live in
`Float32Array`s, a counting-sort uniform grid does broadphase in O(n), and 3
Gauss–Seidel relaxation passes resolve contacts. No objects per body, no
allocation per step, no rotation.

Rotation is the thing it gives up — and the renderer never draws ball rotation
anyway (`drawBall` uses a fixed gradient), so **for balls the result is visually
identical**.

2.5× playfield (3540×1680), r = 5 grains:

| grains | step ms | µs/body | draw ms | total @60 Hz |
|---:|---:|---:|---:|---:|
| 5 000 | 3.6 | 0.71 | 7.2 | ~11 ms ✅ |
| 10 000 | 12.5 | 1.25 | 13.8 | ~26 ms ❌ |
| 20 000 | 29.6 | 1.48 | 31.1 | ~61 ms ❌ |
| 40 000 | 63.6 | 1.59 | 63.4 | ~127 ms ❌ |

Compare with Matter at 1.25 µs/body… it doesn't: Matter is 8.5–17 µs/body in the
same box. **The granular layer is 5–12× cheaper per body**, and it is the only
thing in this repo that renders 15,000 bodies at all (see the screenshot in
`.shots/grains.png`).

Where it still fails: **the draw**. 1.4 µs per `drawImage` in a CPU-rastered
canvas is 14 ms for 10k — as expensive as the physics. That is a headless
artifact in part (a GPU-composited canvas is much cheaper), but it is also the
warning: at these counts **the renderer becomes the bottleneck again**, and the
answer there is one instanced draw call, not 10,000 `drawImage`s.

---

## 7. Roadmap

Ordered by (win ÷ cost). Effort: S ≈ hours, M ≈ days, L ≈ a week+.

| # | change | cost | expected win | status |
|---|---|---|---|---|
| 1 | Sprite cache for balls | S | draw 4.5× | **done** |
| 2 | Circle fast path in `Collision.collides` | S | 1.8–2.5× total step | todo |
| 3 | Granular layer for balls (+ spawner/link) | M | 5–12× per body | prototype |
| 4 | Batched render: one instanced draw (WebGL2) | M | draw 10–50× at high counts | todo |
| 5 | Worker + `SharedArrayBuffer` + interpolation | M | step time unchanged, +16.7 ms budget, no jank | todo |
| 6 | Swap the rigid core for Rapier2D (WASM) | L | 3–8× on the rigid path | todo |

Notes on the two big ones:

- **Worker + SAB** does not make anything faster; it buys a frame of headroom
  and keeps the UI responsive. Requires cross-origin isolation headers
  (`COOP: same-origin` + `COEP: require-corp`) on the Caddy side —
  `SharedArrayBuffer` is unavailable without them
  ([MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)).
  The pattern: the worker owns the world, writes poses into a double-buffered
  SAB, and the main thread interpolates by `alpha = accumulator/step`. Physics
  can then run at 30 Hz with 60 Hz rendering, which doubles the budget for free.
- **Rapier2D** is the only credible way to move the *rigid* (rotating, stacking)
  path an order of magnitude. Native benchmarks: 20,100-box 2D pyramid in 9–11
  ms single-threaded (~0.5 µs/body — 20× cheaper than Matter here)
  ([dimforge Q3 2026 report](https://dimforge.com/blog/2026/10/25/dimforge-Q3-technical-report/)).
  The browser build is single-threaded WASM, so expect 1.5–2.5× the native
  per-body cost plus JS binding overhead → **3,000–8,000 rigid bodies at 60 Hz**
  is the realistic browser ceiling, not 30,000. Use `@dimforge/rapier2d-simd`
  for the SIMD build. Box2D v3 is the runner-up and is genuinely ~2× faster with
  SIMD ([simd-matters](https://box2d.org/posts/2024/08/simd-matters/)).

---

## 8. The honest answer to "tens of thousands at 60 Hz"

**Rigid bodies: no.** Not in matter-js, not in planck.js, and not in Rapier or
Box2D v3 either — the best WASM engine lands at single-digit thousands of
*simultaneously moving* rigid bodies in a browser, and the numbers people quote
above that are native, multi-threaded, or mostly asleep.

**Bodies: yes, with the split model.** Two layers, one canvas:

1. **Rigid layer** — blocks, ramps, belts, anything that must rotate or stack.
   Hundreds of bodies. Matter today, Rapier when it hurts.
2. **Granular layer** — balls, shards, sand. Tens of thousands, no rotation,
   drawn as blits (and later as one instanced draw call).

That is not a compromise invented here: it is what falling-sand games
(the extreme case — 90,000 cells at 60 fps in Sandspiel
([write-up](https://maxbittker.com/making-sandspiel))) and every large-scale
2D sim does. The toy box is already half-way there: balls do not visually
rotate, so a granular ball is indistinguishable from a rigid one until it has to
push a lever.

Concretely, the path to a 30k-body box at 60 Hz:

- granular layer for balls/shards (done, prototype) → 10k physics in ~12 ms
- one instanced draw call instead of 10k `drawImage`s → draw ~2 ms
- worker + SAB so the 18 ms step runs at 30 Hz while the screen renders at 60
- rigid toys stay on the current engine, a few hundred of them is nothing

The first two are a week of work; the third is another. That gets a *sandbox*
that holds tens of thousands of bodies, without pretending they are all
simulated rigid bodies with rotation and contact manifolds — because they
cannot be.
