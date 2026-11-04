# PLAN.md — ToyBox

Design for a browser-based **2D physics sandbox**: a box you fill with toys and
knock about. Balls with different weight and bounciness, blocks (some shatter on
impact), conveyor belts, and musical blocks that ring a note when something hits
them. You drag anything with the pointer and can throw it.

Reference points: **Desktop Destroyer** (throwing things at breakable stuff),
**The Incredible Machine** (a shelf of contraption parts), **SoupToys** (a
sandbox of toys with no goal at all). The point is play, not score: there is no
win state, no timer, no persistence.

---

## 0. Architecture — DECIDED: pure static, no backend

The sandbox is single-player and client-only: every body, collision and sound is
computed in the browser. There is no game state for a server to own and nothing
to store. So the app follows the same model as `JigsawPuzzle` and the ElNuevos
dashboard: **Vite + React + TypeScript, built to a static bundle, served by
Caddy** under `handle_path /toybox*` from `/var/www/toybox`.

- No Node process, no port, no pm2, no Socket.IO.
- `BASE_PATH` is baked in at build time; app code never hard-codes `/toybox`.
- Deploy is sudo-free so the existing push webhook can run it unattended.

---

## 1. Player experience

1. The box opens with a small starter scene (a belt, a note block, a crate and
   three balls) so it is never a cold empty page.
2. Pick a toy from the palette → a translucent ghost follows the pointer →
   click to drop it in.
3. Drag any body to move it; release while moving to throw it. Dragging works on
   static toys too (belts, note blocks), which is how you build a contraption.
4. Things do the rest: balls bounce and roll, belts carry, glass and brick
   shatter on a hard enough hit, note blocks ring.
5. `Clear` empties the box; `Pause` freezes the simulation; the speaker toggles
   audio; `EN/ES` toggles language.

There is deliberately no scoring, no timer and no save.

---

## 2. Vocabulary

- **Toy** — an entry in the palette (`ToyDef`) that can be spawned.
- **Body** — the live Matter.js rigid body a toy produced (1:1 today; a toy may
  return several bodies).
- **Shard / fragment** — a body produced by shattering another. Not counted as a
  toy, never shatters again.
- **Belt** — a static body that imparts horizontal velocity to what rests on it.
- **Strike** — a collision hard enough for a note block to sound.

---

## 3. The toy model

Every toy is data plus a factory:

```ts
interface ToyDef {
  id: ToyId;
  kind: 'ball' | 'block' | 'belt' | 'note';
  nameKey: string;       // i18n key
  color; accent; swatch; // palette presentation
  w; h;                  // footprint, also the ghost preview size
  build(x, y, ctx): Body | Body[];
}
```

