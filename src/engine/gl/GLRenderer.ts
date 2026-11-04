// The WebGL2 painter.
//
// Why this exists: a canvas `drawImage` per body costs ~1.5 µs, which is 30 ms
// of a 16.7 ms frame at 20,000 bodies — the painter, not physics, was setting
// the ceiling. One instanced draw call for the same 20,000 circles measured
// 0.4 ms. So the whole scene is assembled into flat arrays (`pack.ts`) and
// submitted as a handful of draw calls.
//
// Geometry is resolution independent: there are no sprites to rasterise and
// nothing to rebuild when the device pixel ratio or the playfield zoom changes.
// The only per-scale asset is the note-label atlas, rebuilt only when the text
// would otherwise be resampled beyond ~2×.

import { SCALE, noteName } from '../../audio/notes';
import { NOTE_H } from '../../toys/catalog';
import type { Painter, Scene } from '../scene';
import {
  CIRCLE_STYLE,
  DOT,
  DOT_STRIDE,
  POLY_STRIDE,
  RECT,
  RECT_STRIDE,
  SPRITE,
  SPRITE_STRIDE,
  type Instances,
} from './instances';
import { buildLabelAtlas, type LabelAtlas } from './labels';
import { GRAIN_BORDER, packScene, SceneBuffers } from './pack';
import {
  BG_FS,
  BG_VS,
  CIRCLE_FS,
  CIRCLE_VS,
  POLY_FS,
  POLY_VS,
  RECT_FS,
  RECT_VS,
  SPRITE_FS,
  SPRITE_VS,
} from './shaders';

/** The note label is drawn at half the bar's height (see `packNote`). */
const LABEL_WORLD_PX = NOTE_H * 0.5;

interface AttribSetup {
  name: string;
  size: number;
  buffer: WebGLBuffer;
  /** floats */
  stride: number;
  /** floats */
  offset: number;
  divisor?: number;
}

interface Pipeline {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

function must<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`webgl: could not create ${what}`);
  return value;
}

export class GLRenderer implements Painter {
  readonly kind = 'webgl';

  private readonly gl: WebGL2RenderingContext;
  private readonly out = new SceneBuffers();
  private readonly buffers = new Map<string, WebGLBuffer>();
  private readonly corner: WebGLBuffer;

  private readonly bg: Pipeline;
  private readonly circle: Pipeline;
  private readonly rect: Pipeline;
  private readonly sprite: Pipeline;
  private readonly poly: Pipeline;

  // One VAO per draw-call shape. Attribute sources never change — only the
  // contents of the buffers — so nothing here is re-bound between frames.
  private readonly vaoDots: WebGLVertexArrayObject;
  private readonly vaoBalls: WebGLVertexArrayObject;
  private readonly vaoRects: WebGLVertexArrayObject;
  private readonly vaoSprites: WebGLVertexArrayObject;
  private readonly vaoPolys: WebGLVertexArrayObject;
  private readonly vaoGhostCircle: WebGLVertexArrayObject;
  private readonly vaoGhostRect: WebGLVertexArrayObject;

  private labelTexture: WebGLTexture | null = null;
  private atlas: LabelAtlas | null = null;
  private atlasFontPx = -1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('webgl2 unavailable');
    this.gl = gl;

