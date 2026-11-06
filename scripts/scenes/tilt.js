// Planks and crates landing on the sides of a sand heap should lie down along
// the slope, not stay level on it. Pours a heap, stops the pour, then drops a
// plank and a crate on each flank.
//
//   node scripts/bench.mjs --url "http://127.0.0.1:4173/?wait=4000" --sizes 0 \
//     --eval-file scripts/scenes/tilt.js --shot shots/tilt.png

(async () => {
  const WAIT = Number(new URLSearchParams(location.search).get('wait') ?? 4000);
  const box = window.__toybox;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  box.clear();
  const { w, h } = box.bounds();

  box.place('sandSource', w * 0.5, 30);
  await sleep(9000);
  // Stop the pour: clear() takes the grains too, so take the source alone.
  const canvas = document.querySelector('canvas');
  const rect = canvas.getBoundingClientRect();
  box.tool('delete');
  const at = { clientX: rect.left + rect.width * 0.5, clientY: rect.top + (30 / h) * rect.height };
  canvas.dispatchEvent(new PointerEvent('pointerdown', { ...at, bubbles: true, pointerId: 1, button: 0 }));
  window.dispatchEvent(new PointerEvent('pointerup', { ...at, bubbles: true, pointerId: 1, button: 0 }));
  box.tool('drag');
  await sleep(1500);

  box.place('plank', w * 0.5 - 170, h * 0.35);
  box.place('plank', w * 0.5 + 190, h * 0.3);
  box.place('crate', w * 0.5 - 300, h * 0.25);
  box.place('crate', w * 0.5 + 330, h * 0.2);
  await sleep(WAIT);
  return box.probe().map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), w: +b.w.toFixed(3) }));
})();
