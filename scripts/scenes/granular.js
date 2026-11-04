// Sand and water poured into the box, for eyeballing the granular layer.
//
//   node scripts/bench.mjs --url http://localhost:4173/ --sizes 0 \
//     --eval-file scripts/scenes/granular.js --shot shots/granular.png
//
// The eval runs *after* the bench's own warmup, so the pour has to happen
// inside it: the script places the hoppers and then waits, which is the scene.

(async () => {
  const box = window.__toybox;
  box.clear();

  const { w, h } = box.bounds();

  // Something for the grains to land on, so this is not just two piles on the
  // floor: a crate to bury and a ramp to run down.
  box.place('crate', w * 0.22, h - 60);
  box.place('ramp', w * 0.66, h - 96);

  box.place('sandSource', w * 0.2, 90);
  box.place('waterSource', w * 0.5, 90);

  await new Promise((resolve) => setTimeout(resolve, 3200));
  return box.stats();
})()
