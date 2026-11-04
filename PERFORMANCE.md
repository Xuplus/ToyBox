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

- **The renderer is solved.** The scene now goes to the GPU as a handful of
  instanced draw calls: **0.06–0.5 ms to draw anything from 500 to 7,747
  bodies**, against 8.6–12.6 ms for canvas 2D at the top of that range (143–180×).
  A 7,747-grain box went from 13 fps to 72 fps on the same machine.
- Today: **~9 µs per body per step** on the rigid path, so the 60 Hz ceiling for
  Matter bodies is ~1350–2000. Physics is now the *only* thing in the frame
  budget, which is the point.
- **48% of a step is narrowphase collision detection**, and it is expensive
  because matter-js has no circle primitive — a "circle" is a 10–25-gon, so
  every ball–ball contact is polygon SAT. This is *not* the bottleneck anyone
  usually blames (the per-step `bodies.sort` is 0.7%).
- Solver is 29%, broadphase 9%, integration 2%, rendering ~2%.
- A typed-array granular solver does the same for piles of small round things in
  **~0.2 µs per moving grain**, and it is now a first-class toy: sand and water
  pour from hoppers, bury crates, ride belts, and **sleep when they settle**, so
  8,000 settled grains cost 0.17 ms - less than 8,000 moving ones cost per
  frame of a 60 Hz budget by a factor of ten.
- The wall for grains is *packing density*, not body count: past ~60% of the
  box the contact graph is over-constrained, the pile never settles, and the
  step time goes up an order of magnitude. The wall for rigid bodies is matter's
  9 µs/body. Neither is the renderer, which is the point.

---

## 2. Tools

```bash
npm run build && npx vite preview --port 4173 &
npm run bench -- --url http://127.0.0.1:4173/ --sizes 0,500,1000,2000
npm run bench -- --url http://127.0.0.1:4173/ --grain-sweep --sizes 5000,10000,20000
npm run bench -- --url "http://127.0.0.1:4173/?render=2d" --sizes 0,500,2000   # A/B the painters
npm run profile            # CPU profile, 4 s at 2000 bodies
```

`scripts/bench.mjs` drives the real build in a headless browser over the
DevTools protocol (dependency-free WebSocket client in `scripts/cdp.mjs`):

| flag | does |
|---|---|
| `--sizes 0,500,1000` | fill the box with N Matter balls, settle, sample |
| `--grain-sweep` | same, but N grains |
| `--scale 2.5` | playfield multiplier |
| `--render 2d` | force the canvas 2D painter instead of WebGL2 |
| `--sleeping` | `engine.enableSleeping = true` |
| `--iterations 3,2` | position/velocity solver iterations |
| `--no-sprites` | vector renderer instead of sprite blits (canvas 2D only) |
| `--profile 4` | CPU profile, self time per function |
| `--spawners 6 --seconds 80` | let spouts fill the box and watch it degrade |
| `--eval-file f.js` | run a script in the page (`scripts/scenes/*.js`) |
| `--shot out.png` | screenshot the result |

`?bench=N` in the URL is the switch the harness uses: it fills the box, clears
the starter scene and exposes `window.__toybox`
(`src/debug.ts`). It is inert without the parameter. `?render=2d|gl` forces the
painter, for A/B measurement and screenshots.

**Read `est-60hz`, not `fps`.** Headless has no vsync and its compositor ticks
at ~145 Hz, so the raw figure tops out at 145 and overstates a 60 Hz display.
The estimate converts the measured main-thread work into what a 60 Hz frame
would cost: physics runs at a fixed 60 Hz whatever the frame rate, so one step
costs `fps × sim ÷ 60`, and a 60 Hz frame is one step plus one draw.

Under WebGL, `draw-ms` is CPU submission time — the GPU work is queued and
asynchronous (see §7). It is still the right number: it is what the main thread
pays.

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

## 6. The granular layer (shipped): sand and water

`src/physics/grains.ts` is a second, much smaller engine for the case that
dominates: thousands of *circles*. Positions and velocities live in
`Float32Array`s, a counting-sort uniform grid does broadphase in O(n), and 3
Gauss-Seidel relaxation passes resolve contacts. No objects per body, no
allocation per step, no rotation.

Rotation is the thing it gives up - and the renderer never draws ball rotation
anyway (`drawBall` uses a fixed gradient), so **for balls the result is visually
identical**.

It is now a toy, not a prototype: two materials (`MATERIALS` in the same file
describes the colour, friction, restitution, cohesion and sleep behaviour of
each), grains collide with every Matter body and leave a load behind (so sand
weighs a crate down and tips it if it is off centre), a conveyor's surface drift
carries whatever rests on it, and a settled pile **sleeps**.

### The number that matters is *moving* grains, not grains

Measured in the app (`?bench`, `box.grains(n)`), box 1416×606, `est-60hz`:

