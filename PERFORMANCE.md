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
  **~0.4 µs per moving grain**, and it is now a first-class toy: sand and water
  pour from hoppers, bury crates, ride belts, and **go to sleep when they
  settle**, so 8,000 settled grains cost 0.2 ms - a sixteenth of what the same
  8,000 cost while they are still falling.
- Sand and water are two solvers on one grid: sand is Coulomb-friction contacts
  (it heaps at ~33°), water is double-density relaxation (it runs and levels).
  A grain sleeps only when it is *held up*, and wakes when what held it goes, so
  nothing floats (§6).
- At the toy's grain size the box itself is no longer a wall: a box 82% full of
  sand settles to zero awake grains. The wall for rigid bodies is matter's
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
`Float32Array`s, a counting-sort uniform grid does broadphase in O(n), and two
solvers share that grid: sand finds its contacts once per step and runs 5
Gauss-Seidel passes over them with Coulomb friction, water runs two Jacobi
double-density relaxations over a stored neighbour list. No objects per body,
no allocation per step, no rotation.

Rotation is the thing it gives up - and the renderer never draws ball rotation
anyway (`drawBall` uses a fixed gradient), so **for balls the result is visually
identical**.

It is now a toy, not a prototype: two materials (`MATERIALS` in the same file
describes the colour, friction, restitution, mass, support and sleep behaviour
of each), grains collide with every Matter body and leave a load behind (so sand
weighs a crate down and tips it if it is off centre), a conveyor's surface drift
carries whatever rests on it, and a settled pile **sleeps**.

### The number that matters is *moving* grains, not grains

`scatterGrains` into a 1416×606 box, Node (same V8 as Chrome), ms per step.
"Falling" is the first second, "settled" is after 30 s. The previous solver
(3 passes, position friction, sleep on stillness alone) for comparison:

| grains | radius | material | falling, before → now | settled, before → now | awake at 30 s |
|---:|---:|---|---:|---:|---:|
| 4 000 | 3 | sand | 5.60 → **2.37** | 0.21 → **0.11** | 0 |
| 8 000 | 3 | sand | 8.83 → **3.86** | 0.24 → **0.21** | 0 |
| 7 000 | 5 | sand, 64% of the box | 9.60 → **5.97** | 0.21 → **0.15** | 0 |
| 9 000 | 5 | sand, 82% of the box | - → 5.52 | - → **0.15** | 0 |
| 2 000 | 5 | water | 2.29 → 2.57 | 0.07 → **0.04** | 0 |
| 4 000 | 5 | water | 3.91 → **3.00** | 0.16 → **0.07** | 0 (13 before) |

Three things fall out of that table:

1. **Asleep grains are nearly free.** 8,000 settled grains cost 0.2 ms: everything
   asleep is skipped, and the only per-grain work left is the grid and the sleep
   window.
2. **An awake grain is ~0.4 µs** (sand, contacts found once and reused for all
   five passes), so 8,000 of them falling at once is under 4 ms of a 16.7 ms
   budget - more than twice as cheap as the old three-pass solver, which
   re-searched the grid on every pass. That is 20× cheaper per body than
   matter's 9 µs, and the awake count is what a scene should be judged on.
3. **At r=5 the box is not a wall any more.** The old solver's position friction
   kept the bottom of a deep bed shuffling sideways under its own weight; with it
   gone, a box 82% full settles. What is left is radius-dependent: at r=3 (only
   reachable through `?bench`) a bed ~50 layers deep keeps ~2,000 floor grains
   cycling on probation at ~2.8 ms, because one step of gravity is a bigger
   fraction of a small grain's radius. The toy's grains are r=5.

### What it costs in the toy

A source pours 200 (sand) or 150 (water) grains a second. The stream is awake by
definition, so the price of pouring is the stream: ~400 grains in flight is
0.08 ms. What piles up goes to sleep behind it. The interesting measurement is
therefore the one the toy actually produces - pour for a while and read
`grains` against `grainsAwake` in `stats()`.

### Making a pile actually stop

Two things had to be true before sleep could be invisible rather than a glitch:

