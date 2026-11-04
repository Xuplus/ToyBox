#!/usr/bin/env node
// Headless frame-rate benchmark for ToyBox.
//
// Drives the real app in a real (headless) browser, so the numbers include
// everything the player pays for: Matter stepping, the canvas redraw, and the
// React updates that come with the FPS readout. Bodies are added through the
// `?bench=N` hook (see src/debug.ts).
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/bench.mjs --url http://127.0.0.1:4173/ --sizes 0,200,400,800
//
// Options: --url --sizes --scale --warmup --sample --port --browser --headed

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Cdp } from './cdp.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Headless has no vsync and its compositor ticks at ~145 Hz, so the raw fps
 * overstates a 60 Hz display. The physics runs at a fixed 60 Hz whatever the
 * frame rate, so one step costs `fps * sim / 60` ms, and a 60 Hz frame is one
 * step plus one draw. This is the frame rate that work would sustain.
 */
function estimate60(stats) {
  const stepMs = (stats.fps * stats.physicsMs) / 60;
  return Math.min(999, 1000 / Math.max(0.001, stepMs + stats.drawMs));
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[flag.slice(2)] = next;
      i++;
    } else {
      args[flag.slice(2)] = 'true';
    }
  }
  return args;
}

function findBrowser(explicit) {
  const local = process.env.LOCALAPPDATA ?? '';
  const candidates = [
    explicit,
    process.env.BROWSER_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    path.join(local, 'Microsoft/Edge/Application/msedge.exe'),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(local, 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  // Edge "Core" installs sit in a versioned folder.
  for (const root of ['C:/Program Files (x86)/Microsoft/EdgeCore', 'C:/Program Files/Microsoft/EdgeCore']) {
    if (!existsSync(root)) continue;
    for (const version of readdirSync(root).sort().reverse()) {
      const exe = path.join(root, version, 'msedge.exe');
      if (existsSync(exe)) return exe;
    }
  }

  throw new Error('no browser found — pass --browser <path to msedge.exe or chrome.exe>');
}

async function waitForTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // the endpoint is not listening yet
    }
    await sleep(200);
  }
  throw new Error(`the devtools endpoint on :${port} never appeared`);
}

