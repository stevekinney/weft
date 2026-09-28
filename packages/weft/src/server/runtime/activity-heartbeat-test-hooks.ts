/**
 * Test-only observability seam for `activityHeartbeat`'s durable ledger
 * write (`onActivityHeartbeatMessage` in `websocket-worker.ts`). That write
 * is fire-and-forget in production — the worker never blocks on it, and
 * nothing else in the protocol acknowledges it — so a test asserting the
 * write landed durably previously had no production signal to await and had
 * to poll the ledger against a fixed wall-clock budget (COR-235). Under
 * heavy machine load that budget is a latency assertion in disguise, not a
 * hang guard, and fails the test rather than the assertion.
 *
 * Mirrors `useManualTaskReconciliationForTesting`'s WeakMap-keyed
 * registration pattern (`task-reconciliation.ts`): a real hook exists only
 * for a server a test explicitly marks, so production behavior and the
 * exported `ServeOptions` surface are both unchanged for every other caller.
 *
 * Keyed off `options.engine`, NOT the `ServeOptions` object itself.
 * `resolveNetworkConfig()` (`serve-internals.ts`) builds a shallow-copied
 * `{ ...options, prometheusExporter }`, and that copy — not the object a
 * test passed to `serve()` — is what actually reaches the WebSocket message
 * handlers (`createServerWebSocketHandlers`). A `WeakMap<ServeOptions, ...>`
 * keyed on object identity silently never matches there: this bit a first
 * version of this hook, which passed its own unit tests against
 * `handleWorkerWebSocketMessage()` called directly with one shared `options`
 * object (no `serve()`, no copy involved) and only surfaced as a 5-second
 * hang once `remote-worker-reconnection.test.ts` exercised it through a real
 * `serve()` server. The spread is shallow, so `options.engine` is the exact
 * same reference on both sides of the copy; every `ServeOptions` a test
 * builds also constructs its own `Engine`, so keying on it is equally
 * one-server-per-test as keying on `ServeOptions` would have been, without
 * the copy hazard.
 *
 * @module server/runtime/activity-heartbeat-test-hooks
 */

import type { ServeOptions } from '../index.ts';

type EngineKey = ServeOptions['engine'];

/**
 * Outcome of one `activityHeartbeat`'s durable ledger write attempt.
 *
 * - `committed`: `renewAttemptLease` accepted the transition and the CAS
 *   landed — the persisted lease deadline was extended.
 * - `rejected`: the heartbeat was authorized against the in-memory registry,
 *   but either the durable transition's own precondition rejected it (a
 *   concurrent completion/requeue/cancellation already moved the record) or
 *   the storage write itself failed after retries.
 * - `skipped`: no durable write was even attempted — either the worker was
 *   not authorized at all (stale/superseded attempt, or the operation was no
 *   longer tracked in the registry by the time this heartbeat was handled),
 *   or the message failed protocol-boundary validation before authorization
 *   could matter (COR-226: an oversized/invalid `details` payload).
 */
export type ActivityHeartbeatAppliedEvent = Readonly<{
  operationId: string;
  attemptToken: string;
  outcome: 'committed' | 'rejected' | 'skipped';
  reason?: string;
}>;

type Listener = (event: ActivityHeartbeatAppliedEvent) => void;

interface ActivityHeartbeatTestRegistration {
  readonly listeners: Set<Listener>;
}

const registrations = new WeakMap<EngineKey, ActivityHeartbeatTestRegistration>();

/** Handle returned by {@link useObservableActivityHeartbeatsForTesting}. */
export interface ObservableActivityHeartbeatsForTesting {
  /**
   * Resolve with the next reported `activityHeartbeat` outcome matching
   * `predicate`. Never installs a timer of its own — the caller's own
   * `await` is bounded only by the test runner's per-test timeout, since a
   * heartbeat that is never reported at all is exactly the failure a test
   * using this needs to see, not a race this helper should paper over.
   */
  next(
    predicate: (event: ActivityHeartbeatAppliedEvent) => boolean,
  ): Promise<ActivityHeartbeatAppliedEvent>;
}

/**
 * @internal Marks `options.engine` so its server reports every
 * `activityHeartbeat` durability outcome to test observers. Unlike
 * `useManualTaskReconciliationForTesting`, this has no one-shot "consumed at
 * `serve()` startup" step — `reportActivityHeartbeatAppliedForTesting` looks
 * the registration up live on every call — so it may be called before or
 * after `serve()`, as long as it is called with the same `ServeOptions`
 * object (or at least the same `.engine`) `serve()` received, and before the
 * heartbeat a test wants to observe is sent.
 */
export function useObservableActivityHeartbeatsForTesting(
  options: ServeOptions,
): ObservableActivityHeartbeatsForTesting {
  const key = options.engine;
  const existing = registrations.get(key);
  const registration: ActivityHeartbeatTestRegistration = existing ?? { listeners: new Set() };
  if (existing === undefined) registrations.set(key, registration);
  return {
    next(predicate) {
      return new Promise((resolve) => {
        const listener: Listener = (event) => {
          if (!predicate(event)) return;
          registration.listeners.delete(listener);
          resolve(event);
        };
        registration.listeners.add(listener);
      });
    },
  };
}

/**
 * @internal Reports one heartbeat-applied outcome to any test observer
 * registered for `options`. A silent no-op when none is registered — always
 * safe to call unconditionally from production code, and cheap (a single
 * `WeakMap.get`) when no test is watching.
 */
export function reportActivityHeartbeatAppliedForTesting(
  options: ServeOptions,
  event: ActivityHeartbeatAppliedEvent,
): void {
  const registration = registrations.get(options.engine);
  if (registration === undefined) return;
  // Snapshot before dispatch: a listener's own resolution can synchronously
  // register a new `next()` waiter for a later event, and that must not be
  // visited by this same dispatch pass.
  for (const listener of Array.from(registration.listeners)) {
    listener(event);
  }
}
