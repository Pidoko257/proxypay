/**
 * Pluggable clock and randomness abstractions to make expiry, jitter,
 * retry delays, replay guards, and threshold tests fully deterministic.
 */

export interface IClock {
  now(): number;
  date(): Date;
  sleep(ms: number): Promise<void>;
}

export class SystemClock implements IClock {
  public now(): number {
    return Date.now();
  }

  public date(): Date {
    return new Date();
  }

  public sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export class TestClock implements IClock {
  private currentTime: number;

  constructor(initialTime: number | Date = Date.now()) {
    this.currentTime = typeof initialTime === "number" ? initialTime : initialTime.getTime();
  }

  public now(): number {
    return this.currentTime;
  }

  public date(): Date {
    return new Date(this.currentTime);
  }

  public set(time: number | Date): void {
    this.currentTime = typeof time === "number" ? time : time.getTime();
  }

  public advance(ms: number): void {
    this.currentTime += ms;
  }

  public async sleep(ms: number): Promise<void> {
    this.advance(ms);
  }
}

export interface IRandom {
  random(): number;
  randomInt(min: number, max: number): number;
  jitter(baseDelay: number, jitterFactor?: number): number;
}

export class SystemRandom implements IRandom {
  public random(): number {
    return Math.random();
  }

  public randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  public jitter(baseDelay: number, jitterFactor: number = 0.2): number {
    return baseDelay * jitterFactor * this.random();
  }
}

/**
 * Seedable pseudo-random number generator (Mulberry32) for deterministic tests.
 */
export class DeterministicRandom implements IRandom {
  private state: number;

  constructor(seed: number = 1337) {
    this.state = seed | 0;
  }

  public setSeed(seed: number): void {
    this.state = seed | 0;
  }

  public random(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  public randomInt(min: number, max: number): number {
    return Math.floor(this.random() * (max - min + 1)) + min;
  }

  public jitter(baseDelay: number, jitterFactor: number = 0.2): number {
    return baseDelay * jitterFactor * this.random();
  }
}

export const defaultClock: IClock = new SystemClock();
export const defaultRandom: IRandom = new SystemRandom();

/**
 * Calculate deterministic or system jitter for backoff.
 */
export function calculateJitter(
  baseDelay: number,
  jitterFactor: number = 0.2,
  randomSource: IRandom = defaultRandom
): number {
  return randomSource.jitter(baseDelay, jitterFactor);
}

/**
 * Check if a timestamp has expired relative to a clock source and TTL.
 */
export function isExpired(
  timestamp: number | Date,
  ttlMs: number,
  clock: IClock = defaultClock
): boolean {
  const ts = typeof timestamp === "number" ? timestamp : timestamp.getTime();
  return clock.now() - ts >= ttlMs;
}
