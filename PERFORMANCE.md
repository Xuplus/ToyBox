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

## 7. Should we port the engine? Measured: no

Before committing to a Rapier2D port I ran the two engines side by side in the
same browser, same scene, same 60 Hz step, timing only the step call
(`bench/`, `npm run shootout`). Bodies are laid out at **constant density** —
the box is divided into exactly `n` cells — so this compares cost per body, not
how fast each engine crushes a pile.

Circles (ms per step):

| bodies | matter | rapier | ratio |
|---:|---:|---:|---:|
| 500 | 1.84 | 0.72 | 2.5× |
| 1 000 | 4.14 | 1.86 | 2.2× |
| 2 000 | 9.61 | 2.95 | 3.3× |
| 5 000 | 30.07 | 12.01 | 2.5× |
| 10 000 | 64.32 | 81.69 | **0.8×** |
| 20 000 | 175.69 | 953.61 | **0.2×** |

Boxes:

| bodies | matter | rapier | ratio |
|---:|---:|---:|---:|
| 500 | 0.54 | 1.26 | **0.4×** |
| 1 000 | 1.14 | 1.62 | 0.7× |
| 2 000 | 2.48 | 5.44 | 0.5× |
| 5 000 | 6.92 | 25.27 | 0.3× |
| 10 000 | 13.78 | 70.26 | 0.2× |
| 20 000 | 39.33 | 244.57 | 0.2× |

**Rapier is 2–3× faster for circles at moderate counts and then falls off a
cliff; for boxes it is 2–5× slower than matter-js at every count.** That is the
opposite of the published native benchmarks (0.5 µs/body, 20× cheaper), and it
kills the port: we would trade a week of work for a wash on circles and a
regression on the boxes the toy is full of. Add the 3.4 MB WASM payload and the
JS↔WASM boundary on top and it is not close.

The likely reasons, for the record: the JS bindings ship a single-threaded,
non-SIMD WASM build; the native numbers assume the parallel solver; and a 2D
box stack is exactly the case where matter's warm-started contact solver does
well.

### The measurement that actually matters: drawing

| bodies | canvas2d `drawImage` per body | one instanced draw call |
|---:|---:|---:|
| 5 000 | 8.16 ms | **0.34 ms** |
| 10 000 | 17.11 ms | **0.38 ms** |
| 20 000 | 29.65 ms | **0.51 ms** |
| 50 000 | — | **0.86 ms** |

**58× at 20,000 bodies, and it is flat.** (Measured through SwiftShader, i.e.
software GL — a real GPU is faster still.)

This reframes everything: at 20k bodies the *renderer* was eating 30 ms of a
16.7 ms budget and the engine was being blamed for it. With instancing, 20k
bodies cost half a millisecond to draw, and the whole budget belongs to physics.

---

## 8. Roadmap

Ordered by (win ÷ cost), revised after §7. Effort: S ≈ hours, M ≈ days,
L ≈ a week+.

| # | change | cost | win | status |
|---|---|---|---|---|
| 1 | **WebGL2 instanced renderer** | M | draws 58× at 20k; makes any body count possible | todo |
| 2 | **Granular layer as a real toy** (sand/dust/water, cohesion) | M | 5–12× per body for circles | prototype |
| 3 | Matter circle fast path in `Collision.collides` | S | 1.8–2.5× on the rigid step | todo |
| 4 | `enableSleeping` for settled scenes + islands | S | large when the box is idle | not wired |
| 5 | Ropes/chains/explosives on Matter constraints + impulses | S | none — pure capability | todo |
| 6 | Worker + `SharedArrayBuffer` + interpolation | M | +16.7 ms budget, no jank | todo |
| 7 | Own SoA rigid solver (convex polys + circles + joints) | L | 3–5× over matter on rigid | not started |
| 8 | ~~Rapier2D port~~ | — | **ruled out by measurement** | — |

Notes:

- **(1) is the unlock, and it is not optional.** With the renderer at 0.5 ms, a
  10k-body box needs only ~16 ms of physics; today's canvas costs 17 ms before
  physics starts. Everything else in this table is secondary to it.
- **(2) is what the user actually asked for** — a body that is *not* a rigid
  body: thousands of grains that look like sand or water. The prototype already
  does 10k in 12.5 ms; cohesion (a small attractive term between neighbours) and
  two relaxation passes instead of three are the remaining tuning.
- **(3)** is ~80 lines and a test. Do it when the rigid path matters again.
- **(6)** buys no speed, it buys a frame of headroom. Requires cross-origin
  isolation headers on the Caddy side ([MDN SAB](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)).
- **(7)** is only worth it if rigid *polygons* ever need to go past a couple of
  thousand. Until then matter is fine at that scale and it already does ropes,
  belts, stacks and shattering.

---

## 9. Verdict

**Tens of thousands of *bodies* at 60 Hz: yes. Tens of thousands of *rigid
bodies*: no — and no engine change is needed to know that.**

The measured budget at 60 Hz is 16.7 ms:

| workload | physics | draw (instanced) | total |
|---|---:|---:|---:|
| 1 000 matter balls | 4.1 ms | 0.1 ms | 4.2 ms |
| 10 000 matter boxes | 13.8 ms | 0.4 ms | 14.2 ms ✅ |
| 10 000 grains | 12.5 ms | 0.4 ms | 12.9 ms ✅ |
| 20 000 grains | 29.6 ms | 0.5 ms | 30.1 ms ✗ |
| 20 000 matter circles | 176 ms | 0.5 ms | 176 ms ✗ |

So the honest ceiling right now is **~10,000 dynamic bodies at 60 Hz** — as
grains or as settled boxes — and the two things standing between that and 20k
are solver cost, not rendering and not the engine brand:

- fewer relaxation passes / fewer solver iterations (quality trade)
- skipping bodies that are at rest (islands, sleeping)
- a worker so a 20 ms step can run at 50 Hz while the screen stays at 60

And for the toy box specifically, the split that makes sense is the one the
numbers describe:

1. **Rigid layer** (matter today): boxes, ramps, belts, ropes, note blocks,
   explosives. Hundreds to a couple of thousand. It rotates, stacks and
   shatters properly, and it is not the bottleneck.
2. **Granular layer** (own solver): balls, sand, water, shards. Tens of
   thousands. No rotation — which the renderer never showed anyway — with
   cohesion, jetting and drag on top for liquids.
3. **One renderer** for both: instanced circles, batched polygons, 0.5 ms at 20k.

That combination is what "the same quality but much faster" looks like here, and
every step of it is now measured rather than assumed.

