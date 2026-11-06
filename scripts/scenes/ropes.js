// Ropes and chains, tied the way a player ties them - press on one spot, drag,
// let go on another - with real pointer events. A crate hanging from a pin, a
// cannonball swinging on a chain, a rope bridge with balls dropped on it, a
// balloon on a string and a swing seat on two ropes.
//
//   node scripts/bench.mjs --url "http://127.0.0.1:4173/?wait=3000" --sizes 0 \
//     --eval-file scripts/scenes/ropes.js --shot shots/ropes.png

(async () => {
  const WAIT = Number(new URLSearchParams(location.search).get('wait') ?? 3000);
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
    fire(canvas, 'pointermove', (ax + bx) / 2, (ay + by) / 2);
    fire(canvas, 'pointermove', bx, by);
    fire(window, 'pointerup', bx, by);
  };

  // A crate hanging from a pin, tied off to one side so it swings in.
  box.place('crate', w * 0.12 + 90, 170);
  tie('rope', w * 0.12, 40, w * 0.12 + 90, 170);

  // A cannonball on a chain.
  box.place('ballHeavy', w * 0.36 + 140, 90);
  tie('chain', w * 0.36, 40, w * 0.36 + 140, 90);

  // A rope bridge between two pins, and something to fall on it.
  tie('rope', w * 0.6, h * 0.42, w * 0.92, h * 0.42);
  for (let i = 0; i < 4; i++) box.place('ballBouncy', w * (0.68 + i * 0.05), h * 0.2);

  // A balloon on a string, tied to a pin near the floor.
  box.place('balloon', w * 0.05, h * 0.62);
  tie('rope', w * 0.05, h * 0.62, w * 0.05, h - 30);

  // A swing seat: a plank on two ropes.
  box.place('plank', w * 0.36, h * 0.62);
  tie('rope', w * 0.36 - 80, h * 0.62, w * 0.36 - 80, h * 0.36);
  tie('rope', w * 0.36 + 80, h * 0.62, w * 0.36 + 80, h * 0.36);
  box.place('ballMarble', w * 0.36, h * 0.5);

  box.tool('drag');
  await sleep(WAIT);
  return box.stats();
})();