`build` creates the Matter body and attaches a `ToyMeta` (via a `WeakMap`, not
Matter's `plugin` bag) carrying colour, footprint, optional belt speed, break
threshold, and pitch. Rendering, carrying and breaking all read that metadata —
so a new toy usually needs **no code outside `catalog.ts`** (plus its name).

The starting shelf:

| Family | Toys |
| --- | --- |
| Balls | bouncy (r14, e .90), marble (r9, dense), cannonball (r26, e .25), beach ball (r34, light) |
| Blocks | crate (56²), plank (176×18), ramp (150×72 static wedge), glass (58×76, breaks), brick (86×38, breaks) |
| Belts | right / left, 200×22, 4.2 px/step |
| Music | note block, 84×28, static, pitch cycles a C major pentatonic |

---

## 4. Physics — DECIDED: Matter.js

Two options were on the table: hand-roll an impulse solver, or take a dependency.

- A hand-rolled engine is the "no dependencies" move, but stable stacking,
  friction, resting contacts and collision events are exactly the parts that
  take weeks to stop jittering. A sandbox is judged on how *right* the stack of
  crates feels.
- **Matter.js** (MIT, 0.20) is a 2D rigid-body engine with circles, polygons,
  compound bodies, sleeping, friction and — crucially — `collisionStart` events,
  which is what makes note blocks and shattering a few lines instead of a
  contact manifold implementation.

**Decision: Matter.js at runtime.** It costs ~80 KB gzipped in the bundle, which
is fine for a static toy. It is bundled, so there is no CDN dependency at play
time.

### Tuning that matters

- **Fixed 60 Hz step.** `Engine.update(engine, STEP_MS)` from an accumulator,
  never the raw frame delta: the same scene must behave the same on a 120 Hz
  display.
- **Walls sit outside the visible area.** The floor's top edge is exactly the
  canvas bottom, so the canvas edge *is* the inside of the box and nothing is
  drawn behind a wall.
- **Velocity units are px per step.** Impact thresholds (glass 7, brick 11) and
  the note threshold (1.2) are in those units; a typical fall reaches 10–20.
- **Breaking is checked on `collisionStart`** with the relative velocity of the
  two bodies. A body above its `breaksAt` is removed and replaced by a grid of
  shards (`shardLayout`, pure) that inherit its velocity plus a small outward
  impulse. Shards never break again and are not counted as toys.
- **Belts emulate surface velocity.** Matter has no conveyor primitive, so each
  step anything resting on a belt (within 12 px of the belt's top, horizontally
  overlapping, not bouncing upward) has its horizontal velocity blended toward
  the belt speed; circles also get a matching spin so balls roll rather than
  slide. Debris rides belts too.
- **Body cap.** `MAX_BODIES = 280`; the oldest dynamic body is evicted first, so
  a shatter storm can't lock up a tab.

---

## 5. Rendering

**Canvas 2D**, one canvas, drawn on every animation frame.

This is the opposite call from `JigsawPuzzle` (which needed WebGL for ~40k
pieces). Here the body count is in the low hundreds, the shapes are simple, and
each body is a handful of gradient fills — 2D canvas handles it comfortably and
keeps the code a fraction of the size. No asset pipeline: every visual is drawn
from the toy's colour.

Per-kind drawing lives in `engine/render.ts`: shaded spheres with a fixed
specular (balls never rotate their shading), bevelled blocks with a per-toy
detail (crate brace, brick joint, plank grain), translucent glass with a glint,
belts with moving chevrons and end rollers, and note bars that glow for ~320 ms
after being struck. Non-rectangular bodies (the ramp wedge) are drawn from their
Matter vertices, so new polygon toys need no renderer work. Small bodies
(shards) switch to a flat fill — a big break elsewhere spawns 9–16 of them at
once.

---

## 6. Audio — procedural, no files

A `WebAudio` synth (`audio/synth.ts`) generates everything:

- **Note blocks**: a triangle fundamental plus a quiet octave, short exponential
  decay, low-passed — a struck-bar timbre. Pitch comes from a C major pentatonic
  scale over two octaves (`audio/notes.ts`), assigned in spawn order, so laying
  down ten blocks gives you an instrument that cannot sound wrong.
- **Breaking**: a decaying noise burst through a random band-pass, so every
  crack is slightly different.

The `AudioContext` is created lazily in `Synth.unlock()` on the first pointer
down (browsers require a gesture) and never at module load. Muting ramps the
master gain to zero rather than tearing down the graph.

Per-block cooldown (70 ms) stops a resting ball from machine-gunning a note.

---

## 7. Repo layout (static app at the repo root)

```
src/
  physics/   world.ts, conveyor.ts, shatter.ts   # Matter shell, pure where possible
  toys/      catalog.ts, meta.ts, types.ts        # the registry — add toys here
  engine/    ToyBoxEngine.ts, render.ts           # loop, input, canvas
  audio/     notes.ts, synth.ts                   # scale + WebAudio synth
  ui/        TopBar.tsx, Palette.tsx
  lib/       color.ts
  App.tsx, i18n.ts, styles.css, main.tsx
deploy/
  setup.sh   # build with BASE_PATH=/toybox, publish to /var/www/toybox
  Caddyfile  # handle_path /toybox* { root + try_files + file_server }
vite.config.ts  # base derived from BASE_PATH; dev on :5175
PLAN.md / CLAUDE.md
```

`physics/`, `toys/` and `audio/notes.ts` stay DOM-free so `npm run test` can
exercise them in plain Node. Canvas and pointer code lives only in `engine/`.

---

## 8. Status

**Done.** Gravity, spawning with a ghost preview, constrained dragging and
throwing, delete tool and right-click delete, four balls, five blocks (including
a static wedge ramp), glass and brick shattering, two belts, pitched note blocks,
a ball spout, pause, mute, clear, EN/ES, responsive layout, starter scene, body
cap, a live FPS readout, and a playfield size control (1×–2.5×).

**Open / next:**

- Save and restore a scene in `localStorage` ("my contraption"), with an explicit
  clear — the app currently stores nothing at all.
- More toy families: funnels (concave, needs poly-decomp), dominoes, a fan, a
  spring, a balloon (negative gravity) — each should fit the same `ToyDef`
  contract.
- A "shake" button (random impulse to everything) and a gravity slider.
- Better touch affordances: currently a tap both selects and spawns; a
  tap-to-place-then-drag model may read better on a phone.
- Sound-block octave shift so the shelf can play a bass line and a melody.
- **Ship it**: add the card to `ElNuevos/src/games.ts` (`status: 'soon'` first),
  the `handle_path /toybox*` block to `ElNuevos/deploy/Caddyfile`, and the
  `Xuplus/ToyBox` entry to `deploy/webhook/deploy.config.json`.

---

## 9. Performance — measured, not guessed

> Deeper numbers — a CPU profile of where a step goes, the levers that were
> measured (sleeping, solver iterations, sprite caching), and the roadmap to
> tens of thousands of bodies — are in [`PERFORMANCE.md`](./PERFORMANCE.md).
> The section below is the player-facing summary.

Two things shipped for this: a live readout (bottom-left, "62 FPS · 431
bodies") and a **playfield size** control in the header that zooms the world
out — `2.5×` means two and a half times as wide *and* tall in the same space on
screen, so there is room for roughly six times as much stuff before it piles up.

`scripts/bench.mjs` drives the built app in a headless browser over the DevTools
protocol, so the numbers below can be reproduced without a human watching:

```bash
npm run build
npx vite preview --port 4173 &
npm run bench -- --url http://127.0.0.1:4173/ --sizes 0,500,1000,1500,2000
npm run bench -- --url http://127.0.0.1:4173/ --spawners 6 --seconds 80
```

The bodies come from `?bench=N`, which empties the box, lays out N balls and
exposes `window.__toybox` (see `src/debug.ts`). Without the parameter none of
that exists.

### Balls in the box — 1416×672 px, one playfield

| bodies | fps | p95 fps | frame ms | physics ms | draw ms | 60 Hz est. |
|-------:|----:|--------:|---------:|-----------:|--------:|-----------:|
| 0 | 145 | 143 | 6.9 | 0.00 | 0.01 | 999 |
| 250 | 145 | 143 | 6.9 | 0.70 | 1.17 | 348 |
| 500 | 143 | 72 | 8.3 | 1.55 | 2.32 | 166 |
| 750 | 72 | 71 | 12.1 | 4.29 | 3.28 | 119 |
| 1000 | 72 | 48 | 16.0 | 7.72 | 4.14 | 75 |
| 1250 | 48 | 36 | 22.1 | 13.46 | 5.11 | 63 |
| 1500 | 29 | 21 | 34.9 | 27.52 | 6.52 | 51 |
| 1750 | 13 | 12 | 74.8 | 65.07 | 7.19 | 47 |
| 2000 | 10 | 10 | 95.4 | 84.19 | 9.63 | 42 |

**The knee is around 1350 bodies.** Below it a 60 Hz display has room; above it
the frame crosses the 16.7 ms budget and the simulation starts missing steps (the
accumulator caps at five steps per frame, so past that the box runs in slow
motion rather than spiralling).

Reading the columns:

- Headless has no vsync and its compositor ticks at ~145 Hz, so the raw `fps`
  plateaus at 145 and is **not** the number to compare against 60. The
  `60 Hz est.` column is: physics runs at a fixed 60 Hz regardless of frame rate,
  so one step costs `fps × physics / 60`; a 60 Hz frame is one step plus one draw.
- Physics is the wall, not the painter. The whole canvas redraw of 1000 balls
  costs 4.1 ms; caching the per-ball gradients (the obvious renderer win, still
  on the list above) would move the knee by a couple of hundred bodies at most.
- A ball costs ~7 µs of physics per step at 1000 bodies and ~13 µs at 1500: the
  cost per body *rises* once the box gets crowded, because contacts multiply.
- Measured at device pixel ratio 1. On a HiDPI screen the canvas has four times
  the pixels, so expect the draw share to roughly double and the knee to move
  down a few hundred bodies.

### Six ball spouts, letting it fill up

Same box, a spout every 320 ms (18.75 balls/s):

| t | bodies | fps | physics ms | draw ms | 60 Hz est. |
|--:|-------:|----:|-----------:|--------:|-----------:|
| 10 s | 192 | 145 | 0.34 | 0.98 | 558 |
| 30 s | 564 | 143 | 2.66 | 2.58 | 112 |
| 45 s | 846 | 72 | 6.10 | 4.30 | 86 |
| 60 s | 1128 | 48 | 9.79 | 4.96 | 78 |
| 65 s | 1224 | 48 | 13.60 | 5.11 | 62 |
| 70 s | 1320 | 48 | 16.06 | 5.28 | 55 |
| 80 s | 1506 | 36 | 29.55 | 6.99 | 40 |

Which is the practical answer: **drop four to six spouts in and you get about a
minute of smooth play, then the readout goes from green to amber to red over the
next twenty seconds.** The body cap (2000) is what stops it there; clearing is
one click.
