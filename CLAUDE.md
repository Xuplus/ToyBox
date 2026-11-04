# CLAUDE.md — ToyBox

Context for AI agents working in this repo. Keep this file short; see
[`PLAN.md`](./PLAN.md) for the full design and
[`PERFORMANCE.md`](./PERFORMANCE.md) for the measured budget and the roadmap.

## What this is

A **2D physics sandbox**: a box you drop toys into and knock about. Balls with
different weight and bounciness, blocks (some shatter on impact), conveyor
belts, ball spouts that keep feeding the box, and musical blocks that play a note
when something hits them. You can grab anything with the mouse and throw it.
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
- `src/toys/` — the **toy registry**. `catalog.ts` is the one file to edit to add
  a toy: each `ToyDef` knows its palette metadata and how to build its Matter
  body. `meta.ts` keeps per-body metadata (colour, belt speed, break threshold,
  pitch, spawner rate) in a `WeakMap`.
- `src/engine/` — `ToyBoxEngine.ts` owns the RAF loop, pointer input
  (spawn / drag / delete), collision handling (note strikes, shattering), the
  spawners, the playfield scale and body limits. Drawing goes through a
  **`Painter`** (`scene.ts`): `createPainter` gives the engine a WebGL2 painter
  if the browser will provide one and the canvas 2D painter otherwise.
- `src/engine/gl/` — the default painter. `pack.ts` turns a `Scene` into flat
  instance arrays (this is the old `render.ts` body, turned inside out), and
  `GLRenderer.ts` submits them as one instanced draw call per shape family.
  `shaders.ts` holds the GLSL; the layouts in `instances.ts` are the contract
  with it. `labels.ts` is the note-name texture atlas. It is pure enough to unit
  test — `pack.test.ts` never creates a GL context.
- `src/engine/render.ts` — the canvas 2D painter: one body at a time, real
  paths and gradients. It is the fallback (`?render=2d`) and the reference the
  instanced path is checked against, so a change to the look usually lands in
  both.
- `src/lib/` — `frame-meter.ts` (rolling window of frame durations → fps, p95,
  mean) and `color.ts` (shade/alpha). Pure, no DOM.
- `src/physics/grains.ts` — the **granular layer**: sand and water. Circles in
  `Float32Array`s, counting-sort uniform grid, relaxation passes, no rotation, so
  it is for piles rather than shapes. ~0.5 µs per *moving* grain against matter's
  9, and a settled pile sleeps, so it is cheaper again once it stops.
  `MATERIALS` at the top of the file is the only description of what each
  material is: colour, alpha, rim, friction, restitution, cohesion, rolling
  resistance, whether it can hold a body up (`support`) and how hard it takes a
  body's speed away (`grip`), whether it is drawn as a liquid, and how it sleeps.
  Both painters read it, so a new material is one entry.
- `src/engine/sprites.ts` — pre-rendered ball sprites, **canvas 2D path only**.
  Drawing a ball from gradients costs ~4× a blit; at a thousand balls that is a
  third of the frame. The WebGL path shades circles in a fragment shader and
  needs none of this.
- `src/debug.ts` — the `?bench=N` hook. Not part of the toy: see below.
- `src/audio/` — `notes.ts` (scale + note naming, pure) and `synth.ts` (a tiny
  WebAudio synth — every sound is generated, no audio files).
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
  (see `SLEEP_WINDOW`/`SLEEP_DRIFT` in `grains.ts`). Do not "simplify" that to a
  velocity threshold: the heap will never sleep.
- **A contact must kill the velocity it is holding.** `step()` accumulates the
  direction each grain was pushed (`supX`/`supY`) and removes that component of
  its velocity at the end of the step. Without it a supported grain keeps the
  gravity step it was given, and the heap creeps for ever — which is what makes
  sleep freeze a pile in a shape it was still falling out of, and makes waking
  one look like an explosion. Tangential motion must stay untouched, or sand
  stops flowing and water stops levelling.
- **Perfect circles roll for ever.** `rolling` in `MATERIALS` is the only reason
  a flat layer of grains ever stops: 0.9 for sand, and 1 (none) for water. It
  applies only to contacted grains slower than `ROLL_SPEED`, so a falling stream
  is unaffected.
- **The coupling is a constraint, never a force.** `supportImpulse` and
  `dragImpulse` in `grains.ts` take speed *out of* a body along the contact
  normal and may carry its weight; they may never add speed. `holdFx/holdFy` is
  the part of the load that points up (what the body stands on), `loadF` is the
  full sum (the weight a pile leaves on a crate), and `grip` is how hard the
  medium can take a body's speed away, per contact. The old design re-applied the
  grain's momentum change as a force on the next step with a gain of 300; it
  looked fine in a screenshot and it was a delayed spring, which is why a dune
  used to throw a ball back out. Do not reintroduce a force here.
- **Buried bodies need the upward contacts only.** Without a pressure field, a
  body one radius into a pile has as many contacts above it as below, so the net
  sum is zero and it sinks for ever. `holdF` keeps just the ones pushing it up.
  A real fix is a density constraint, not a bigger sum - see `PLAN.md §10`.
- **A liquid is drawn, not simulated.** `liquid` in `MATERIALS` switches the dot
  pipeline to a flat fill with a feathered edge and no specular (`aLiquid` in
  `shaders.ts`), which is what makes a cluster read as one body of water. The
  physics underneath is still circles; do not expect pressure or buoyancy.
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
   is `makeSource` plus a `GrainMaterial` in `MATERIALS`.
2. Add its `toy_<id>` name to both dictionaries in `src/i18n.ts`.
3. Add a test in `src/toys/catalog.test.ts` only if it behaves unusually (the
   existing loops already build every registered toy).

## Current status & next steps

Working: gravity, dragging/throwing with a soft constraint, spawning by click,
delete tool and right-click delete, four balls, five blocks (including a static
wedge ramp), breakable glass and brick, two conveyor belts, a ball spout, sand
and water hoppers that pour into the box and are drawn by the same renderer,
pitched note blocks (C major pentatonic, cycling), pause, mute, clear, EN/ES,
responsive palette, a live FPS/bodies readout, and the playfield size control.

Performance is measured, not estimated: `PERFORMANCE.md` has the curves and
`npm run bench` reproduces them. The short version: **neither painter is the
wall** — WebGL2 draws anything from 500 to 20,000 bodies in 0.06–0.5 ms — and
the two ceilings are 9 µs per rigid body (matter, ~2,000 of them at 60 Hz) and
packing density for grains (8,000 moving grains is 4.9 ms; the same 8,000
settled is 0.29 ms; a box packed past ~60% never settles at all).

Ideas still open (see `PLAN.md §8`): saving a scene in `localStorage`, a
"shake" button, funnels/dominoes as extra toy families, ropes and explosives on
Matter constraints, a sound-block octave toggle, better mobile affordances
(tap-to-place ghost), a worker to buy a frame of headroom, and the dashboard
card + `deploy.config.json` entry.
