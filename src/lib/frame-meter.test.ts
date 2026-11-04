import { describe, expect, it } from 'vitest';
import { FrameMeter } from './frame-meter';

/** 60 fps expressed as a frame duration. */
const FRAME = 1000 / 60;

describe('FrameMeter', () => {
  it('reports nothing before the first frame', () => {
    expect(new FrameMeter(10).snapshot()).toEqual({ fps: 0, fpsLow: 0, frameMs: 0, samples: 0 });
  });

  it('reads 60 fps for 60 Hz frames', () => {
    const meter = new FrameMeter(120);
    for (let i = 0; i < 120; i++) meter.push(FRAME);

    const snap = meter.snapshot();
    expect(snap.fps).toBeCloseTo(60, 4);
    expect(snap.fpsLow).toBeCloseTo(60, 4);
    expect(snap.frameMs).toBeCloseTo(FRAME, 4);
    expect(snap.samples).toBe(120);
  });

  it('tracks a 30 fps frame rate', () => {
    const meter = new FrameMeter(120);
    for (let i = 0; i < 120; i++) meter.push(FRAME * 2);
    expect(meter.snapshot().fps).toBeCloseTo(30, 4);
  });

  it('keeps a steady median while a few frames hitch', () => {
    const meter = new FrameMeter(100);
    for (let i = 0; i < 100; i++) meter.push(i % 20 === 0 ? 50 : FRAME);

    const snap = meter.snapshot();
    expect(snap.fps).toBeCloseTo(60, 4); // the median is unaffected
    expect(snap.fpsLow).toBeCloseTo(20, 4); // 1000/50
  });

  it('drops a value once the window has wrapped', () => {
    const meter = new FrameMeter(3);
    meter.push(FRAME);
    meter.push(FRAME);
    meter.push(FRAME);
    meter.push(1000); // evicts the oldest 16.7 ms frame

    const snap = meter.snapshot();
    expect(snap.samples).toBe(3);
    expect(snap.fps).toBeGreaterThan(30); // median of 16.7, 16.7, 1000
  });

  it('ignores duplicate RAF stamps and reset clears the window', () => {
    const meter = new FrameMeter(10);
    meter.push(0);
    meter.push(-4);
    meter.push(Number.NaN);
    expect(meter.snapshot().samples).toBe(0);

    meter.push(FRAME);
    meter.reset();
    expect(meter.snapshot().samples).toBe(0);
  });
});
