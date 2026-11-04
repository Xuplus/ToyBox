// A deterministic scene for eyeballing the two painters against each other.
//
//   node scripts/bench.mjs --url http://127.0.0.1:4173/ --sizes 0 \
//     --warmup 600 --sample 600 --eval-file scripts/scenes/showcase.js \
//     --shot shots/gl.png
//
// Same body positions, same time of day, both renderers. See PERFORMANCE.md.

(() => {
  const box = window.__toybox;
  box.clear();

  const { w, h } = box.bounds();

  box.place('beltRight', w * 0.72, h - 40);
  box.place('beltLeft', w * 0.4, h - 120);
  box.place('noteBlock', w * 0.28, h - 42);
  box.place('crate', w * 0.72, h - 90);
  box.place('glass', w * 0.52, h - 62);
  box.place('brick', w * 0.52, h - 140);
  box.place('plank', w * 0.24, h - 150);
  box.place('ramp', w * 0.86, h - 170);
  box.place('ballSpawner', w * 0.45, 44);

  box.place('ballBouncy', w * 0.2, 120);
  box.place('ballMarble', w * 0.33, 60);
  box.place('ballHeavy', w * 0.62, 170);
  box.place('ballBeach', w * 0.8, 80);

  // A heap of grains, so the granular path is in the shot too.
  box.grains(320, 6);

  // Ghost preview at a known spot.
  box.tool('crate');
  const canvas = document.querySelector('canvas');
  const rect = canvas.getBoundingClientRect();
  canvas.dispatchEvent(
    new PointerEvent('pointermove', {
      clientX: rect.left + rect.width * 0.62,
      clientY: rect.top + rect.height * 0.4,
      bubbles: true,
    }),
  );

  return box.stats();
})()