- **A contact has to kill the velocity it is holding.** A supported grain picks
  up one gravity step per frame and is pushed straight back out of the contact:
  the position comes back, the velocity does not, so the heap churns at
  ~0.3 px/step for ever. Each grain accumulates the contact normal it is being
  pushed along, and that component of its velocity is removed at the end of the
  step. Tangential motion is untouched, so a stream keeps falling while a pile
  stops. Measured effect on a 240-grain heap: mean creep over 30 steps went from
  **8.3 px to 0.01 px**.
- **Perfect circles roll for ever.** Real sand is angular. A contacted grain
  below 1.5 px/step keeps `rolling` (0.9 for sand, 1 - none - for water) of its
  speed per step. Measured effect on 8,000 grains settled in a wide box:
  **3,122 awake became 81**.

With both in place, waking a settled heap moves it by a mean of 1 px, and a grain
arriving at 12 px/step makes a crater instead of an explosion - both pinned by
tests in `grains.test.ts`.

### The other half of the coupling: sand resists

Grains are pushed out of every rigid body, which on its own makes a body an
irresistible force - a ball ploughs through a dune as if it were not there,
because a grain is 1/700 of a body's mass and can take no momentum from it.

The first attempt at a fix recorded the momentum the body gave up (the grain's
velocity change) and re-applied it as a **force** on the next step, with a gain
(300) far above the physical mass ratio to stand in for the jammed pile behind
each grain. It looked right in a screenshot and it was unstable, because a force
that keeps pushing after the body has stopped is a spring - and a spring strong
enough to stop a cannonball is strong enough to throw it back out. Measured with
the probe in `scripts/scenes/shake.js`, **a heavy ball dropped on a settled sand
bed came back up at 10 px/step; in a deep pile the same coupling launched it at
700 px/step.** That is the shaking: not noise, an oscillator.

The coupling is now a **contact constraint**, not a force:

- `supportImpulse` (`grains.ts`) takes speed *out of* the body along the contact
  normal - at most the speed it has, so it can never reverse it - and cancels the
  one step of gravity the medium is carrying. A body at rest stays at rest; a
  body arriving fast is slowed over a few steps and carves a crater.
- The take is a fraction of the incoming speed set by `grip` per contact
  (sand 0.05, water 0.012), with a floor of one gravity step so a supported body
  actually stops instead of sinking a gravity step at a time.
- `dragImpulse` does the same for a medium that cannot hold anything up, so water
  only ever slows a body and never lifts it.
- The support normal is the sum of the contacts that push the body **up**. The
  full sum is the weight a pile leaves on a crate (kept, it tips things), but
  when a body is buried the two cancel exactly and it would sink for ever - there
  is no pressure gradient to favour the grains underneath.

Measured, ball r=18 over a settled bed, `scripts/scenes/shake.js`:

| | old force coupling | contact constraint |
|---|---:|---:|
| ball thrown back up | 9.96 px/step (shallow), 702 (deep) | **0.06 px/step** |
| direction reversals | 3+ | **0** |
| rest after impact | never | 0.9 s |
| pile still awake, 5 s later | 1 226 of 2 210 | 579 of 6 000 |

### Sand and water are not the same material

They used to be: both were the same overlap-push solver with different
friction and a cohesion term, so water was sand that slid. Now they are two
solvers:

| | solver | friction | rolling | mass | support | grip |
|---|---|---:|---:|---:|---:|---:|
| sand | contacts, 5 Gauss-Seidel passes | 0.4 (Coulomb) | 0.90 | 1 | 1 | 0.05 |
| water | double-density relaxation, 2 Jacobi passes | - | 1.00 | 0.15 | 0 | 0.012 |

- **Sand** is a contact list with real Coulomb friction: the tangential impulse
  is capped at μ times the normal one. That is what an angle of repose *is*, and
  a pour now stands at ~32-35° (it was 44° and still climbing, because a
  position-level "stick" term let a heap stand on nothing). Friction acts on
  velocity only; friction on the position correction made the bottom of a deep
  bed shuffle sideways for ever, and is gone.
