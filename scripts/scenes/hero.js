// The README hero shot: a box with a bit of everything in it.
//
//   node scripts/bench.mjs --url http://localhost:4173/ --sizes 0 \
//     --eval-file scripts/scenes/hero.js --shot preview.png
//
// The sand and water need time, so the pour happens inside the eval.

(async () => {
  const box = window.__toybox;
  box.clear();

  const { w, h } = box.bounds();

  box.place('beltRight', w * 0.74, h - 40);
  box.place('beltLeft', w * 0.56, h - 118);
  box.place('noteBlock', w * 0.28, h - 42);
  box.place('crate', w * 0.74, h - 84);
  box.place('glass', w * 0.62, h - 62);
  box.place('ramp', w * 0.9, h - 168);
  box.place('plank', w * 0.34, h - 140);

  box.place('ballBouncy', w * 0.2, 110);
  box.place('ballMarble', w * 0.31, 62);
  box.place('ballHeavy', w * 0.46, 150);
  box.place('ballBeach', w * 0.7, 84);

  box.place('sandSource', w * 0.1, 74);
  box.place('waterSource', w * 0.39, 74);

  await new Promise((resolve) => setTimeout(resolve, 1700));
  return box.stats();
})()
