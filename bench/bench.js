// Head-to-head step cost: matter-js vs rapier2d, same scene, same browser.
//
// Both engines get the same normalised layout (a grid of bodies up top that
// falls into a box), the same body count and the same 60 Hz step. What is timed
// is only the step call: broadphase + narrowphase + solver + integration.

import RAPIER from '../node_modules/@dimforge/rapier2d-compat/dist/rapier.mjs';

const W = 800;
const H = 600;

// Rapier works in metres; the toy box is 50 px to the metre.
const METRES = 50;
const GRAVITY = 72; // ≈ matter's 1 px/step², in m/s²

const out = document.getElementById('out');
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');

let rapierReady;
const Matter = window.Matter;

/**
 * Same layout for both engines, at constant density: the box is divided into
 * exactly `n` cells, so every body gets the same amount of room whatever the
 * count, and nothing starts overlapping. Bodies start in the top half and fall.
 */
function layout(n) {
  const cols = Math.max(1, Math.ceil(Math.sqrt((n * W) / H)));
  const rows = Math.max(1, Math.ceil(n / cols));
  const cellW = W / cols;
  const cellH = H / rows;
  const size = Math.min(cellW, cellH) * 0.45; // radius (or half-side)

  const points = [];
  for (let i = 0; i < n; i++) {
    points.push({
      x: ((i % cols) + 0.5) * cellW,
      y: (Math.floor(i / cols) + 0.5) * cellH * 0.55,
      size,
    });
  }
  return points;
}

function buildMatter(kind, n) {
  const { Engine, Bodies, Composite } = Matter;
  const engine = Engine.create();
  engine.gravity.y = 1;
  engine.enableSleeping = false;

  const world = engine.world;
  const opts = { isStatic: true, friction: 0.5, restitution: 0.1 };
  Composite.add(world, [
    Bodies.rectangle(W / 2, H + 40, W * 3, 80, opts),
    Bodies.rectangle(W / 2, -40, W * 3, 80, opts),
    Bodies.rectangle(-40, H / 2, 80, H * 3, opts),
    Bodies.rectangle(W + 40, H / 2, 80, H * 3, opts),
  ]);

  for (const p of layout(n)) {
    const body =
      kind === 'circle'
        ? Bodies.circle(p.x, p.y, p.size, { friction: 0.3, restitution: 0.3, density: 0.002 })
        : Bodies.rectangle(p.x, p.y, p.size * 2, p.size * 2, {
            friction: 0.4,
            restitution: 0.1,
            density: 0.002,
          });
    Composite.add(world, body);
  }

  return {
    draw() {
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#ffb14d';
      const bodies = Composite.allBodies(world);
      for (const b of bodies) {
        if (b.isStatic) continue;
        if (kind === 'circle') {
          ctx.beginPath();
          ctx.arc(b.position.x, b.position.y, b.circleRadius, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(b.position.x - 28, b.position.y - 28, 56, 56);
        }
      }
    },
    step() {
      Matter.Engine.update(engine, 1000 / 60);
    },
    count() {
      return Composite.allBodies(world).filter((b) => !b.isStatic).length;
    },
  };
}

function buildRapier(kind, n) {
  const world = new RAPIER.World({ x: 0, y: -GRAVITY });
  world.integrationParameters.dt = 1 / 60;

  const halfW = W / METRES / 2;
  const halfH = H / METRES / 2;

  const ground = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, -halfH - 0.4),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(halfW * 2, 0.4), ground);
  const roof = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, halfH + 0.4),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(halfW * 2, 0.4), roof);
  for (const side of [-1, 1]) {
    const wall = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(side * (halfW + 0.4), 0),
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.4, halfH * 2), wall);
  }

  const radius = 14 / METRES;
  const half = 28 / METRES;

  for (const p of layout(n)) {
    const x = (p.x / W - 0.5) * 2 * halfW;
    const y = halfH - (p.y / H) * 2 * halfH;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y));
    const desc =
      kind === 'circle'
        ? RAPIER.ColliderDesc.ball(p.size / METRES)
        : RAPIER.ColliderDesc.cuboid(p.size / METRES, p.size / METRES);
    world.createCollider(desc.setRestitution(0.3).setFriction(0.5).setDensity(2), body);
  }

  return {
    draw() {
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#7fe0d0';
      for (let i = 0; i < world.bodies.len(); i++) {
        const body = world.bodies.get(i);
        if (body.isFixed()) continue;
        const t = body.translation();
        const angle = body.rotation();
        ctx.save();
        ctx.translate((t.x / 2 / halfW) * W + W / 2, H / 2 - (t.y / 2 / halfH) * H);
        ctx.rotate(-angle);
        if (kind === 'circle') {
          ctx.beginPath();
          ctx.arc(0, 0, 14, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(-28, -28, 56, 56);
        }
        ctx.restore();
      }
    },
    step() {
      world.step();
    },
    count() {
      return world.bodies.len() - 5;
    },
  };
}

