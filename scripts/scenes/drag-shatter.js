// Interaction check: a glass pane being shattered, a ball being dragged, and
// the drop preview gone while the drag is in progress.
//
//   node scripts/bench.mjs --url http://localhost:4173/ --sizes 0 \
//     --warmup 600 --sample 600 --eval-file scripts/scenes/drag-shatter.js \
//     --shot shots/gl-interaction.png

(() => {
  const box = window.__toybox;
  box.clear();

  const { w, h } = box.bounds();
  const x = w * 0.5;

  // Fragments of the pane land below, and the ball keeps falling through.
  box.place('glass', x, h - 60);
  box.place('crate', w * 0.82, h - 60);
  // A long clear fall onto the pane: a hard enough hit to break it.
  box.place('ballHeavy', x, h - 230);

  // Grab the beach ball and hold it mid-air.
  const ballX = w * 0.25;
  const ballY = 140;
  box.place('ballBeach', ballX, ballY);

  const canvas = document.querySelector('canvas');
  const rect = canvas.getBoundingClientRect();
  const sx = rect.left + (ballX / w) * rect.width;
  const sy = rect.top + (ballY / h) * rect.height;

  canvas.dispatchEvent(
    new PointerEvent('pointerdown', {
      clientX: sx,
      clientY: sy,
      button: 0,
      bubbles: true,
      pointerId: 1,
    }),
  );
  canvas.dispatchEvent(
    new PointerEvent('pointermove', {
      clientX: sx + 40,
      clientY: sy - 20,
      bubbles: true,
      pointerId: 1,
    }),
  );

  return box.stats();
})()