- **Water** is Clavet et al.'s double-density relaxation (2005): each drop
  measures how crowded its neighbourhood is and the pair pushes apart or pulls
  together to restore a rest density, with a near-density term so two drops
  never merge. That is pressure and surface tension in one pass, so water runs
  off a heap, levels in a box (surface spread over 2,000 poured drops: 64-203 px
  before, **101-106 px** now) and holds a meniscus. Two Jacobi iterations at
  `relax` 0.3: one was not stiff enough for the bottom of a pool 20 drops deep,
  which boiled for ever; Gauss-Seidel in index order drove a current along the
  floor. Both pinned in `grains.test.ts`.
- **Water is light** (0.15) so seepage through a heap does not shove the sand,
  and sand dropped into a pool goes to the bottom.

### Sleep that wakes when it should

The old rule put a grain to sleep when it had been still for a window. A grain
can be still and unsupported - balanced on the shoulder of one neighbour, or the
roof of a tunnel the eraser just dug - and once it slept nothing ever checked
again, so it hung there: the floating sand.

- **A grain sleeps only when it is held up.** `cradled()` is a friction-cone
  test: the pushes from its neighbours, the floor and the walls must fan around
  "up" within the friction angle. A grain perched on the outside of one
  neighbour is still sliding and stays awake.
- **A grain that moves marks its cell dirty**, and sleepers above dirty cells
  are woken on probation (`wakeDirty`). The eraser and a dragged body wake their
  surroundings with a margin (`wakeIn`). `audit()` re-checks a slice of
  sleepers every step as a safety net.
- **Water holds nothing up and sleeps a body at a time.** Sand resting only on
  drops is flagged `REST_WATER` so moving water wakes it; dirt left by water
  alone wakes only water. A drop never sleeps on its own: `settleLiquid()`
  floods the cells holding awake water into connected bodies and sleeps a body
  once 95% of it is quiet. Per-drop sleep never converged - a stopped drop is a
  wall its neighbours jostle.

Measured (Node, 1416×606, r=5):

| scene | before | now |
|---|---|---|
| tunnel dug under a heap's flank | roof floats, 0 grains fall in | **24 grains** refill it |
| 3,000 sand poured, ms/step while pouring | 1.44 | **0.77** |
| 2,000 water poured, ms/step while pouring | 1.38 | **1.04** |
| sand dropped into a 4,000-drop pool | stays on top | sinks, then 0 awake |
| sand and water poured side by side (`pour-both.js`), after the pour | 0 awake at +15 s | 0 awake at +20 s |
| 8,000 r=3 scattered, half sand half water | 0 awake at 13 s | 0 awake at 30 s |

The last two rows are the honest cost. The old solver got quiet sooner because
it froze grains wherever they happened to stop - which is the floating. Now the
water stays awake while sand is still sinking through it and while it sloshes,
and that is real motion: ~2.5-3 ms a step at 3,650 grains, ~12 ms at 8,000 fully
interleaved r=3 grains, for those seconds. Then 0.07-0.2 ms.

### What it gives up, and why that is the right trade

- **Rotation.** Sand shows no rotation anyway. Anything that *does* rotate
  (crates, planks, ropes) stays on the rigid path.
- **Stacking of shapes.** A grain pile is held up by contacts, not by a solver
  that understands torque, so a stack of grains is a heap and not a tower. That
  is exactly what sand does.
- **Pressure.** There is no density constraint and no pressure field, so the
  medium cannot *bear* a load: it can stop a body by removing its speed, but a
  body that is buried is supported only by the grains that happen to be under it,
  and a heavy one creeps down through a deep bed at ~2 px/s. Water cannot push
  back at all, so it has no buoyancy: a cannonball sinks and a beach ball sinks
  too. Both are the same missing ingredient.

### What a pressure solver would cost - prototype, measured

The missing ingredient is a density constraint. The standard 2D implementation
(Position Based Fluids, Macklin & Müller 2013) is close to what is already here:
the same uniform grid, the same typed arrays, but every particle gets a
constraint multiplier `lambda` from its neighbourhood density, and the position
correction is driven by `lambda_i + lambda_j` instead of by overlap. Prototyped
in isolation (~200 lines, Node, same V8), 952 particles in a 600×400 box:

| | ms/step |
|---|---:|
| 3 PBF iterations | 1.30 |
| 3 iterations + XSPH viscosity | 2.34 |

and it does what the current solver cannot:

