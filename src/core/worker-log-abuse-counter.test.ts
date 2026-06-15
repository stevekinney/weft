import { describe, expect, it } from 'bun:test';

import { WorkerLogAbuseCounter } from './worker-log-abuse-counter.ts';

// A fake Worker — the counter only uses the reference as a WeakMap key, never calls it.
function fakeWorker(): Worker {
  return {} as unknown as Worker;
}

/** A controllable clock so window math is deterministic (no wall-clock sleeps). */
function controllableClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('WorkerLogAbuseCounter', () => {
  describe('flood budget (recordArrival)', () => {
    it('tolerates arrivals up to and including the threshold within a window', () => {
      const clock = controllableClock();
      const counter = new WorkerLogAbuseCounter({
        floodWindowMs: 1_000,
        floodThreshold: 3,
        strikeThreshold: 3,
        getNow: clock.now,
      });
      const worker = fakeWorker();

      expect(counter.recordArrival(worker)).toBe('tolerate'); // 1
      expect(counter.recordArrival(worker)).toBe('tolerate'); // 2
      expect(counter.recordArrival(worker)).toBe('tolerate'); // 3 == threshold
    });

    it('discards once arrivals exceed the threshold within a window', () => {
      const clock = controllableClock();
      const counter = new WorkerLogAbuseCounter({
        floodWindowMs: 1_000,
        floodThreshold: 2,
        strikeThreshold: 3,
        getNow: clock.now,
      });
      const worker = fakeWorker();

      expect(counter.recordArrival(worker)).toBe('tolerate'); // 1
      expect(counter.recordArrival(worker)).toBe('tolerate'); // 2 == threshold
      expect(counter.recordArrival(worker)).toBe('discard'); // 3 > threshold
    });

    it('resets the window after floodWindowMs elapses, so a slow trickle never discards', () => {
      const clock = controllableClock();
      const counter = new WorkerLogAbuseCounter({
        floodWindowMs: 1_000,
        floodThreshold: 1,
        strikeThreshold: 100,
        getNow: clock.now,
      });
      const worker = fakeWorker();

      expect(counter.recordArrival(worker)).toBe('tolerate'); // window A: 1
      clock.advance(1_000); // exactly at the window boundary opens a fresh window
      expect(counter.recordArrival(worker)).toBe('tolerate'); // window B: 1
      clock.advance(999); // still within window B
      expect(counter.recordArrival(worker)).toBe('discard'); // window B: 2 > 1
    });

    it('keeps per-worker windows independent', () => {
      const clock = controllableClock();
      const counter = new WorkerLogAbuseCounter({
        floodWindowMs: 1_000,
        floodThreshold: 1,
        strikeThreshold: 100,
        getNow: clock.now,
      });
      const workerA = fakeWorker();
      const workerB = fakeWorker();

      expect(counter.recordArrival(workerA)).toBe('tolerate'); // A: 1
      expect(counter.recordArrival(workerB)).toBe('tolerate'); // B: 1 (own window)
      expect(counter.recordArrival(workerA)).toBe('discard'); // A: 2 > 1
    });
  });

  describe('lifetime strikes (recordOutcome)', () => {
    it('never strikes an accepted-valid record', () => {
      const clock = controllableClock();
      const counter = new WorkerLogAbuseCounter({
        floodWindowMs: 1_000,
        floodThreshold: 100,
        strikeThreshold: 1,
        getNow: clock.now,
      });
      const worker = fakeWorker();

      // Even with a strikeThreshold of 1, valid records never accumulate strikes.
      expect(counter.recordOutcome(worker, 'accepted-valid')).toBe('tolerate');
      expect(counter.recordOutcome(worker, 'accepted-valid')).toBe('tolerate');
    });

    it('accumulates oversize and invalid into one bucket and discards at the threshold', () => {
      const clock = controllableClock();
      const counter = new WorkerLogAbuseCounter({
        floodWindowMs: 1_000,
        floodThreshold: 100,
        strikeThreshold: 3,
        getNow: clock.now,
      });
      const worker = fakeWorker();

      expect(counter.recordOutcome(worker, 'dropped-oversize')).toBe('tolerate'); // 1
      expect(counter.recordOutcome(worker, 'dropped-invalid')).toBe('tolerate'); // 2
      expect(counter.recordOutcome(worker, 'dropped-oversize')).toBe('discard'); // 3 == threshold
    });

    it('does not reset strikes across flood windows', () => {
      const clock = controllableClock();
      const counter = new WorkerLogAbuseCounter({
        floodWindowMs: 1_000,
        floodThreshold: 100,
        strikeThreshold: 2,
        getNow: clock.now,
      });
      const worker = fakeWorker();

      expect(counter.recordOutcome(worker, 'dropped-invalid')).toBe('tolerate'); // 1
      clock.advance(10_000); // many windows later
      expect(counter.recordOutcome(worker, 'dropped-invalid')).toBe('discard'); // 2 == threshold
    });

    it('keeps per-worker strike buckets independent', () => {
      const clock = controllableClock();
      const counter = new WorkerLogAbuseCounter({
        floodWindowMs: 1_000,
        floodThreshold: 100,
        strikeThreshold: 2,
        getNow: clock.now,
      });
      const workerA = fakeWorker();
      const workerB = fakeWorker();

      expect(counter.recordOutcome(workerA, 'dropped-oversize')).toBe('tolerate'); // A: 1
      expect(counter.recordOutcome(workerB, 'dropped-oversize')).toBe('tolerate'); // B: 1
      expect(counter.recordOutcome(workerA, 'dropped-oversize')).toBe('discard'); // A: 2
    });
  });

  describe('forget', () => {
    it('clears a worker so subsequent arrivals start a fresh window', () => {
      const clock = controllableClock();
      const counter = new WorkerLogAbuseCounter({
        floodWindowMs: 1_000,
        floodThreshold: 1,
        strikeThreshold: 100,
        getNow: clock.now,
      });
      const worker = fakeWorker();

      expect(counter.recordArrival(worker)).toBe('tolerate'); // 1
      counter.forget(worker);
      // Fresh state: this is "1" again, not "2", so it tolerates.
      expect(counter.recordArrival(worker)).toBe('tolerate');
    });

    it('is a no-op for a worker that was never recorded', () => {
      const clock = controllableClock();
      const counter = new WorkerLogAbuseCounter({
        floodWindowMs: 1_000,
        floodThreshold: 1,
        strikeThreshold: 1,
        getNow: clock.now,
      });
      expect(() => counter.forget(fakeWorker())).not.toThrow();
    });
  });
});
