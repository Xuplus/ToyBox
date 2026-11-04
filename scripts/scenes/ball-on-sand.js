// A heavy ball dropped onto a settled sand pile.
//
//   node scripts/bench.mjs --url http://localhost:4173/ --sizes 0 \
//     --eval-file scripts/scenes/ball-on-sand.js --shot shots/ball-on-sand.png

(async () => {
  const box = window.__toybox;
  box.clear();

  const { w, h } = box.bounds();
  box.place('sandSource', w * 0.2, 90);

  // Let a cone build up, then drop something heavy on it.
  await new Promise((resolve) => setTimeout(resolve, 3200));
  box.place('ballHeavy', w * 0.2, 200);
  await new Promise((resolve) => setTimeout(resolve, 1400));

  return box.stats();
})()
