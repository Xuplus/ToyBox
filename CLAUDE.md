# CLAUDE.md — ToyBox

Context for AI agents working in this repo. Keep this file short; see
[`PLAN.md`](./PLAN.md) for the full design and
[`PERFORMANCE.md`](./PERFORMANCE.md) for the measured budget and the roadmap.

## What this is

A **2D physics sandbox**: a box you drop toys into and knock about. Balls with
different weight and bounciness, blocks (some shatter on impact), conveyor
belts, ball spouts that keep feeding the box, musical blocks that play a note
when something hits them, sand and water, five gadgets (a bomb, a balloon, a
fan, a trampoline and a black hole), and ropes and chains you can tie between
any two things. You can grab anything with the mouse and throw it.
Nothing is stored and nothing is uploaded — the whole simulation runs on the
device.

The header shows a live **frame-rate readout** and a **playfield size** control
(1×–2.5×) that zooms the world out, so more toys fit in the same screen space.

Think Desktop Destroyer / The Incredible Machine as a toy shelf.

## Architecture — pure static, NO backend

Unlike the realtime games on this domain (Impostor, Daero's Quiz), this app is
**single-player and client-only**: no Node process, no port, no pm2, no
Socket.IO. It is hosted on **elnuevos.es** under **/toybox** as a **static
bundle served by Caddy**, and the `/toybox` prefix is baked into the build via
**`BASE_PATH`** so its assets can't collide with the sibling apps.

- `vite.config.ts` derives Vite `base` from `BASE_PATH` (`/toybox/`); local dev
  stays at `/` on port **5175**.
- `deploy/setup.sh` builds with `BASE_PATH=/toybox` and publishes `dist/` to
  `/var/www/toybox`; `deploy/Caddyfile` holds the `handle_path /toybox*` block.
- Never hard-code the `/toybox` prefix in app code — only `deploy/` holds it.

## Layout

- `src/physics/` — the simulation shell around **Matter.js**, framework-free and
  unit-tested:
  - `world.ts` — engine, gravity, the four box walls (they sit *outside* the
    visible area, so the canvas edge is the inside of the box), fixed 60 Hz
    step, clamping/resizing.
  - `conveyor.ts` — belts. Matter has no surface velocity, so a belt blends the
    horizontal velocity of anything resting on it toward the belt speed (and
    spins circles so they roll).
  - `shatter.ts` — pure geometry: lay a grid of rotated shards over a broken
    body. Mutation lives in the engine.
  - `spawner.ts` — pure emission schedule for the ball spout: how many balls are
    owed this step, and what carries to the next one (burst-capped).
  - `fields.ts` — the gadgets' maths: blast falloff and speed, the fan's wind
    column and `windDelta`, the black hole's pull, the trampoline's launch, a
    balloon's lift. Pure numbers in Matter units; the engine only loops.
  - `rope.ts` — ropes and chains without a box: where the links of a new rope
    go (`ropeLayout`, sagging on a parabola), where on a body it ties
    (`surfaceAnchor`), how the links are joined (`joinLinks`) and how far a
    joint has opened (`jointGap`).
- `src/toys/` — the **toy registry**. `catalog.ts` is the one file to edit to add
  a toy: each `ToyDef` knows its palette metadata and how to build its Matter
  body. `meta.ts` keeps per-body metadata (colour, belt speed, break threshold,
  pitch, spawner rate, rope link) in a `WeakMap`, and `countsAsToy` (a shard
  is not a toy, and a rope is one toy however many links it has). `tie.ts`
  builds a whole rope between two `Tie`s - a toy def with `rope` set is placed
  by tying, not by a click.
- `src/engine/` — `ToyBoxEngine.ts` owns the RAF loop, pointer input
  (spawn / drag / delete / tap to turn), collision handling (note strikes,
  shattering, bombs, balloons, trampolines), the spawners, the gadgets (the
  section of that name), the playfield scale and body limits. Drawing goes through a
  **`Painter`** (`scene.ts`): `createPainter` gives the engine a WebGL2 painter
  if the browser will provide one and the canvas 2D painter otherwise.
- `src/engine/gl/` — the default painter. `pack.ts` turns a `Scene` into flat
  instance arrays (this is the old `render.ts` body, turned inside out), and
  `GLRenderer.ts` submits them as one instanced draw call per shape family.
  `shaders.ts` holds the GLSL; the layouts in `instances.ts` are the contract
  with it. `labels.ts` is the note-name texture atlas. It is pure enough to unit
  test — `pack.test.ts` never creates a GL context.
- `src/engine/gadgets.ts` — how the gadgets look, as numbers: colours, the fuse
  burning down, fan blades and wind streaks, the trampoline's dip, the specks
  falling into a black hole, and the rings of the blast/pop/gulp `Effect`s.
  Both painters read it, so they animate the same way.
- `src/engine/render.ts` — the canvas 2D painter: one body at a time, real
  paths and gradients. It is the fallback (`?render=2d`) and the reference the
  instanced path is checked against, so a change to the look usually lands in
  both.
- `src/lib/` — `frame-meter.ts` (rolling window of frame durations → fps, p95,
  mean) and `color.ts` (shade/alpha). Pure, no DOM.
- `src/physics/grains.ts` — the **granular layer**: sand and water. Circles in
  `Float32Array`s, counting-sort uniform grid, no rotation, so it is for piles
  rather than shapes. Two solvers share the grid: **sand** is contacts with
  Coulomb friction (pairs found once per step into a list, then Gauss-Seidel
  passes over it), **water** is Clavet double-density relaxation (Jacobi, two
  iterations over a stored neighbour list). Well under matter's 9 µs per
  *moving* grain, and still water and settled sand sleep.
  `MATERIALS` at the top of the file is the only description of what each
  material is: colour, alpha, rim, friction, restitution, mass, rolling
  resistance, whether it can hold a body up (`support`) and how hard it takes a
  body's speed away (`grip`), whether it is a liquid, and how it sleeps
  (`sleepWindows`, `sleepDrift`). `FLUID` holds the liquid solver's constants.
  Both painters read `MATERIALS`, so a new material is one entry.
- `src/engine/sprites.ts` — pre-rendered ball sprites, **canvas 2D path only**.
  Drawing a ball from gradients costs ~4× a blit; at a thousand balls that is a
  third of the frame. The WebGL path shades circles in a fragment shader and
  needs none of this.
- `src/debug.ts` — the `?bench=N` hook. Not part of the toy: see below.
- `src/audio/` — `notes.ts` (scale + note naming, pure) and `synth.ts` (a tiny
  WebAudio synth — every sound is generated, no audio files: notes, crack,
  boom, pop, boing, gulp).
- `src/ui/` — `TopBar` (home, pause, mute, clear, language) and `Palette`.
- `src/i18n.ts` — EN/ES, auto-detected, with a toggle. Matches the siblings.

## Commands

```bash
npm install
npm run dev          # local dev (:5175)
npm run typecheck
npm run test         # vitest — physics/, toys/, audio/, lib/ pure logic
npm run build        # tsc --noEmit + vite build → ./dist
npm run bench -- --url http://127.0.0.1:4173/ --sizes 0,500,1000
                     # headless frame-rate measurement, see PERFORMANCE.md
npm run bench -- --url "http://127.0.0.1:4173/?render=2d" --sizes 0,2000
                     # ...and the same scene through the fallback painter
npm run profile       # CPU profile: which function inside the step costs what
npm run shootout      # matter vs rapier, canvas vs instanced (bench/)
```

Always run `npm run typecheck` and `npm run test` after changes.

## Conventions that matter (don't break these)

- **Pure logic stays pure.** Anything testable (shard geometry, note selection,
  toy construction, conveyor carry) goes in `physics/`, `toys/` or `audio/` and
  must not touch the DOM. The canvas/DOM live in `engine/` and `ui/`.
- **One simulation clock.** The engine steps Matter at a fixed `STEP_MS`
  (60 Hz) with an accumulator, never with the raw frame delta — variable steps
  make the same scene behave differently on a 120 Hz screen.
- **The engine is created once.** `App` mounts it in an effect and drives it
  through a ref (`setTool`, `setPaused`, `setMuted`, `clear`). Never rebuild the
  world on a state change — that would throw away everything in the box.
- **Audio needs a gesture.** `AudioContext` is only created in `Synth.unlock()`,
  called from the first `pointerdown`. Never construct it at module load.
- **Matter units are px per step**, not px per second. Fall speeds are ~10–20,
  so break thresholds and thresholds like `NOTE_THRESHOLD` are in those units.
- **Bodies are capped** (`MAX_BODIES`, currently 2000) so a forgotten spawner or
  a shatter storm can't lock up the tab; the oldest dynamic body is evicted
  first. The cap is set just above where the frame budget breaks (see
  `PLAN.md §9`) — raising it is a deliberate decision, not a knob.
- **Measure, don't guess.** The readout is fed by `FrameMeter` and pushed to
  React at most every 250 ms (`STAT_EVERY`); never put a per-frame `setState`
  in the loop. Timing (`physicsMs`, `drawMs`) is an EMA over frames.
- **The playfield scale is a transform, not a resize.** `setScale` changes
  world-px-per-css-px and rebuilds the walls (`resizeWorld` clamps whatever is
  now outside); the canvas element itself never changes size, so the
  `ResizeObserver` in `App` stays quiet. Drawing code stays in world
  coordinates — only `toWorld()` and `applyScale()` know about the zoom.
- **`?bench=N` is a benchmark switch, not a feature.** It lives in
  `src/debug.ts`, adds `window.__toybox`, and must stay invisible without the
  query parameter. Never call it from product code. `?render=2d|gl` is the same
  kind of switch: it forces a painter for A/B measurement.
- **Both painters draw the same `Scene`.** The scene is plain data; the WebGL
  path packs it (`pack.ts`) and the canvas path walks it (`render.ts`). A new
  toy or visual detail lands in both — check with
  `--eval-file scripts/scenes/showcase.js --shot` on `?render=2d` and the
  default. The GLSL in `shaders.ts` and the strides/offsets in `instances.ts`
  are one contract: change them together, or a toy silently draws as garbage.
- **Never add a `drawImage`/gradient to the hot path.** If it needs per-frame
  geometry, give it an instance and a `pattern` id instead. The whole point of
  the instanced painter is that the cost of a body is a few float writes.
- **The granular layer is a second engine, not a second world.** `ToyBoxEngine`
  owns one `GrainWorld`; it is created on first use and **survives every resize**
  (`resize()` keeps the grains). Grains never become Matter bodies and Matter
  bodies never become grains — they meet through `GrainCollider`, which
  `Matter.Body` satisfies structurally. The solver must not import Matter.
- **A grain's velocity is not a measure of rest.** A packed heap is never
  perfectly still, so sleep is decided on how far a grain moved over a window
  (`SLEEP_WINDOW`, and `sleepDrift` per material). Do not "simplify" that to a
  velocity threshold: the heap will never sleep.
- **Still is not enough to sleep: a grain must be held up.** `cradled()` is a
  friction-cone test — a grain is held if "up" is inside the fan of pushes its
  neighbours, the floor and the side walls give it. A grain perched on the
  outside of one neighbour is still sliding and must not be frozen there; that
  was the "floating sand" bug. Waking is the other half: a grain that moves a
  radius marks its cell dirty, and the sleepers above it are woken on probation
  (`wakeDirty`), with `audit()` re-checking a slice of sleepers every step as a
  safety net. `wakeIn()` adds its own margin, so callers pass the bare bounds.
- **Water holds nothing up, and sleeps a whole body at a time.** Sand is not
  cradled by drops, so it sinks through a pool; only sand that has stopped,
  jammed on drops, may sleep on them, and it is flagged `REST_WATER` so moving
  water wakes it (dirt left by water alone wakes nothing else). A drop never
  sleeps on its own: `settleLiquid()` floods the cells holding awake water into
  connected bodies and sleeps a body once `POOL_STILL` of it is quiet. Per-drop
  sleep never converged — a stopped drop is a wall its neighbours jostle.
- **The liquid is Jacobi, two iterations.** Displacements are summed and applied
  together. Pair-by-pair (Gauss-Seidel) in index order drives a steady current
  along the bottom of a level pool, so it never sleeps; and a single relaxation
  per step makes a pool ~20 drops deep boil for ever at the bottom. Both are
  pinned by tests in `grains.test.ts`.
- **A contact must kill the velocity it is holding.** `step()` accumulates the
  direction each grain was pushed (`supX`/`supY`) and removes that component of
  its velocity at the end of the step. Without it a supported grain keeps the
  gravity step it was given, and the heap creeps for ever — which is what makes
  sleep freeze a pile in a shape it was still falling out of, and makes waking
  one look like an explosion. Tangential motion must stay untouched, or sand
  stops flowing and water stops levelling.
- **Perfect circles roll for ever.** `rolling` in `MATERIALS` is why a flat
  layer of sand grains stops: 0.9 for sand, and 1 (none) for water. It applies
  only to contacted grains slower than `ROLL_SPEED` and not riding a body, so a
  falling stream and sand on a belt are unaffected. The angle of repose comes
  from `friction` (Coulomb, 0.4 ≈ 32–38°), not from this.
- **Sand friction is on velocity only.** Friction on the position correction
  (a "stick" term) holds a steeper heap and makes the bottom of a deep bed
  shuffle sideways under its own weight for ever, so it never sleeps. A contact
  with a *sleeping* grain allows `SLEEPER_SLOP` (0.15 r) of overlap before it
  pushes, so a grain woken under load does not undo its squeeze in one step and
  wake the bed around it. Both are pinned by the deep-bed test.
- **The coupling is a constraint, never a force.** `supportImpulse` and
  `dragImpulse` in `grains.ts` take speed *out of* a body along the contact
  normal and may carry its weight; they may never add speed. `holdFx/holdFy` is
  the part of the load that points up (what the body stands on), `loadF` is the
  full sum (the weight a pile leaves on a crate), and `grip` is how hard the
  medium can take a body's speed away, per contact. The old design re-applied the
  grain's momentum change as a force on the next step with a gain of 300; it
  looked fine in a screenshot and it was a delayed spring, which is why a dune
  used to throw a ball back out. Do not reintroduce a force here.
- **Sand holds a body up where it touches it, not at its centre.**
  `supportImpulse` takes a `Lever` (the contact point, relative to the centre)
  and splits the impulse between speed and spin, `take / (1/m + arm²/I)`, so a
  plank that lands with one end on a heap tips off it. The weight carried
  there gives a torque (`holdRx/holdRy`), and spin is only damped in proportion
  to grip (`SPIN_GRIP`). Holding a body at its centre of mass was why planks
  and crates never tilted on sand - grains not rotating had nothing to do with
  it. `bodyResponse` puts the pieces together; the engine only applies it.
- **A grain leaves a body the way it came in.** If its move this step crossed
  the body (`entryEdge`, a Cyrus-Beck clip in the body's frame), it is pushed
  back out through that edge; only a grain that was already inside uses the
  nearest edge. "Nearest edge" alone posts sand straight through a 4 px rope
  link.
- **Buried bodies need the upward contacts only.** Without a pressure field, a
  body one radius into a pile has as many contacts above it as below, so the net
  sum is zero and it sinks for ever. `holdF` keeps just the ones pushing it up.
  A real fix is a density constraint, not a bigger sum - see `PLAN.md §10`.
- **A liquid has pressure, but bodies do not feel it.** `liquid` in `MATERIALS`
  switches the solver to double-density relaxation (so water runs and levels)
  and the dot pipeline to a flat fill with a feathered edge and no specular
  (`aLiquid` in `shaders.ts`), which is what makes a cluster read as one body of
  water. The coupling to rigid bodies is still `dragImpulse`: there is no
  buoyancy, so a beach ball sinks.
- **A gadget is a change of speed, applied as a force before the update.**
  `nudge()` turns px/step into the force Matter integrates with gravity, so
  lift, wind and pull all live on the one clock and a paused box stops them.
  Never `setVelocity` from a field every step. Two exceptions, both one-off
  events: a blast sets the speed it throws things at, and a trampoline launch
  is queued in `collisionStart` and applied *after* `Engine.update` - Matter's
  contact solver runs after that event and would overwrite it.
- **Wind is drag towards the air's speed** (`windDelta`, `WIND_TOP`), never a
  constant push: a constant push fires a ball across the box. The same holds
  for grains (`blow(..., top)`).
- **The black hole is a sensor.** `onCollision` skips sensor pairs and
  `buildColliders` skips sensors, so grains fall *in* rather than resting on
  it. Nothing that is being dragged is pulled or eaten.
- **Effects are plain data on the `Scene`** (`effects`, aged by `Scene.time`,
  capped at 64). A new flash is an `Effect` kind plus a case in `effectRings`.
- **Tap to turn.** A press that stays within `TAP_SLOP` (5 css px) of where it
  started is a tap, not a drag; on release a static toy with `turn` in its
  metadata turns by that many radians. Dynamic bodies have no tap.
- **A rope is links plus joints, and the engine owns the joints.** Every
  constraint of a rope is in `this.joints` with its `snapAt`; `snapJoints()`
  runs after `Engine.update`, and `detach(body)` must run wherever a body
  leaves the world (`remove`, `enforceLimit`, a black hole), or a joint is left
  pulling on a body that is gone. Links of one rope share a negative collision
  group; the two end links collide with nothing. Grains see links as ordinary
  colliders, listed after the other toys so the 512-collider cap drops rope
  before crates. Ropes tie to toys and pins, never to grains.
- **`CONSTRAINT_ITERATIONS` is 10, not Matter's 2.** At 2 a rope is a bungee.
  Matter applies a constraint's stiffness on every pass, so anything tuned per
  step (the drag constraint) goes through `perPass()`; a new constraint that is
  not a rope joint needs the same.
- **Shared header UX.** Top bar in normal flow — home (`🏠`, `href="/"` → the
  `elnuevos.es` root) + `🧰` title on the left, controls and language on the
  right. Never absolutely positioned. Mirrors the sibling games.
- **Deploy does a CLEAN install.** `package-lock.json` is git-ignored (a
  lockfile generated on one OS trips npm's optional-deps bug, npm/cli#4828, and
  the linux `rollup` binary goes missing); `deploy/setup.sh` runs
  `rm -rf node_modules package-lock.json && npm install`.

## Adding a toy

1. Add an entry in `src/toys/catalog.ts` (`makeBall` / `makeBlock` / `makeBelt` /
   `makeSpawner` / `makeSource` cover the current shapes) and add it to a
   `PALETTE_GROUPS` list. A non-rectangular body sets `shape: 'poly'` on its
   metadata and is drawn from its Matter vertices (see `ramp`). A pouring hopper
   is `makeSource` plus a `GrainMaterial` in `MATERIALS`. A rope-like toy is
   `makeRope` with a `RopeSpec` (link size, weight, sag, `snapAt`); its look
   is a case in `linkLook` (`gadgets.ts`), which both painters read.
2. Add its `toy_<id>` name to both dictionaries in `src/i18n.ts`.
3. Add a test in `src/toys/catalog.test.ts` only if it behaves unusually (the
   existing loops already build every registered toy).

## Current status & next steps

Working: gravity, dragging/throwing with a soft constraint, spawning by click,
delete tool and right-click delete, four balls, five blocks (including a static
wedge ramp), breakable glass and brick, two conveyor belts, a ball spout, sand
and water hoppers that pour into the box and are drawn by the same renderer,
pitched note blocks (C major pentatonic, cycling), the five gadgets (bomb with
chain reactions, balloon, fan, trampoline, black hole - `PLAN.md §8`), ropes
and chains tied between any two toys or pins (drag from one to the other, or
tap both ends), bodies that tilt and roll on sand, tap to
turn a fan or trampoline, pause, mute, clear, EN/ES,
responsive palette, a live FPS/bodies readout, and the playfield size control.

Performance is measured, not estimated: `PERFORMANCE.md` has the curves and
`npm run bench` reproduces them. The short version: **neither painter is the
wall** — WebGL2 draws anything from 500 to 20,000 bodies in 0.06–0.5 ms — and
the ceiling is 9 µs per rigid body (matter, ~2,000 of them at 60 Hz). Grains
are ~0.4 µs each while they move (8,000 falling sand grains is 3.9 ms) and
nearly free asleep (the same 8,000 settled is 0.21 ms); a box 82% full of r=5
sand settles to zero awake. What costs is water that is really moving - a pool
with sand sinking through it stays awake until it stops (`PLAN.md §10` has what
shipped, what was tried and rejected, and what is still open).

Ideas still open (see `PLAN.md §8`): saving a scene in `localStorage`, a
"shake" button, funnels/dominoes/springs as extra toy families, a light
"string" so balloons can lift a rope, a sound-block octave toggle, better mobile affordances
(tap-to-place ghost), a worker to buy a frame of headroom (it must own both
engines - see `PLAN.md §10`), and the dashboard
card + `deploy.config.json` entry.
