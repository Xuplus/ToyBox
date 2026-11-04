// Serves bench/index.html over http and drives it in headless Edge.
//
//   node bench/run.mjs [--sizes 500,1000,2000,5000,10000] [--port 4180]

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp } from '../scripts/cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

function serve(port) {
  const server = http.createServer(async (req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const file = path.join(root, url === '/' ? '/bench/index.html' : url);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function findBrowser() {
  const local = process.env.LOCALAPPDATA ?? '';
  const candidates = [
    process.env.BROWSER_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    path.join(local, 'Microsoft/Edge/Application/msedge.exe'),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  for (const base of ['C:/Program Files (x86)/Microsoft/EdgeCore', 'C:/Program Files/Microsoft/EdgeCore']) {
    if (!existsSync(base)) continue;
    for (const v of readdirSync(base).sort().reverse()) {
      const exe = path.join(base, v, 'msedge.exe');
      if (existsSync(exe)) return exe;
    }
  }
  throw new Error('no browser found — set BROWSER_PATH');
}

async function waitFor(port, expression, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let cdp = null;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        cdp ??= await Cdp.connect(page.webSocketDebuggerUrl);
        if (await cdp.evaluate(expression).catch(() => false)) return cdp;
      }
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${expression}`);
}

function kill(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

const sizes = (process.argv.includes('--sizes')
  ? process.argv[process.argv.indexOf('--sizes') + 1]
  : '500,1000,2000,5000,10000'
).split(',').map(Number);

const port = Number(process.env.BENCH_PORT ?? 4180);
const debugPort = 9334;

const server = await serve(port);
const profile = mkdtempSync(path.join(os.tmpdir(), 'toybox-shootout-'));
const browser = spawn(
  findBrowser(),
  [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--force-device-scale-factor=1',
    '--window-size=900,760',
    `http://127.0.0.1:${port}/bench/index.html`,
  ],
  { stdio: 'ignore' },
);

try {
  const cdp = await waitFor(debugPort, 'window.bench && typeof window.bench.run === "function"');
  await cdp.evaluate('window.bench.ready');

  const rows = [];
  const drawOnly = process.argv.includes('--draw');
  for (const kind of drawOnly ? [] : ['circle', 'box']) {
    for (const n of sizes) {
      const steps = n >= 5000 ? 15 : 30;
      try {
        const rapi = await cdp.evaluate(`window.bench.run('rapier', '${kind}', ${n}, ${steps})`);
        const matter = await cdp.evaluate(`window.bench.run('matter', '${kind}', ${n}, ${steps})`);
        rows.push({ kind, n, rapi: rapi.ms, matter: matter.ms });
        console.log(
          `${kind.padEnd(6)} ${String(n).padStart(6)}  matter ${matter.ms.toFixed(2).padStart(8)} ms  ` +
            `rapier ${rapi.ms.toFixed(2).padStart(7)} ms  ${(matter.ms / rapi.ms).toFixed(1)}x`,
        );
      } catch (error) {
        console.log(`${kind.padEnd(6)} ${String(n).padStart(6)}  failed: ${String(error.message).slice(0, 80)}`);
      }
    }
  }

  console.log('');
  for (const n of [5000, 10000, 20000]) {
    const draw = await cdp.evaluate(`window.bench.drawSprites(${n})`);
    console.log(`draw ${String(n).padStart(6)} sprites (28px)  ${draw.ms.toFixed(2)} ms/frame`);
  }

  for (const n of [5000, 10000, 20000, 50000]) {
    const draw = await cdp.evaluate(`window.bench.drawInstanced(${n})`);
    const value = draw.ms === null || draw.ms === undefined ? `(${draw.error})` : `${draw.ms.toFixed(2)} ms/frame`;
    console.log(`draw ${String(n).padStart(6)} instanced (28px) ${value}`);
  }

  console.log('');
  console.log('| shape | bodies | matter ms/step | rapier ms/step | speedup |');
  console.log('|---|---:|---:|---:|---:|');
  for (const r of rows) {
    console.log(
      `| ${r.kind} | ${r.n} | ${r.matter.toFixed(2)} | ${r.rapi.toFixed(2)} | ${(r.matter / r.rapi).toFixed(1)}× |`,
    );
  }

  cdp.close();
} finally {
  kill(browser);
  server.close();
  await sleep(300);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // locked profile: not worth failing over
  }
}
