import { describe, expect, it } from 'bun:test';
import { CounterWindow, HistogramWindow } from './sliding-window';

describe('CounterWindow', () => {
  it('records events and computes correct rate', () => {
    const window = new CounterWindow(60_000);
    window.record(1000, false);
    window.record(2000, true);
    window.record(3000, false);
    window.record(4000, true);
    expect(window.rate(5000)).toBe(0.5);
  });

  it('prunes entries older than window', () => {
    const window = new CounterWindow(10_000);
    window.record(1000, true); // will be pruned
    window.record(2000, true); // will be pruned
    window.record(15_000, false);
    window.record(16_000, false);
    expect(window.rate(16_000)).toBe(0);
  });

  it('returns 0 when empty', () => {
    const window = new CounterWindow(60_000);
    expect(window.rate(1000)).toBe(0);
  });

  it('returns 1 when all events are failures', () => {
    const window = new CounterWindow(60_000);
    window.record(1000, true);
    window.record(2000, true);
    window.record(3000, true);
    expect(window.rate(4000)).toBe(1);
  });

  it('returns 0 when no events are failures', () => {
    const window = new CounterWindow(60_000);
    window.record(1000, false);
    window.record(2000, false);
    expect(window.rate(3000)).toBe(0);
  });
});

describe('HistogramWindow', () => {
  it('computes p99 correctly with many observations', () => {
    const window = new HistogramWindow(60_000);
    // Record 100 observations from 1 to 100
    for (let i = 1; i <= 100; i++) {
      window.record(i * 100, i);
    }
    // p99 should be the 99th value
    expect(window.percentile(99, 20_000)).toBe(99);
  });

  it('handles single observation', () => {
    const window = new HistogramWindow(60_000);
    window.record(1000, 42);
    expect(window.percentile(99, 2000)).toBe(42);
    expect(window.percentile(50, 2000)).toBe(42);
  });

  it('prunes old observations', () => {
    const window = new HistogramWindow(10_000);
    window.record(1000, 100); // old, will be pruned
    window.record(15_000, 5);
    window.record(16_000, 10);
    // After pruning, only 5 and 10 remain
    expect(window.percentile(50, 16_000)).toBe(5);
    expect(window.percentile(99, 16_000)).toBe(10);
  });

  it('returns 0 when empty', () => {
    const window = new HistogramWindow(60_000);
    expect(window.percentile(99, 1000)).toBe(0);
  });

  it('computes p50 correctly', () => {
    const window = new HistogramWindow(60_000);
    for (let i = 1; i <= 10; i++) {
      window.record(i * 100, i * 10);
    }
    expect(window.percentile(50, 5000)).toBe(50);
  });
});
