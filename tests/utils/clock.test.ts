import {
  SystemClock,
  TestClock,
  SystemRandom,
  DeterministicRandom,
  calculateJitter,
  isExpired,
} from "../../src/utils/clock";

describe("clock and randomness abstractions", () => {
  describe("TestClock", () => {
    it("initializes to given timestamp and advances deterministically", () => {
      const initial = 1700000000000;
      const clock = new TestClock(initial);

      expect(clock.now()).toBe(initial);
      expect(clock.date().getTime()).toBe(initial);

      clock.advance(5000);
      expect(clock.now()).toBe(initial + 5000);

      clock.set(initial + 20000);
      expect(clock.now()).toBe(initial + 20000);
    });

    it("evaluates expiry deterministically with isExpired", () => {
      const clock = new TestClock(1000);
      const createdAt = 1000;
      const ttl = 5000;

      expect(isExpired(createdAt, ttl, clock)).toBe(false);

      clock.advance(4999);
      expect(isExpired(createdAt, ttl, clock)).toBe(false);

      clock.advance(1);
      expect(isExpired(createdAt, ttl, clock)).toBe(true);

      clock.advance(1000);
      expect(isExpired(createdAt, ttl, clock)).toBe(true);
    });
  });

  describe("SystemClock", () => {
    it("returns active timestamp and date instance", () => {
      const clock = new SystemClock();
      const before = Date.now();
      const now = clock.now();
      const after = Date.now();

      expect(now).toBeGreaterThanOrEqual(before);
      expect(now).toBeLessThanOrEqual(after);
      expect(clock.date()).toBeInstanceOf(Date);
    });
  });

  describe("DeterministicRandom", () => {
    it("generates identical sequence when initialized with same seed", () => {
      const rand1 = new DeterministicRandom(42);
      const rand2 = new DeterministicRandom(42);

      const seq1 = [rand1.random(), rand1.random(), rand1.random()];
      const seq2 = [rand2.random(), rand2.random(), rand2.random()];

      expect(seq1).toEqual(seq2);
    });

    it("generates random integers within bounded range [min, max]", () => {
      const rand = new DeterministicRandom(12345);
      for (let i = 0; i < 50; i++) {
        const val = rand.randomInt(10, 20);
        expect(val).toBeGreaterThanOrEqual(10);
        expect(val).toBeLessThanOrEqual(20);
        expect(Number.isInteger(val)).toBe(true);
      }
    });

    it("calculates reproducible jitter values", () => {
      const rand1 = new DeterministicRandom(999);
      const rand2 = new DeterministicRandom(999);

      const baseDelay = 1000;
      const factor = 0.25;

      const jitter1 = calculateJitter(baseDelay, factor, rand1);
      const jitter2 = calculateJitter(baseDelay, factor, rand2);

      expect(jitter1).toBe(jitter2);
      expect(jitter1).toBeGreaterThanOrEqual(0);
      expect(jitter1).toBeLessThanOrEqual(baseDelay * factor);
    });
  });

  describe("SystemRandom", () => {
    it("generates numbers in range [0, 1)", () => {
      const rand = new SystemRandom();
      const val = rand.random();
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    });
  });
});
