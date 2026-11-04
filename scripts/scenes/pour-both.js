// Pour sand and water side by side, then stop and watch the box settle. Reports
// physics cost and awake grains over time: the cost while pouring, and whether
// the box actually goes quiet afterwards.
//
//   node scripts/bench.mjs --url http://127.0.0.1:4173/ --sizes 0 \
//     --eval-file scripts/scenes/pour-both.js --shot shots/pour-both.png

(async () => {
  const box = window.__toybox;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  box.clear();

  const { w, h } = box.bounds();
  box.place('crate', w * 0.5, h - 60);
  box.place('sandSource', w * 0.25, 90);
  box.place('waterSource', w * 0.75, 90);

  const samples = [];
  const sample = (label) => {
    const s = box.stats();
    samples.push(`${label}: ${s.grains} grains, ${s.grainsAwake} awake, physics ${s.physicsMs.toFixed(2)} ms, ${s.fps.toFixed(0)} fps`);
    box.reset();
  };
  for (let t = 3; t <= 12; t += 3) { await sleep(3000); sample(`pouring ${t}s`); }

  // Switch the hoppers off by deleting them: the sources are the only bodies
  // with a pour, so removing them stops the stream and leaves the piles.
  box.tool('delete');
  const canvas = document.querySelector('canvas');
  const rect = canvas.getBoundingClientRect();
  const click = (x, y) => {
    const px = rect.left + (x / w) * rect.width;
    const py = rect.top + (y / h) * rect.height;
    for (const type of ['pointerdown', 'pointerup']) {
      canvas.dispatchEvent(new PointerEvent(type, { clientX: px, clientY: py, bubbles: true, pointerId: 1, button: 0, isPrimary: true }));
    }
  };
  click(w * 0.25, 90);
  click(w * 0.75, 90);
  box.tool('grab');
  box.reset();

  for (let t = 4; t <= 24; t += 4) { await sleep(4000); sample(`stopped +${t}s`); }
  return samples;
})()
