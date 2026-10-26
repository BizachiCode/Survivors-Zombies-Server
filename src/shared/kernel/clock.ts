/** Time source (injectable so services can be tested at a fixed moment). */
export interface Clock {
  now(): Date;
  nowMs(): number;
  nowUnix(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowMs: () => Date.now(),
  nowUnix: () => Math.floor(Date.now() / 1000),
};

/** Clock frozen at `ms` (advance it with `set`). */
export function fixedClock(ms: number): Clock & { set(value: number): void } {
  let current = ms;
  return {
    now: () => new Date(current),
    nowMs: () => current,
    nowUnix: () => Math.floor(current / 1000),
    set: (value: number) => { current = value; },
  };
}