async function waitForApp(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await cdp.evaluate('typeof window.__toybox?.stats === "function"').catch(() => false);
    if (ready) return;
    await sleep(200);
  }
  throw new Error('the page never exposed window.__toybox — is it the ToyBox build?');
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url ?? 'http://127.0.0.1:4173/';
  const sizes = (args.sizes ?? '0,100,200,300,400,500,600,800,1000')
    .split(',')
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0);
  const scale = Number(args.scale ?? 1);
  const warmup = Number(args.warmup ?? 2500);
  const sample = Number(args.sample ?? 3000);
  const port = Number(args.port ?? 9333);
  const browserPath = findBrowser(args.browser);
  const headed = args.headed === 'true';
  const spawners = Number(args.spawners ?? 0);
  const seconds = Number(args.seconds ?? 40);
  const every = Number(args.every ?? 2000);

  const profile = mkdtempSync(path.join(os.tmpdir(), 'toybox-bench-'));
  const launch = new URL(url);
  launch.searchParams.set('bench', '0');

  console.log(`browser  ${browserPath}`);
  console.log(`page     ${url}  (playfield ${scale}×)`);
  console.log('');

  const browser = spawn(
    browserPath,
    [
      headed ? '--new-window' : '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=Translate,MediaRouter',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--window-size=1440,900',
      launch.toString(),
    ],
    { stdio: 'ignore' },
  );

  let cdp = null;
  const rows = [];

  try {
    const target = await waitForTarget(port, 20000);
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await waitForApp(cdp, 15000);

    // Warm the JIT up on the empty page before measuring anything.
    await sleep(600);
    if (spawners > 0) {
      // Park a row of spouts near the ceiling and watch the box fill up.
      const box = await cdp.evaluate(
        `(() => {
           const b = window.__toybox;
           b.clear();
           b.scale(${scale});
           const { w, h } = b.bounds();
           const n = ${spawners};
           for (let i = 0; i < n; i++) b.place('ballSpawner', (w * (i + 0.5)) / n, Math.max(24, h * 0.05));
           b.reset();
           return b.bounds();
         })()`,
      );

      console.log(`spouts   ${spawners} across ${box.w}×${box.h} world px`);
      console.log('');
      console.log('  time   bodies     fps   fps95  frame-ms   sim-ms  draw-ms  est-60hz');
      console.log('------  -------  ------  ------  --------  -------  -------  --------');

      const started = Date.now();
      let elapsed = 0;
      while (elapsed < seconds * 1000) {
        await sleep(every);
        elapsed = Date.now() - started;

        const stats = await cdp.evaluate('window.__toybox.stats()');
        rows.push({ at: elapsed / 1000, ...stats });
        console.log(
          `${(elapsed / 1000).toFixed(0).padStart(5)}s  ${String(stats.bodies).padStart(7)}  ` +
            `${stats.fps.toFixed(1).padStart(6)}  ${stats.fpsLow.toFixed(1).padStart(6)}  ` +
            `${stats.frameMs.toFixed(1).padStart(8)}  ${stats.physicsMs.toFixed(2).padStart(7)}  ` +
            `${stats.drawMs.toFixed(2).padStart(7)}  ${estimate60(stats).toFixed(0).padStart(8)}`,
        );
      }
    } else {
      for (const size of sizes) {
        await cdp.evaluate(
          `(() => {
             const box = window.__toybox;
             box.clear();
             box.scale(${scale});
             if (${size} > 0) box.fill(${size});
             box.reset();
             return box.stats().bodies;
           })()`,
        );

        await sleep(warmup);
        await cdp.evaluate('window.__toybox.reset()');
        await sleep(sample);

        const stats = await cdp.evaluate('window.__toybox.stats()');
        rows.push({ size, ...stats });
        console.log(
          `${String(stats.bodies).padStart(6)} bodies` +
            `${stats.fps.toFixed(1).padStart(8)} fps` +
            `${stats.fpsLow.toFixed(1).padStart(8)} p95-fps`,
        );
      }
    }

    if (args.eval) {
      // A hook for poking the page before the screenshot — e.g. dispatching a
      // synthetic click to check that the playfield mapping lands where it should.
      const result = await cdp.evaluate(args.eval);
      console.log(`\neval → ${JSON.stringify(result)}`);
      await sleep(400);
    }

    if (args.shot) {
      await cdp.request('Page.enable');
      const shot = await cdp.request('Page.captureScreenshot', { format: 'png' });
      writeFileSync(args.shot, Buffer.from(shot.data, 'base64'));
      console.log(`screenshot → ${args.shot}`);
    }
  } finally {
    cdp?.close();
    killTree(browser);
    await sleep(300);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // a locked profile is not worth failing the run over
    }
  }

  const pad = (value, width) => String(value).padStart(width);

  if (spawners > 0) {
    console.log('');
    const drop = rows.find((row) => estimate60(row) < 60);
    console.log(
      drop
        ? `60 Hz breaks down at ${drop.bodies} bodies (est. ${estimate60(drop).toFixed(0)} fps), ${drop.at.toFixed(0)}s in`
        : 'stayed above 60 fps for the whole run',
    );
    return;
  }

  console.log('');
  console.log(' bodies     fps   fps95  frame-ms   sim-ms  draw-ms  est-60hz');
  console.log('-------  ------  ------  --------  -------  -------  --------');

  for (const row of rows) {
    console.log(
      `${pad(row.size, 7)}  ${pad(row.fps.toFixed(1), 6)}  ${pad(row.fpsLow.toFixed(1), 6)}  ` +
        `${pad(row.frameMs.toFixed(1), 8)}  ${pad(row.physicsMs.toFixed(2), 7)}  ${pad(row.drawMs.toFixed(2), 7)}  ` +
        `${pad(estimate60(row).toFixed(0), 8)}`,
    );
  }

  const drop = rows.find((row) => estimate60(row) < 60);
  console.log('');
  console.log(
    drop
      ? `60 Hz breaks down at ${drop.bodies} bodies (est. ${estimate60(drop).toFixed(0)} fps)`
      : 'held 60 fps across every size tested',
  );
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exitCode = 1;
});
