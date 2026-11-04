(async () => {
  const box = window.__toybox;
  box.clear();
  box.grains(8000, 3);
  await new Promise((resolve) => setTimeout(resolve, 7000));
  return box.stats();
})()