| grains | radius | state | step ms | µs/grain |
|---:|---:|---|---:|---:|
| 2 000 | 3 | all falling | 0.43 | 0.22 |
| 4 000 | 3 | all falling | 0.94 | 0.24 |
| 8 000 | 3 | all falling | 1.70 | 0.21 |
| 4 000 | 3 | settled | **0.17** | 0.04 |
| 8 000 | 3 | settled | **0.17** | 0.02 |
| 7 000 | 5 | 64% packed (a full box) | 4.2 | 0.6 |

Three things fall out of that table:

1. **Asleep grains are nearly free.** 8,000 settled grains cost the same as
   4,000: the sleep window is the only work left, and it is a subtraction.
2. **An awake grain is ~0.2 µs**, so 8,000 of them moving at once is 1.7 ms of a
   16.7 ms budget. This is 6-8× cheaper per body than the 1.5 µs/body the first
   prototype measured, because the contact loop no longer does velocity work it
   cannot use.
3. **The ceiling is the box, not the solver.** Pack the same box to 64% and the
   solver can no longer converge: the pile never comes to rest, so nothing
   sleeps, and step time goes up an order of magnitude. At 90% packing (16,000
   grains of r=3) it collapses to 136 ms/step. That is a box *full of sand*, and
   no amount of tuning fixes it - the contact graph is over-constrained.

### What it costs in the toy

A source pours 200 (sand) or 150 (water) grains a second. The stream is awake by
definition, so the price of pouring is the stream: ~400 grains in flight is
0.08 ms. What piles up goes to sleep behind it. The interesting measurement is
therefore the one the toy actually produces - pour for a while and read
`grains` against `grainsAwake` in `stats()`.

### What it gives up, and why that is the right trade

- **Rotation.** Sand shows no rotation anyway. Anything that *does* rotate
  (crates, planks, ropes) stays on the rigid path.
- **Stacking of shapes.** A grain pile is held up by contacts, not by a solver
  that understands torque, so a stack of grains is a heap and not a tower. That
  is exactly what sand does.
- **Water is not a fluid.** Cohesion plus low friction plus translucency reads as
  a liquid at this scale; it does not level like a real one, it does not have a
  pressure field, and it does not float things. A real SPH/PBF solver is a
  different project.

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

### Done: the renderer that shipped, measured in the app

That prototype is now the default painter (`src/engine/gl/`). Re-running the
real app with `scripts/bench.mjs --render 2d|gl` on the same scene gives the
before/after below — 1416×808, dpr 1, headless (software GL), draw time is the
`drawMs` EMA the readout shows:

| workload | canvas 2D | WebGL2 | |
|---|---:|---:|---:|
| 500 balls | 0.56 ms | 0.18 ms | 3.1× |
| 1 000 balls | 1.03 ms | 0.27 ms | 3.8× |
| 1 500 balls | 1.36 ms | 0.48 ms | 2.8× |
| 2 000 balls | 1.83 ms | 0.45 ms | 4.1× |
| 5 000 grains | 8.61 ms | **0.06 ms** | **143×** |
| 7 747 grains | 12.57 ms | **0.07 ms** | **180×** |

and the same 7,747-grain scene, end to end:

| | canvas 2D | WebGL2 |
|---|---:|---:|
| frame rate | 13.1 fps | **71.9 fps** |
| frame time | 76.7 ms | 12.2 ms |
| draw | 12.57 ms | 0.07 ms |

Two honest caveats:

- **`drawMs` under WebGL measures CPU submission, not GPU work.** Instanced
  draws are queued and the rasteriser catches up asynchronously, so 0.07 ms is
  the cost of packing buffers and issuing ~7 draw calls — not the cost of
  shading 7,747 circles. On a real GPU that is still nothing; under SwiftShader
  it eventually shows up as a capped frame rate rather than as draw time. Read
  `drawMs` as "how much of the main thread the painter takes", which is the
  number that decides whether the frame makes its deadline.
- The rigid-body speedup is only 3–4× because sprites had already reduced balls
  to one `drawImage` each. Against the pre-sprite gradient path at 2 000 balls
  it is ~18×. The dramatic win is the case that had no fast path at all: the
  granular layer, where canvas 2D was spending 12.6 ms per frame just blitting
  dots.

What made it fast is not exotic: the whole scene is packed into five flat
`Float32Array`s (`instances.ts` / `pack.ts`) and submitted as one instanced draw
call per shape family. Per-toy detail that used to be a painter branch — bevels,
crate braces, brick joints, plank grain, glass glints, belt chevrons — is now a
`pattern` id the rect shader switches on. The backdrop (gradient, grid, floor
shadow, frame) is one fullscreen quad of procedural fragment shader, which also
removed the per-frame `createLinearGradient` allocations. Note labels are the
one texture: an atlas of the ten note names, rebuilt only when the device scale
would resample it beyond ~2×.

