// Injected time sources so tests can run the whole relay on a fake clock.

export interface Clock {
  now(): number;
}

export type Sleep = (ms: number) => Promise<void>;

export const systemClock: Clock = { now: () => Date.now() };

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
