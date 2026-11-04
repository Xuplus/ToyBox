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
- `src/physics/grains.ts` — the **granular layer prototype**: circles in
  `Float32Array`s, counting-sort uniform grid, relaxation passes. No rotation,
  so it is for balls only; 5–12× cheaper per body than Matter. Reached through
  `?bench` (`__toybox.grains(n)`), not yet wired into the toy.
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
- **Shared header UX.** Top bar in normal flow — home (`🏠`, `href="/"` → the
  `elnuevos.es` root) + `🧰` title on the left, controls and language on the
  right. Never absolutely positioned. Mirrors the sibling games.
- **Deploy does a CLEAN install.** `package-lock.json` is git-ignored (a
  lockfile generated on one OS trips npm's optional-deps bug, npm/cli#4828, and
  the linux `rollup` binary goes missing); `deploy/setup.sh` runs
  `rm -rf node_modules package-lock.json && npm install`.

## Adding a toy

1. Add an entry in `src/toys/catalog.ts` (`makeBall` / `makeBlock` / `makeBelt` /
   `makeSpawner` cover the current shapes) and add it to a `PALETTE_GROUPS` list.
   A non-rectangular body sets `shape: 'poly'` on its metadata and is drawn from
   its Matter vertices (see `ramp`).
2. Add its `toy_<id>` name to both dictionaries in `src/i18n.ts`.
3. Add a test in `src/toys/catalog.test.ts` only if it behaves unusually (the
   existing loops already build every registered toy).

## Current status & next steps

Working: gravity, dragging/throwing with a soft constraint, spawning by click,
delete tool and right-click delete, four balls, five blocks (including a static
wedge ramp), breakable glass and brick, two conveyor belts, a ball spout, pitched
note blocks (C major pentatonic, cycling), pause, mute, clear, EN/ES, responsive
palette, a live FPS/bodies readout, and the playfield size control.

Performance is measured, not estimated: `PERFORMANCE.md` has the curves and
`npm run bench` reproduces them. The short version: **the painter is no longer
the wall** — the WebGL2 path draws anything from 500 to 7,747 bodies in
0.06–0.5 ms, against 8.6–12.6 ms for canvas 2D at the top of that range — so the
physics step is the only thing left in the 16.7 ms budget, and that is what
`est-60hz` in the bench output tells you. The next lever is the granular layer
(`physics/grains.ts`), which is the only way past ~2,000 bodies.

Ideas still open (see `PLAN.md §8`): saving a scene in `localStorage`, a
"shake" button, funnels/dominoes as extra toy families, a sound-block octave
toggle, better mobile affordances (tap-to-place ghost), and the dashboard card +
`deploy.config.json` entry.