Two bugs fell out of the port, both fixed:

- `alpha(shade('#55617a', 0.45), 0.75)` produced `rgba(NaN, …)` because the
  colour parser only understood hex and `shade()` returns `rgb()`. The canvas
  silently ignored the invalid colour, so belts and the spout were drawn with
  whatever stroke colour the previous toy left behind. `src/lib/color.ts` now
  parses both forms, and `color.test.ts` pins it.
- The "flat fill for shards" branch tested `w < 34 || h < 34`, which quietly
  swallowed the **plank** (176×18) and made its grain-line drawing dead code.
  Both painters now ask `meta.shard`, which is what the branch was always about.

The canvas 2D painter is still here: it is the fallback when WebGL2 is
unavailable (`?render=2d` forces it), and it is the reference the instanced path
was checked against — `scripts/scenes/showcase.js` builds the same deterministic
scene for both, and `scripts/bench.mjs --shot` captures it.

---

## 8. Roadmap

Ordered by (win ÷ cost), revised after §7. Effort: S ≈ hours, M ≈ days,
L ≈ a week+.

| # | change | cost | win | status |
|---|---|---|---|---|
| 1 | **WebGL2 instanced renderer** | M | draws 58× at 20k; makes any body count possible | **shipped** (§7) |
| 2 | **Granular layer as a real toy** (sand + water, cohesion, rigid-body coupling, sleep) | M | 0.2 µs per *moving* grain, free once settled | **shipped** (§6) |
| 3 | Matter circle fast path in `Collision.collides` | S | 1.8–2.5× on the rigid step | todo |
| 4 | `enableSleeping` for settled scenes + islands | S | large when the box is idle | not wired; the granular layer sleeps already |
| 5 | Ropes/chains/explosives on Matter constraints + impulses | S | none — pure capability | todo |
| 6 | Worker + `SharedArrayBuffer` + interpolation | M | +16.7 ms budget, no jank | todo |
| 7 | Own SoA rigid solver (convex polys + circles + joints) | L | 3–5× over matter on rigid | not started |
| 8 | ~~Rapier2D port~~ | — | **ruled out by measurement** | — |

Notes:

- **(1) is done.** The painter now costs 0.06–0.5 ms whatever is in the box, so
  the frame budget is entirely physics. Everything below is about the solver.
- **(2) is done.** Sand and water are in the palette, pour from hoppers, bury
  crates, run down ramps, ride belts, and go to sleep when they settle. The
  measured limit is now the *box*, not the solver: fill it past about 60%
  packing and a grain pile can no longer converge, which is a property of the
  material rather than of the code.
- **(3)** is ~80 lines and a test. Do it when the rigid path matters again.
- **(4)** now matters less: rigid toys are counted in dozens, and the granular
  layer has its own sleep. It becomes interesting when a big stack of planks
  sits still.
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
| 1 000 matter balls | 4.1 ms | 0.3 ms | 4.4 ms |
| 8 000 grains, all moving | 1.7 ms | 0.1 ms | 1.8 ms |
| 8 000 grains, settled | 0.2 ms | 0.1 ms | 0.3 ms |
| 10 000 matter boxes | 13.8 ms | 0.4 ms | 14.2 ms |
| 7 000 grains at 64% packing | 4.2 ms | 0.1 ms | 4.3 ms |
| 16 000 grains at 90% packing | 136 ms | 0.3 ms | 136 ms |
| 20 000 matter circles | 176 ms | 0.5 ms | 176 ms |

So the honest picture is:

- **Granular bodies**: 8,000 moving at once, or the whole box settled, is
  comfortably inside the frame. That is roughly 10× the rigid ceiling, and it
  buys the thing the toy wants - sand you can pour, water you can spill, balls
  you can fill the box with.
- **Rigid bodies**: ~2,000 at 60 Hz, because matter is 9 µs per polygon body.
- **The wall for grains is packing density, not body count.** Past about 60%
  of the box, contacts are over-constrained, the pile never settles, and the
  cost goes up by an order of magnitude. It is a full box of sand at that point.

And for the toy box specifically, the split that makes sense is the one the
numbers describe:

1. **Rigid layer** (matter today): boxes, ramps, belts, ropes, note blocks,
   explosives. Hundreds to a couple of thousand. It rotates, stacks and
   shatters properly, and it is not the bottleneck.
2. **Granular layer** (own solver): sand, water, and anything else that is
   really a pile of small round things. No rotation - which the renderer never
   showed anyway - with cohesion and drag on top for liquids.
3. **One renderer** for both: instanced circles, batched polygons, 0.1 ms at 20k
   - shipped, and no longer the reason anything is capped.

That combination is what "the same quality but much faster" looks like here, and
every step of it is now measured rather than assumed. What is left is capability
rather than speed: ropes, explosives, and a worker to buy a whole extra frame of
headroom.