- a perfect lattice holds its rest density to **1.000** and does not drift at all;
- a dam break levels: surface height spread across 60 columns went from **129 px
  at 0.5 s to 8.4 px at 10 s**, with the last particles below 1.7 px/step;
- a rigid body inside the fluid feels the pressure directly, which is buoyancy -
  no gain constant, no drag model, nothing to tune.

At ~2.4 µs per particle (3 iterations + viscosity) 2,000 water particles is
**~4.8 ms** of a 16.7 ms frame; 2,000 is also about what a 12,000-grain budget
should spend on water, with sand on the cheaper path. Two iterations and a
half-stencil pair walk should roughly halve that.

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
| 2 | **Granular layer as a real toy** (Coulomb sand, double-density water, rigid-body coupling, support-based sleep) | M | ~0.4 µs per *moving* grain, free once settled | **shipped** (§6) |
| 3 | Matter circle fast path in `Collision.collides` | S | 1.8–2.5× on the rigid step | todo |
| 4 | `enableSleeping` for settled scenes + islands | S | large when the box is idle | not wired; the granular layer sleeps already |
| 5 | Ropes/chains/explosives on Matter constraints + impulses | S | none — pure capability | todo |
| 6 | Worker + `SharedArrayBuffer` + interpolation | M | +16.7 ms budget, no jank | todo |
| 7 | Own SoA rigid solver (convex polys + circles + joints) | L | 3–5× over matter on rigid | not started |
| 8 | ~~Rapier2D port~~ | — | **ruled out by measurement** | — |
| 9 | **Density constraint (PBF) for sand and water** | M | pressure on *bodies*: buoyancy, bearing capacity | water levels already (double-density, §6); bodies still feel no pressure |

Notes:

- **(1) is done.** The painter now costs 0.06–0.5 ms whatever is in the box, so
  the frame budget is entirely physics. Everything below is about the solver.
- **(2) is done.** Sand and water are in the palette, pour from hoppers, bury
  crates, run down ramps, ride belts, and go to sleep when they settle - and
  wake when what held them up goes. A box 82% full of r=5 sand settles; the
  remaining limit is a bed ~50 layers of the bench-only r=3 grain.
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
| 8 000 grains, all moving | 3.9 ms | 0.2 ms | 4.1 ms |
| 8 000 grains, settled | 0.21 ms | 0.2 ms | 0.41 ms |
| 10 000 matter boxes | 13.8 ms | 0.4 ms | 14.2 ms |
| 7 000 grains at 64% packing, settled | 0.15 ms | 0.1 ms | 0.25 ms |
| 12 000 r=3 grains, 50 layers deep | 2.8 ms | 0.3 ms | 3.1 ms |
| 20 000 matter circles | 176 ms | 0.5 ms | 176 ms |

So the honest picture is:

- **Granular bodies**: 8,000 moving at once, or the whole box settled, is
  comfortably inside the frame. That is roughly 10× the rigid ceiling, and it
  buys the thing the toy wants - sand you can pour, water you can spill, balls
  you can fill the box with.
- **Rigid bodies**: ~2,000 at 60 Hz, because matter is 9 µs per polygon body.
- **The wall for grains is depth in grains, not body count.** At the toy's
  r=5 a box 82% full settles; a bed ~50 layers of r=3 does not quite, and keeps
  ~2,000 floor grains cycling (2.8 ms). Only `?bench` makes grains that small.

And for the toy box specifically, the split that makes sense is the one the
numbers describe:

1. **Rigid layer** (matter today): boxes, ramps, belts, ropes, note blocks,
   explosives. Hundreds to a couple of thousand. It rotates, stacks and
   shatters properly, and it is not the bottleneck.
2. **Granular layer** (own solver): sand, water, and anything else that is
   really a pile of small round things. No rotation - which the renderer never
   showed anyway - with a second, liquid solver on the same grid for water.
3. **One renderer** for both: instanced circles, batched polygons, 0.1 ms at 20k
   - shipped, and no longer the reason anything is capped.

That combination is what "the same quality but much faster" looks like here, and
every step of it is now measured rather than assumed. What is left is capability
rather than speed: ropes, explosives, and a worker to buy a whole extra frame of
headroom.

