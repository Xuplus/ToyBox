// Pour water from a hopper and let it find its level - the scene a player sees.
//
//   node scripts/bench.mjs --url http://localhost:4173/ --sizes 0 \
//     --eval-file scripts/scenes/puddle.js --shot shots/puddle.png

(async () => {
  const box = window.__toybox;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  box.clear();

  const { w, h } = box.bounds();
  box.place('waterSource', w * 0.5, 90);
  await sleep(9000);
  box.place('ballHeavy', w * 0.5, 140);
  await sleep(2500);

  const stats = box.stats();
  return {
    grains: stats.grains,
    awake: stats.grainsAwake,
    fps: +stats.fps.toFixed(0),
    boxH: h,
  };
})()
