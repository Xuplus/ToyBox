# bench/ — engine shootout

A one-off, standalone harness that runs the same scene through two engines in the
same browser and times only the step call. It is not part of the app and it is
not in the build.

```bash
# rapier is deliberately not a dependency: this is an experiment, and the
# deploy install should not carry 3.4 MB of WASM for it.
npm i -D --ignore-scripts @dimforge/rapier2d-compat      # 0.21.0
npm run shootout -- --sizes 500,1000,2000,5000,10000
npm run shootout -- --draw                                # renderer comparison
```

`run.mjs` serves this folder over http, launches headless Edge, drives
`window.bench` over the DevTools protocol and prints a markdown table.

- The layout is **constant density**: the box is divided into exactly `n` cells
  and every body gets the same room, so the comparison is per body, not per
  pile. (The first version over-packed the box and both engines just measured
  how fast they can crush 10,000 circles — see `PERFORMANCE.md` §7.)
- `drawSprites` is the canvas-2d path the toy uses today; `drawInstanced` is one
  `drawArraysInstanced` call with the circle shaded in the fragment shader.

Results and what they led to are written up in `../PERFORMANCE.md` §7.
