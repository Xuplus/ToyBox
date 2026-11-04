import { describe, expect, it } from 'vitest';
import { planEmissions } from './spawner';

const RATE = 340;
const FRAME = 1000 / 60;

describe('planEmissions', () => {
  it('emits nothing until the first interval has elapsed', () => {
    expect(planEmissions(0, RATE)).toEqual({ count: 0, carry: 0 });
    expect(planEmissions(FRAME, RATE)).toEqual({ count: 0, carry: FRAME });
    expect(planEmissions(RATE - 1, RATE)).toEqual({ count: 0, carry: RATE - 1 });
  });

  it('emits at the interval and restarts the clock', () => {
    expect(planEmissions(RATE, RATE)).toEqual({ count: 1, carry: 0 });
    expect(planEmissions(RATE * 2, RATE)).toEqual({ count: 2, carry: 0 });

    const carried = planEmissions(RATE + FRAME, RATE);
    expect(carried.count).toBe(1);
    expect(carried.carry).toBeCloseTo(FRAME, 6);
  });

  it('never dumps a whole backlog in one step', () => {
    const plan = planEmissions(RATE * 100, RATE, 4);
    expect(plan.count).toBe(4);
    expect(plan.carry).toBe(RATE * 96);
  });

  it('survives a nonsense rate', () => {
    expect(planEmissions(1000, 0)).toEqual({ count: 0, carry: 0 });
    expect(planEmissions(1000, -5)).toEqual({ count: 0, carry: 0 });
  });

  it('produces one ball every rate ms over a simulated second', () => {
    let acc = 0;
    let emitted = 0;
    for (let i = 0; i < 60; i++) {
      acc += FRAME;
      const plan = planEmissions(acc, RATE);
      acc = plan.carry;
      emitted += plan.count;
    }
    // 1000 ms / 340 ms per ball.
    expect(emitted).toBe(2);
  });

  it('converges on the requested rate over many steps', () => {
    let acc = 0;
    let emitted = 0;
    const steps = 60 * 60; // one minute of 60 Hz steps
    for (let i = 0; i < steps; i++) {
      acc += FRAME;
      const plan = planEmissions(acc, RATE);
      acc = plan.carry;
      emitted += plan.count;
    }
    const expected = (steps * FRAME) / RATE;
    expect(emitted).toBeCloseTo(expected, -1);
  });
});
