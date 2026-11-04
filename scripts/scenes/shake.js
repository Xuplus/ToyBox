// Does a ball dropped on a settled pile bounce, and does the pile settle again?
//
//   node scripts/bench.mjs --url http://localhost:4173/ --sizes 0 \
//     --eval-file scripts/scenes/shake.js

(async () => {
  const box = window.__toybox;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  box.clear();

  const { w, h } = box.bounds();
  const params = new URLSearchParams(location.search);
  const material = params.get('grain') === 'water' ? 'water' : 'sand';
  const n = Number(params.get('grains') ?? 6000);

  // A settled bed: pour nothing, just lay the grains down and let them sleep.
  box.grains(n, 5, material === 'water' ? 1 : 0); // GRAIN ids, not names
  await sleep(4000);
  const bed = box.stats();
  const bedTop = Math.min(...box.probe().map(() => 0)) || 0;

  const index = box.probe().length;
  box.place('ballHeavy', w * 0.5, 60);

  const trace = [];
  let up = 0;
  let reversals = 0;
  let lastVy = 0;
  let settledAt = -1;
  let lastY = 0;

  for (let i = 0; i < 300; i++) {
    await sleep(16);
    const p = box.probe()[index];
    if (!p) break;
    if (i > 2 && Math.sign(p.vy) !== Math.sign(lastVy) && Math.abs(p.vy) > 0.5) reversals++;
    lastVy = p.vy;
    up = Math.max(up, -p.vy);
    if (Math.abs(p.y - lastY) < 0.05 && i > 30 && settledAt < 0) settledAt = i;
    lastY = p.y;
    if (i % 4 === 0) trace.push([i, +p.y.toFixed(1), +p.vy.toFixed(2)]);
  }

  const end = box.probe()[index];
  const stats = box.stats();
  return {
    material,
    grains: stats.grains,
    bedAwake: bed.grainsAwake,
    awake: stats.grainsAwake,
    maxUp: +up.toFixed(2),
    reversals,
    settledAt,
    endY: +end.y.toFixed(1),
    bedTop,
    boxH: h,
    trace,
  };
})()
