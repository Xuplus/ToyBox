// Ropes meet the granular layer: sand poured onto a rope bridge (it sags and
// spills), and water poured onto a chain hammock. Links are grain colliders
// like any body, after the toys in the collider list.
//
//   node scripts/bench.mjs --url "http://127.0.0.1:4173/?wait=8000" --sizes 0 \
//     --eval-file scripts/scenes/ropes-sand.js --shot shots/ropes-sand.png

(async () => {
  const WAIT = Number(new URLSearchParams(location.search).get('wait') ?? 8000);
  const box = window.__toybox;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  box.clear();
  const { w, h } = box.bounds();

  const canvas = document.querySelector('canvas');
  const rect = canvas.getBoundingClientRect();
  const at = (x, y) => ({ clientX: rect.left + (x / w) * rect.width, clientY: rect.top + (y / h) * rect.height });
  const fire = (target, type, x, y) =>
    target.dispatchEvent(new PointerEvent(type, { ...at(x, y), bubbles: true, pointerId: 1, button: 0, isPrimary: true }));
  const tie = (tool, ax, ay, bx, by) => {
    box.tool(tool);
    fire(canvas, 'pointerdown', ax, ay);
    fire(canvas, 'pointermove', bx, by);
    fire(window, 'pointerup', bx, by);
  };

  tie('rope', w * 0.1, h * 0.35, w * 0.42, h * 0.35);
  box.place('sandSource', w * 0.26, 30);
  tie('chain', w * 0.58, h * 0.4, w * 0.9, h * 0.4);
  box.place('waterSource', w * 0.74, 30);

  box.tool('drag');
  await sleep(WAIT);
  return box.stats();
})();
