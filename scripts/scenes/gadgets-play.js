// The gadgets doing their tricks together, driven like a player would: a fan
// turned by a tap to blow sideways, a chain of bombs, a spout feeding a black
// hole, and a cannonball dropped on a balloon. Returns what happened.
//
//   node scripts/bench.mjs --url "http://127.0.0.1:4173/?wait=3000" --sizes 0 \
//     --eval-file scripts/scenes/gadgets-play.js --shot shots/gadgets-play.png

(async () => {
  const WAIT = Number(new URLSearchParams(location.search).get('wait') ?? 3000);
  const box = window.__toybox;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  box.clear();
  const { w, h } = box.bounds();

  const canvas = document.querySelector('canvas');
  const rect = canvas.getBoundingClientRect();
  const at = (x, y) => ({ clientX: rect.left + (x / w) * rect.width, clientY: rect.top + (y / h) * rect.height });
  const fire = (target, type, x, y) =>
    target.dispatchEvent(new PointerEvent(type, { ...at(x, y), bubbles: true, pointerId: 1, button: 0, isPrimary: true }));
  const tap = (x, y) => {
    fire(canvas, 'pointerdown', x, y);
    fire(window, 'pointerup', x, y);
  };

  // A fan on the left wall, tapped once so it blows to the right.
  box.tool('drag');
  box.place('fan', 40, h * 0.45);
  tap(40, h * 0.45);
  box.place('balloon', 140, h * 0.45);
  box.place('ballBeach', 120, h * 0.45 - 40);

  // A row of bombs on the floor between crates: one goes, they all go.
  for (let i = 0; i < 3; i++) box.place('bomb', w * (0.32 + i * 0.09), h - 20);
  for (let i = 0; i < 4; i++) box.place('crate', w * (0.275 + i * 0.09), h - 30);
  box.place('glass', w * 0.38, h - 110);

  // A spout dropping balls into a black hole.
  box.place('blackHole', w * 0.82, h * 0.6);
  box.place('ballSpawner', w * 0.86, 50);

  // A cannonball over a balloon.
  box.place('balloon', w * 0.6, h * 0.5);
  box.place('ballHeavy', w * 0.6, h * 0.5 - 140);

  const before = box.stats().toys;
  const t0 = performance.now();
  let fanBalloonX = 0;
  while (performance.now() - t0 < WAIT) {
    await sleep(50);
    for (const b of box.probe()) if (Math.abs(b.y - h * 0.45) < 120 && b.x < w * 0.5) fanBalloonX = Math.max(fanBalloonX, b.x);
  }
  const s = box.stats();
  return [
    `toys ${before} -> ${s.toys}, bodies ${s.bodies}, physics ${s.physicsMs.toFixed(2)} ms`,
    `furthest a body got in front of the fan: x ${fanBalloonX.toFixed(0)} of ${w}`,
  ];
})()
