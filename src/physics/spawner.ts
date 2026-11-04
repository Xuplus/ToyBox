// Scheduling for the ball spawner. Kept pure so the timing can be tested
// without running a simulation.

/** Upper bound on emissions for a single step.
 *
 *  The accumulator is capped by the engine, but a frame that stalls for 100 ms
 *  would still owe three balls. Emitting a handful is fine; emitting a hundred
 *  into a pile of a thousand is not, so the backlog is carried, not dumped. */
export const MAX_BURST = 4;

export interface EmissionPlan {
  /** how many balls to release now */
  count: number;
  /** leftover time (ms) to keep in the accumulator */
  carry: number;
}

/**
 * How many emissions are due after `accMs` of accumulated time.
 *
 * With a 16.7 ms step and a 340 ms rate the answer is 0 or 1 nearly always, so
 * the common path is a single subtraction.
 */
export function planEmissions(accMs: number, rateMs: number, maxBurst = MAX_BURST): EmissionPlan {
  if (!(rateMs > 0) || !(accMs > 0)) return { count: 0, carry: 0 };

  const due = Math.floor(accMs / rateMs);
  const count = Math.min(due, Math.max(0, maxBurst));

  return { count, carry: Math.max(0, accMs - count * rateMs) };
}