    // A unit quad, shared by every instanced pipeline.
    this.corner = this.buffer('corner');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corner);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this.bg = this.pipeline(BG_VS, BG_FS, [
      { name: 'aCorner', size: 2, buffer: this.corner, stride: 2, offset: 0 },
    ], ['uWorld', 'uScale']);

    this.circle = this.pipeline(CIRCLE_VS, CIRCLE_FS, [
      { name: 'aCorner', size: 2, buffer: this.corner, stride: 2, offset: 0 },
      ...this.circleAttribs(this.get('circles'), this.get('styles')),
    ], ['uWorld']);
    this.vaoBalls = this.circle.vao;

    this.rect = this.pipeline(RECT_VS, RECT_FS, this.rectAttribs(this.get('rects')), ['uWorld']);
    this.vaoRects = this.rect.vao;

    this.sprite = this.pipeline(SPRITE_VS, SPRITE_FS, [
      { name: 'aCorner', size: 2, buffer: this.corner, stride: 2, offset: 0 },
      { name: 'aPos', size: 2, buffer: this.get('sprites'), stride: SPRITE_STRIDE, offset: SPRITE.x, divisor: 1 },
      { name: 'aHalf', size: 2, buffer: this.get('sprites'), stride: SPRITE_STRIDE, offset: SPRITE.halfW, divisor: 1 },
      { name: 'aAngle', size: 1, buffer: this.get('sprites'), stride: SPRITE_STRIDE, offset: SPRITE.angle, divisor: 1 },
      { name: 'aUV', size: 4, buffer: this.get('sprites'), stride: SPRITE_STRIDE, offset: SPRITE.uv, divisor: 1 },
    ], ['uWorld', 'uLabels']);
    this.vaoSprites = this.sprite.vao;

    this.poly = this.pipeline(POLY_VS, POLY_FS, [
      { name: 'aPos', size: 2, buffer: this.get('polys'), stride: POLY_STRIDE, offset: 0 },
      { name: 'aColor', size: 4, buffer: this.get('polys'), stride: POLY_STRIDE, offset: 2 },
    ], ['uWorld']);
    this.vaoPolys = this.poly.vao;

    // Grains: the outline and the halo are the same for every instance, so they
    // ride on the generic vertex attribute instead of 20k redundant records.
    this.vaoDots = must(gl.createVertexArray(), 'vertex array');
    gl.bindVertexArray(this.vaoDots);
    this.attribute({ name: 'aCorner', size: 2, buffer: this.corner, stride: 2, offset: 0 }, this.circle.program);
    for (const setup of this.circleAttribs(this.get('dots'), null)) {
      this.attribute(setup, this.circle.program);
    }
    for (const name of ['aGlow', 'aBorder', 'aDash']) {
      const loc = gl.getAttribLocation(this.circle.program, name);
      if (loc >= 0) gl.disableVertexAttribArray(loc);
    }

    this.vaoGhostCircle = must(gl.createVertexArray(), 'vertex array');
    gl.bindVertexArray(this.vaoGhostCircle);
    this.attribute({ name: 'aCorner', size: 2, buffer: this.corner, stride: 2, offset: 0 }, this.circle.program);
    for (const setup of this.circleAttribs(this.get('ghostCircle'), this.get('ghostStyle'))) {
      this.attribute(setup, this.circle.program);
    }

    this.vaoGhostRect = must(gl.createVertexArray(), 'vertex array');
    gl.bindVertexArray(this.vaoGhostRect);
    for (const setup of this.rectAttribs(this.get('ghostRect'))) {
      this.attribute(setup, this.rect.program);
    }

    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  resize(deviceW: number, deviceH: number): void {
    this.canvas.width = Math.max(1, Math.round(deviceW));
    this.canvas.height = Math.max(1, Math.round(deviceH));
  }

  draw(scene: Scene): void {
    const gl = this.gl;

    // The label atlas has to exist before the packer asks it for cells.
    const fontPx = Math.min(72, Math.max(9, Math.round(LABEL_WORLD_PX * scene.pixelRatio)));
    if (fontPx !== this.atlasFontPx) this.rebuildAtlas(fontPx);

    packScene(this.out, scene, this.atlas);

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.bg.program);
    gl.bindVertexArray(this.bg.vao);
    gl.uniform2f(this.uniform(this.bg, 'uWorld'), scene.worldW, scene.worldH);
    gl.uniform1f(this.uniform(this.bg, 'uScale'), scene.scale);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    if (this.out.dots.count > 0) {
      gl.useProgram(this.circle.program);
      gl.bindVertexArray(this.vaoDots);
      gl.uniform2f(this.uniform(this.circle, 'uWorld'), scene.worldW, scene.worldH);
      gl.vertexAttrib4f(this.attrib(this.circle, 'aGlow'), 0, 0, 0, 0);
      gl.vertexAttrib4f(
        this.attrib(this.circle, 'aBorder'),
        GRAIN_BORDER[0] / 255,
        GRAIN_BORDER[1] / 255,
        GRAIN_BORDER[2] / 255,
        1,
      );
      gl.vertexAttrib4f(this.attrib(this.circle, 'aDash'), 0, 0, 0, 0);
      this.upload('dots', this.out.dots);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.out.dots.count);
    }

    if (this.out.polys.count > 0) {
      gl.useProgram(this.poly.program);
      gl.bindVertexArray(this.vaoPolys);
      gl.uniform2f(this.uniform(this.poly, 'uWorld'), scene.worldW, scene.worldH);
      this.upload('polys', this.out.polys);
      gl.drawArrays(gl.TRIANGLES, 0, this.out.polys.count);
    }

    if (this.out.rects.count > 0) {
      gl.useProgram(this.rect.program);
      gl.bindVertexArray(this.vaoRects);
      gl.uniform2f(this.uniform(this.rect, 'uWorld'), scene.worldW, scene.worldH);
      this.upload('rects', this.out.rects);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.out.rects.count);
    }

    if (this.out.sprites.count > 0 && this.labelTexture) {
      gl.useProgram(this.sprite.program);
      gl.bindVertexArray(this.vaoSprites);
      gl.uniform2f(this.uniform(this.sprite, 'uWorld'), scene.worldW, scene.worldH);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.labelTexture);
      gl.uniform1i(this.uniform(this.sprite, 'uLabels'), 0);
      this.upload('sprites', this.out.sprites);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.out.sprites.count);
    }

    if (this.out.circles.count > 0) {
      gl.useProgram(this.circle.program);
      gl.bindVertexArray(this.vaoBalls);
      gl.uniform2f(this.uniform(this.circle, 'uWorld'), scene.worldW, scene.worldH);
      this.upload('circles', this.out.circles);
      this.upload('styles', this.out.styles);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.out.circles.count);
    }

    // The drop preview sits above everything, so it gets its own two calls.
    if (this.out.ghostCircle.count > 0) {
      gl.useProgram(this.circle.program);
      gl.bindVertexArray(this.vaoGhostCircle);
      gl.uniform2f(this.uniform(this.circle, 'uWorld'), scene.worldW, scene.worldH);
      this.upload('ghostCircle', this.out.ghostCircle);
      this.upload('ghostStyle', this.out.ghostStyle);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
    }

    if (this.out.ghostRect.count > 0) {
      gl.useProgram(this.rect.program);
      gl.bindVertexArray(this.vaoGhostRect);
      gl.uniform2f(this.uniform(this.rect, 'uWorld'), scene.worldW, scene.worldH);
      this.upload('ghostRect', this.out.ghostRect);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
    }

    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    if (this.labelTexture) gl.deleteTexture(this.labelTexture);
    this.labelTexture = null;
    for (const buffer of this.buffers.values()) gl.deleteBuffer(buffer);
    this.buffers.clear();
    gl.deleteBuffer(this.corner);
    gl.useProgram(null);
    gl.bindVertexArray(null);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  // --- setup helpers -----------------------------------------------------

  private circleAttribs(core: WebGLBuffer, style: WebGLBuffer | null): AttribSetup[] {
    const setups: AttribSetup[] = [
      { name: 'aPos', size: 2, buffer: core, stride: DOT_STRIDE, offset: DOT.x, divisor: 1 },
      { name: 'aRadius', size: 1, buffer: core, stride: DOT_STRIDE, offset: DOT.radius, divisor: 1 },
      { name: 'aColor', size: 4, buffer: core, stride: DOT_STRIDE, offset: DOT.color, divisor: 1 },
    ];
    if (!style) return setups;
    return setups.concat([
      { name: 'aGlow', size: 1, buffer: style, stride: CIRCLE_STYLE.dash + 1, offset: CIRCLE_STYLE.glow, divisor: 1 },
      { name: 'aBorder', size: 4, buffer: style, stride: CIRCLE_STYLE.dash + 1, offset: CIRCLE_STYLE.border, divisor: 1 },
      { name: 'aDash', size: 1, buffer: style, stride: CIRCLE_STYLE.dash + 1, offset: CIRCLE_STYLE.dash, divisor: 1 },
    ]);
  }

  private rectAttribs(buffer: WebGLBuffer): AttribSetup[] {
    const at = (name: string, size: number, offset: number): AttribSetup => ({
      name,
      size,
      buffer,
      stride: RECT_STRIDE,
      offset,
      divisor: 1,
    });
    return [
      { name: 'aCorner', size: 2, buffer: this.corner, stride: 2, offset: 0 },
      at('aPos', 2, RECT.x),
      at('aHalf', 2, RECT.halfW),
      at('aRadius', 1, RECT.radius),
      at('aAngle', 1, RECT.angle),
      at('aColor', 4, RECT.color),
      at('aShade', 2, RECT.shadeTop),
      at('aBorder', 4, RECT.border),
      at('aBorderW', 1, RECT.borderW),
      at('aPattern', 1, RECT.pattern),
      at('aParam', 2, RECT.paramX),
      at('aPatternRgb', 3, RECT.patternRgb),
      at('aGlow', 1, RECT.glow),
    ];
  }

  private buffer(name: string): WebGLBuffer {
    const existing = this.buffers.get(name);
    if (existing) return existing;
    const created = must(this.gl.createBuffer(), 'buffer');
    this.buffers.set(name, created);
    return created;
  }

  private get(name: string): WebGLBuffer {
    return this.buffer(name);
  }

  private pipeline(
    vsSource: string,
    fsSource: string,
    attribs: AttribSetup[],
    uniformNames: string[],
  ): Pipeline {
    const gl = this.gl;
    const program = must(gl.createProgram(), 'program');

    const compile = (type: number, source: string): WebGLShader => {
      const shader = must(gl.createShader(type), 'shader');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader) ?? '';
        gl.deleteShader(shader);
        throw new Error(`webgl shader: ${log}`);
      }
      return shader;
    };

    const vs = compile(gl.VERTEX_SHADER, vsSource);
    const fs = compile(gl.FRAGMENT_SHADER, fsSource);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? '';
      gl.deleteProgram(program);
      throw new Error(`webgl link: ${log}`);
    }

    const vao = must(gl.createVertexArray(), 'vertex array');
    gl.bindVertexArray(vao);
    for (const attrib of attribs) this.attribute(attrib, program);
    gl.bindVertexArray(null);

    const uniforms = new Map<string, WebGLUniformLocation | null>();
    for (const name of uniformNames) uniforms.set(name, gl.getUniformLocation(program, name));

    return { program, vao, uniforms };
  }

  private attribute(setup: AttribSetup, program: WebGLProgram): void {
    const gl = this.gl;
    const loc = gl.getAttribLocation(program, setup.name);
    if (loc < 0) throw new Error(`webgl: no attribute ${setup.name}`);

    gl.bindBuffer(gl.ARRAY_BUFFER, setup.buffer);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, setup.size, gl.FLOAT, false, setup.stride * 4, setup.offset * 4);
    gl.vertexAttribDivisor(loc, setup.divisor ?? 0);
  }

  private uniform(pipeline: Pipeline, name: string): WebGLUniformLocation {
    const loc = pipeline.uniforms.get(name) ?? null;
    if (!loc) throw new Error(`webgl: no uniform ${name}`);
    return loc;
  }

  private attrib(pipeline: Pipeline, name: string): number {
    const loc = this.gl.getAttribLocation(pipeline.program, name);
    if (loc < 0) throw new Error(`webgl: no attribute ${name}`);
    return loc;
  }

  private upload(name: string, instances: Instances): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.get(name));
    // Orphaning: a fresh store each frame, which is the cheapest way to stream
    // a buffer this size without stalling on the previous frame's copy.
    gl.bufferData(gl.ARRAY_BUFFER, instances.view(), gl.DYNAMIC_DRAW);
  }

  private rebuildAtlas(fontPx: number): void {
    const gl = this.gl;
    this.atlas = buildLabelAtlas(
      SCALE.map((midi) => noteName(midi)),
      fontPx,
    );
    this.atlasFontPx = fontPx;

    if (!this.labelTexture) {
      this.labelTexture = must(gl.createTexture(), 'texture');
      gl.bindTexture(gl.TEXTURE_2D, this.labelTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }

    gl.bindTexture(gl.TEXTURE_2D, this.labelTexture);
    // Canvas text is straight alpha; premultiplied is what the blend func wants.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.atlas.canvas);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }
}
