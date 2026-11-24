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

// Regression (COR-2295): a server `cancel` control (RemoteWorker) or a
// long-poll heartbeat answering `cancelled` (LongPollWorker) used to abort the
// matching controller and nothing else, so an activity that ignores its signal
// kept its automatic heartbeat interval firing until the attempt settled.
// `cancel` clears exactly that attempt's interval and keeps its entry for the
// late result and the attempt's own `finally` cleanup.
describe('AttemptControllerTable cancellation', () => {
  it("cancel clears only the matching attempt's heartbeat timer and keeps its entry", () => {
    using clearIntervalSpy = spyOn(globalThis, 'clearInterval');
    const table = new AttemptControllerTable();
    const canceled = new AbortController();
    const live = new AbortController();
    table.set('op-1', 'attempt-1', canceled);
    table.set('op-2', 'attempt-2', live);
    const canceledTimer = setInterval(() => {}, 5);
    const liveTimer = setInterval(() => {}, 5);
    table.setHeartbeatTimer('op-1', 'attempt-1', canceledTimer);
    table.setHeartbeatTimer('op-2', 'attempt-2', liveTimer);

    try {
      clearIntervalSpy.mockClear();
      table.cancel('op-1', 'attempt-1', 'operator stop');

      expect(canceled.signal.aborted).toBe(true);
      expect(canceled.signal.reason).toBe('operator stop');
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(clearIntervalSpy).toHaveBeenCalledWith(canceledTimer);
      expect(table.get('op-1', 'attempt-1')).toBe(canceled);
      expect(live.signal.aborted).toBe(false);
      expect(table.get('op-2', 'attempt-2')).toBe(live);
    } finally {
      clearInterval(canceledTimer);
      clearInterval(liveTimer);
    }
  });

  it('ignores a stale attempt token and keeps the first reason on a repeated cancellation', () => {
    using clearIntervalSpy = spyOn(globalThis, 'clearInterval');
    const table = new AttemptControllerTable();
    const current = new AbortController();
    table.set('op-1', 'attempt-2', current);
    const timer = setInterval(() => {}, 5);
    table.setHeartbeatTimer('op-1', 'attempt-2', timer);

    try {
      clearIntervalSpy.mockClear();
      table.cancel('op-1', 'attempt-1', 'stale');
      expect(current.signal.aborted).toBe(false);
      expect(clearIntervalSpy).not.toHaveBeenCalled();

      table.cancel('op-1', 'attempt-2', 'first');
      table.cancel('op-1', 'attempt-2', 'second');
      expect(current.signal.reason).toBe('first');
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

      clearIntervalSpy.mockClear();
      table.delete('op-1', 'attempt-2');
      expect(clearIntervalSpy).not.toHaveBeenCalled();
      expect(table.get('op-1', 'attempt-2')).toBeUndefined();
    } finally {
      clearInterval(timer);
    }
  });
});
