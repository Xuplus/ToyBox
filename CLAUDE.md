# CLAUDE.md — ToyBox

Context for AI agents working in this repo. Keep this file short; see
[`PLAN.md`](./PLAN.md) for the full design.

## What this is

A **2D physics sandbox**: a box you drop toys into and knock about. Balls with
different weight and bounciness, blocks (some shatter on impact), conveyor
belts, and musical blocks that play a note when something hits them. You can
grab anything with the mouse and throw it. Nothing is stored and nothing is
uploaded — the whole simulation runs on the device.

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
- `src/toys/` — the **toy registry**. `catalog.ts` is the one file to edit to add
  a toy: each `ToyDef` knows its palette metadata and how to build its Matter
  body. `meta.ts` keeps per-body metadata (colour, belt speed, break threshold,
  pitch) in a `WeakMap`.
- `src/engine/` — `ToyBoxEngine.ts` owns the RAF loop, pointer input
  (spawn / drag / delete), collision handling (note strikes, shattering) and
  body limits; `render.ts` is all the canvas 2D drawing.
- `src/audio/` — `notes.ts` (scale + note naming, pure) and `synth.ts` (a tiny
  WebAudio synth — every sound is generated, no audio files).
- `src/ui/` — `TopBar` (home, pause, mute, clear, language) and `Palette`.
- `src/i18n.ts` — EN/ES, auto-detected, with a toggle. Matches the siblings.

## Commands

```bash
npm install
npm run dev          # local dev (:5175)
npm run typecheck
npm run test         # vitest — physics/, toys/, audio/ pure logic
npm run build        # tsc --noEmit + vite build → ./dist
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
- **Bodies are capped** (`MAX_BODIES`) so a shatter storm can't lock up the tab;
  the oldest dynamic body is evicted first.
- **Shared header UX.** Top bar in normal flow — home (`🏠`, `href="/"` → the
  `elnuevos.es` root) + `🧰` title on the left, controls and language on the
  right. Never absolutely positioned. Mirrors the sibling games.
- **Deploy does a CLEAN install.** `package-lock.json` is git-ignored (a
  lockfile generated on one OS trips npm's optional-deps bug, npm/cli#4828, and
  the linux `rollup` binary goes missing); `deploy/setup.sh` runs
  `rm -rf node_modules package-lock.json && npm install`.

## Adding a toy

1. Add an entry in `src/toys/catalog.ts` (`makeBall` / `makeBlock` / `makeBelt`
   cover the current shapes) and add it to a `PALETTE_GROUPS` list. A
   non-rectangular body sets `shape: 'poly'` on its metadata and is drawn from
   its Matter vertices (see `ramp`).
2. Add its `toy_<id>` name to both dictionaries in `src/i18n.ts`.
3. Add a test in `src/toys/catalog.test.ts` only if it behaves unusually (the
   existing loops already build every registered toy).

## Current status & next steps

Working: gravity, dragging/throwing with a soft constraint, spawning by click,
delete tool and right-click delete, four balls, five blocks (including a static
wedge ramp), breakable glass and brick, two conveyor belts, pitched note blocks
(C major pentatonic, cycling), pause, mute, clear, EN/ES, responsive layout with
a scrollable palette.

Ideas still open (see `PLAN.md §8`): saving a scene in `localStorage`, a
"shake" button, funnels/dominoes as extra toy families, a sound-block octave
toggle, better mobile affordances (tap-to-place ghost), and the dashboard card +
`deploy.config.json` entry.
