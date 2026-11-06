// The five gadgets in one box, and a measurement of what each one does: how
// high the trampoline throws a ball, whether the balloon rises, whether the
// fan holds a beach ball up, what the black hole has eaten, and what the bomb
// threw. Returns the numbers; the screenshot is taken when it returns.
//
//   node scripts/bench.mjs --url http://127.0.0.1:4173/ --sizes 0 \
//     --eval-file scripts/scenes/gadgets.js --shot shots/gadgets.png
//
// `WAIT` (ms) is how long the box runs before the shot: short catches the
// bomb's fuse, long catches the blast and its aftermath.

(async () => {
  const WAIT = Number(new URLSearchParams(location.search).get('wait') ?? 1500);
  const box = window.__toybox;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  box.clear();
  const { w, h } = box.bounds();

  // Left: a fan on the floor blowing up, a beach ball and a balloon over it.
  box.place('fan', w * 0.12, h - 18);
  box.place('ballBeach', w * 0.12, h - 160);
  box.place('balloon', w * 0.24, h - 60);
  box.place('balloon', w * 0.28, h - 90);

  // Middle: a trampoline with a ball dropped on it.
  box.place('trampoline', w * 0.42, h - 10);
  box.place('ballBouncy', w * 0.42, h - 160);

  // Right of middle: a bomb in a little stack, waiting to go.
  box.place('crate', w * 0.62, h - 30);
  box.place('glass', w * 0.68, h - 40);
  box.place('brick', w * 0.62, h - 80);
  box.place('bomb', w * 0.66, h - 110);
  box.place('noteBlock', w * 0.56, h - 30);

  // Right: a black hole fed by a sand hopper.
  box.place('blackHole', w * 0.86, h * 0.55);
  box.place('sandSource', w * 0.86, 60);
  box.place('ballMarble', w * 0.78, h * 0.3);

  const track = [];
  const t0 = performance.now();
  let topBouncy = Infinity;
  let topBalloon = Infinity;
  while (performance.now() - t0 < WAIT) {
    await sleep(50);
    const bodies = box.probe();
    for (const b of bodies) {
      if (Math.abs(b.x - w * 0.42) < 30) topBouncy = Math.min(topBouncy, b.y);
      if (b.x > w * 0.2 && b.x < w * 0.34) topBalloon = Math.min(topBalloon, b.y);
    }
  }
  const s = box.stats();
  track.push(`after ${WAIT} ms: bodies ${s.bodies}, toys ${s.toys}, grains ${s.grains} (${s.grainsAwake} awake), physics ${s.physicsMs.toFixed(2)} ms`);
  track.push(`bouncy ball highest y ${topBouncy.toFixed(0)} (box h ${h}), balloon highest y ${topBalloon.toFixed(0)}`);
  return track;
})()