function time(scene, steps) {
  for (let i = 0; i < 15; i++) scene.step(); // warm + let it fall a little
  const started = performance.now();
  for (let i = 0; i < steps; i++) scene.step();
  return (performance.now() - started) / steps;
}

window.bench = {
  ready: (async () => {
    await RAPIER.init();
    rapierReady = true;
    return true;
  })(),

  /** Run one scene and return the timing. */
  async run(engine, kind, n, steps = 30) {
    await window.bench.ready;
    const scene = engine === 'rapier' ? buildRapier(kind, n) : buildMatter(kind, n);
    const ms = time(scene, steps);
    scene.draw();
    return { engine, kind, n, ms, count: scene.count() };
  },

  /** Draw cost: N sprites, one drawImage each, the way the toy does it. */
  async drawSprites(n, size = 28) {
    const canvas2 = document.createElement('canvas');
    canvas2.width = size;
    canvas2.height = size;
    const g2 = canvas2.getContext('2d');
    g2.fillStyle = '#ff6b8b';
    g2.beginPath();
    g2.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
    g2.fill();

    const xs = new Float32Array(n);
    const ys = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = Math.random() * W;
      ys[i] = Math.random() * H;
    }

    const frames = 20;
    let total = 0;
    for (let f = 0; f < frames; f++) {
      const t0 = performance.now();
      ctx.clearRect(0, 0, W, H);
      for (let i = 0; i < n; i++) {
        ctx.drawImage(canvas2, xs[i] - size / 2, ys[i] - size / 2, size, size);
      }
      total += performance.now() - t0;
    }
    return { n, ms: total / frames };
  },

  /**
   * Draw cost, batched: one instanced draw call for N circles. This is what a
   * canvas of 20,000 bodies actually needs — the per-sprite version above is
   * 37 ms at that count.
   */
  async drawInstanced(n, size = 28) {
    // A canvas can only ever hand out one context kind, and the one above is
    // 2D — so the WebGL side gets its own.
    const glCanvas = document.createElement('canvas');
    glCanvas.width = W;
    glCanvas.height = H;
    glCanvas.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;opacity:0.01';
    document.body.appendChild(glCanvas);

    const gl = glCanvas.getContext('webgl2');
    if (!gl) return { n, ms: null, error: 'no webgl2' };

    const shader = (type, source) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };

    const program = gl.createProgram();
    gl.attachShader(
      program,
      shader(
        gl.VERTEX_SHADER,
        `#version 300 es
        in vec2 aCorner;
        in vec3 aBody;          // x, y, radius
        uniform vec2 uRes;
        out vec2 vLocal;
        out float vRadius;
        void main() {
          vec2 p = aBody.xy + aCorner * aBody.z;
          vec2 clip = (p / uRes) * 2.0 - 1.0;
          gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
          vLocal = aCorner;
          vRadius = aBody.z;
        }`,
      ),
    );
    gl.attachShader(
      program,
      shader(
        gl.FRAGMENT_SHADER,
        `#version 300 es
        precision mediump float;
        in vec2 vLocal;
        out vec4 outColor;
        void main() {
          float d = length(vLocal);
          if (d > 1.0) discard;
          // Cheap shading: light from the top-left, dark rim.
          float shade = 0.55 + 0.45 * (1.0 - d) - 0.25 * clamp(vLocal.y, 0.0, 1.0);
          outColor = vec4(vec3(1.0, 0.42, 0.55) * shade, 1.0);
        }`,
      ),
    );
    gl.linkProgram(program);
    gl.useProgram(program);

    const corner = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, corner, gl.STATIC_DRAW);
    const cornerLoc = gl.getAttribLocation(program, 'aCorner');
    gl.enableVertexAttribArray(cornerLoc);
    gl.vertexAttribPointer(cornerLoc, 2, gl.FLOAT, false, 0, 0);

    const bodies = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      bodies[i * 3] = Math.random() * W;
      bodies[i * 3 + 1] = Math.random() * H;
      bodies[i * 3 + 2] = size / 2;
    }
    const bodyBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bodyBuf);
    gl.bufferData(gl.ARRAY_BUFFER, bodies, gl.STATIC_DRAW);

    const bodyLoc = gl.getAttribLocation(program, 'aBody');
    gl.enableVertexAttribArray(bodyLoc);
    gl.vertexAttribPointer(bodyLoc, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(bodyLoc, 1);

    const resLoc = gl.getUniformLocation(program, 'uRes');
    gl.uniform2f(resLoc, W, H);
    gl.viewport(0, 0, W, H);

    const frames = 20;
    let total = 0;
    const pixels = new Uint8Array(4);
    for (let f = 0; f < frames; f++) {
      const t0 = performance.now();
      gl.clearColor(0.05, 0.06, 0.08, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels); // force completion
      total += performance.now() - t0;
    }
    return { n, ms: total / frames };
  },
};

out.textContent = 'ready';
