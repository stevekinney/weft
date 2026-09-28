import { describe, expect, it, spyOn } from 'bun:test';
import { AttemptControllerTable } from './attempt-controllers.ts';

// Regression (COR-1343): RemoteWorker and LongPollWorker both arm a
// per-attempt heartbeat `setInterval` right after registering the attempt's
// AbortController, and both relied on the attempt's own `finally` block to
// `clearInterval` it. An activity that never settles (ignores its abort
// signal, e.g. `await new Promise(() => {})`) never reaches that `finally`,
// so aborting or deleting the attempt out from under it — the drain-timeout
// path, `stop()`, or `[Symbol.dispose]()` — left the heartbeat interval
// running forever, firing real timers the timer-leak guard reports as a
// leak. `setHeartbeatTimer` lets `delete`/`abortAll` clear it too.
//
// Both tests assert via a `clearInterval` spy (matching
// `task-queue.test.ts`'s identical `clearTimeoutSpy` pattern) rather than
// waiting out a real interval tick: a wall-clock wait here would be a weak
// witness on a loaded host (a starved interval never firing within the wait
// would pass just as readily as a correctly-cleared one), and asserting the
// exact call is deterministic and immediate.
describe('AttemptControllerTable heartbeat timer tracking', () => {
  it('abortAll clears every tracked heartbeat timer, not just the AbortController', () => {
    using clearIntervalSpy = spyOn(globalThis, 'clearInterval');
    const table = new AttemptControllerTable();
    const controller = new AbortController();
    table.set('op-1', 'attempt-1', controller);

    const timer = setInterval(() => {}, 5);
    table.setHeartbeatTimer('op-1', 'attempt-1', timer);

    clearIntervalSpy.mockClear();
    table.abortAll();

    expect(controller.signal.aborted).toBe(true);
    // `spyOn` calls through to the real `clearInterval` by default (no
    // `.mockImplementation()` here), so this also proves the timer was
    // actually cleared, not merely that the call was observed.
    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
  });

  it("delete clears exactly that attempt's tracked heartbeat timer", () => {
    using clearIntervalSpy = spyOn(globalThis, 'clearInterval');
    const table = new AttemptControllerTable();
    const controller = new AbortController();
    table.set('op-2', 'attempt-2', controller);

    const timer = setInterval(() => {}, 5);
    table.setHeartbeatTimer('op-2', 'attempt-2', timer);

    clearIntervalSpy.mockClear();
    table.delete('op-2', 'attempt-2');

    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
  });
});
