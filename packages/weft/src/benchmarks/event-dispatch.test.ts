import { describe, expect, it } from 'bun:test';

/**
 * K2e: Event dispatch overhead benchmark.
 *
 * Measures the per-event overhead of dispatching events via
 * EventTarget (the same mechanism used by Engine). Architecture
 * target is <100μs; relaxed to <500μs to absorb variance.
 */

const TARGET_MICROSECONDS_PER_DISPATCH = process.env['CI'] ? 1_000 : 500;
const enforceArchitectureTarget = process.env['WEFT_EVENT_DISPATCH_ARCHITECTURE_BENCHMARK'] === '1';

describe('Event dispatch overhead', () => {
  it('records event dispatch overhead', () => {
    const target = new EventTarget();
    let received = 0;

    target.addEventListener('test', () => {
      received++;
    });

    const totalEvents = enforceArchitectureTarget ? 100_000 : 10_000;

    // Warm up: dispatch a few events to stabilize JIT.
    for (let i = 0; i < 1_000; i++) {
      target.dispatchEvent(new Event('test'));
    }
    received = 0;

    const start = performance.now();

    for (let i = 0; i < totalEvents; i++) {
      target.dispatchEvent(new Event('test'));
    }

    const elapsed = performance.now() - start;
    const microsecondsPerDispatch = (elapsed * 1000) / totalEvents;

    console.log(
      [
        `\n  Event dispatch overhead benchmark:`,
        `    Total events:    ${totalEvents.toLocaleString()}`,
        `    Elapsed:         ${elapsed.toFixed(2)}ms`,
        `    Per dispatch:    ${microsecondsPerDispatch.toFixed(3)}μs`,
        `    Target:          <${TARGET_MICROSECONDS_PER_DISPATCH}μs`,
        `    Events received: ${received.toLocaleString()}\n`,
      ].join('\n'),
    );

    expect(received).toBe(totalEvents);
    expect(microsecondsPerDispatch).toBeGreaterThan(0);
    if (enforceArchitectureTarget) {
      expect(microsecondsPerDispatch).toBeLessThan(TARGET_MICROSECONDS_PER_DISPATCH);
    }
  });
});
