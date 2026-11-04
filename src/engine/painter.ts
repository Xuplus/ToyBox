import { GLRenderer } from './gl/GLRenderer';
import { Canvas2DPainter } from './render';
import type { Painter } from './scene';

/**
 * Pick a painter: WebGL2 if the browser will give us one, canvas 2D otherwise.
 *
 * `?render=2d` / `?render=gl` force the choice. That is a measurement switch,
 * not a setting — `scripts/bench.mjs --render 2d` uses it to time the two paths
 * on the same scene — and it is invisible without the parameter.
 *
 * Note the one-way door: a canvas hands out exactly one context kind, so this
 * has to ask for WebGL *first*. If the context is granted but a shader fails to
 * compile there is no falling back on that canvas — which is why the failure is
 * re-thrown with its GLSL log instead of being swallowed into a second attempt.
 */
export function createPainter(canvas: HTMLCanvasElement): Painter {
  const forced = renderOverride();

  if (forced !== 'canvas2d') {
    try {
      return new GLRenderer(canvas);
    } catch (error) {
      if (forced === 'webgl') throw error;
      // No WebGL2 (or it blew up): the 2D path is the whole product still.
      console.warn('ToyBox: falling back to canvas 2D —', error);
    }
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('ToyBox: this browser offers neither WebGL2 nor canvas 2D');
  return new Canvas2DPainter(canvas, ctx);
}

function renderOverride(): 'webgl' | 'canvas2d' | 'auto' {
  const value = new URLSearchParams(window.location.search).get('render');
  if (value === '2d' || value === 'canvas2d') return 'canvas2d';
  if (value === 'gl' || value === 'webgl') return 'webgl';
  return 'auto';
}
