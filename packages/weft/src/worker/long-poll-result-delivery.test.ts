/**
 * Unit coverage of `LongPollResultDelivery` against a fake `fetch` — no real
 * server needed, so every response class (2xx dispositions, correlated and
 * uncorrelated 403, network failure, malformed body) is directly
 * constructible and every barrier is an observed event rather than a sleep.
 *
 * @module worker/long-poll-result-delivery.test
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import {
  advanceTimersByTime,
  restoreRealTimers,
  useFakeTimers,
  waitForCondition,
} from '../testing/fake-timers.test-support.ts';
import {
  LongPollResultDelivery,
  type LongPollTaskResultBody,
} from './long-poll-result-delivery.ts';
import { TaskResultOutbox } from './task-result-outbox.ts';

function completedResult(overrides: Partial<LongPollTaskResultBody> = {}): LongPollTaskResultBody {
  return {
    operationId: 'op-1',
    attemptToken: 'attempt-1',
    workerId: 'worker-1',
    status: 'completed',
    value: 'done',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('LongPollResultDelivery', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreRealTimers();
  });

  it('retains a result until the disposition response is actually read, not merely until the POST resolves', async () => {
    let releaseResponse: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const fetchMock = mock(async () => {
      await held;
      return jsonResponse({ ok: true, disposition: 'applied' });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const delivery = new LongPollResultDelivery({ resultUrl: 'http://server/result' });
    delivery.deliver(completedResult());

    // The POST has been sent (fetch was called) but its response is held —
    // the entry must still be buffered.
    await waitForCondition(() => fetchMock.mock.calls.length === 1, { timeoutMs: 1_000 });
    expect(delivery.unacknowledgedCount).toBe(1);

    releaseResponse?.();
    await waitForCondition(() => delivery.unacknowledgedCount === 0, { timeoutMs: 1_000 });
  });

  it('retries on a transient failure (500) and acknowledges once a later attempt succeeds', async () => {
    let callCount = 0;
    const fetchMock = mock(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(new Response('Server Error', { status: 500 }));
      }
      return Promise.resolve(jsonResponse({ ok: true, disposition: 'applied' }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const delivery = new LongPollResultDelivery({
      resultUrl: 'http://server/result',
      retryBaseDelayMs: 5,
      retryMaxDelayMs: 50,
    });
    delivery.deliver(completedResult({ operationId: 'op-retry' }));

    await waitForCondition(() => delivery.unacknowledgedCount === 0, { timeoutMs: 2_000 });
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it('retries on a network failure and eventually acknowledges', async () => {
    let callCount = 0;
    const fetchMock = mock(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.reject(new Error('network down'));
      }
      return Promise.resolve(jsonResponse({ ok: true, disposition: 'applied' }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const delivery = new LongPollResultDelivery({
      resultUrl: 'http://server/result',
      retryBaseDelayMs: 5,
      retryMaxDelayMs: 50,
    });
    delivery.deliver(completedResult({ operationId: 'op-network-retry' }));

    await waitForCondition(() => delivery.unacknowledgedCount === 0, { timeoutMs: 2_000 });
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it('drops the buffered result on a correlated 403 (COR-1271 identity) and does not resend it', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        jsonResponse(
          {
            error: 'Forbidden',
            operationId: 'op-rejected',
            attemptToken: 'attempt-1',
            reason: 'unknown-operation',
          },
          403,
        ),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    using warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    const delivery = new LongPollResultDelivery({
      resultUrl: 'http://server/result',
      retryBaseDelayMs: 5,
      retryMaxDelayMs: 50,
    });
    delivery.deliver(completedResult({ operationId: 'op-rejected' }));

    await waitForCondition(() => delivery.unacknowledgedCount === 0, { timeoutMs: 1_000 });
    // No sleep needed: the correlated-403 branch calls outbox.reject() and
    // clearRetryTimer() synchronously within the same #send continuation
    // that just resolved unacknowledgedCount to 0 — no retry was ever
    // scheduled for this branch, so there is nothing left that could still
    // fire.
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('permanently rejected'));
  });

  it('does NOT drop on an uncorrelated 403 (no matching identity) — treats it as transient', async () => {
    let callCount = 0;
    const fetchMock = mock(() => {
      callCount += 1;
      if (callCount === 1) {
        // No operationId/attemptToken in the body — e.g. authorizeWorkerPrincipal's bare 403.
        return Promise.resolve(jsonResponse({ error: 'Forbidden' }, 403));
      }
      return Promise.resolve(jsonResponse({ ok: true, disposition: 'applied' }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    using warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    const delivery = new LongPollResultDelivery({
      resultUrl: 'http://server/result',
      retryBaseDelayMs: 5,
      retryMaxDelayMs: 50,
    });
    delivery.deliver(completedResult({ operationId: 'op-uncorrelated' }));

    await waitForCondition(() => delivery.unacknowledgedCount === 0, { timeoutMs: 2_000 });
    expect(fetchMock.mock.calls.length).toBe(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('uncorrelated 403'));
  });

  it('acknowledges (and warns) on a dead-lettered disposition — a durable terminal decision, not a rejection', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({ ok: true, disposition: 'dead-lettered' })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    using warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    const delivery = new LongPollResultDelivery({ resultUrl: 'http://server/result' });
    delivery.deliver(completedResult({ operationId: 'op-dead-letter' }));

    await waitForCondition(() => delivery.unacknowledgedCount === 0, { timeoutMs: 1_000 });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dead-lettered'));
  });

  it('acknowledges on a duplicate disposition, same as applied', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({ ok: true, disposition: 'duplicate' })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const delivery = new LongPollResultDelivery({ resultUrl: 'http://server/result' });
    delivery.deliver(completedResult({ operationId: 'op-duplicate' }));

    await waitForCondition(() => delivery.unacknowledgedCount === 0, { timeoutMs: 1_000 });
  });

  it('retries on a malformed 2xx body instead of assuming acknowledgement', async () => {
    let callCount = 0;
    const fetchMock = mock(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(new Response('not json', { status: 200 }));
      }
      return Promise.resolve(jsonResponse({ ok: true, disposition: 'applied' }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const delivery = new LongPollResultDelivery({
      resultUrl: 'http://server/result',
      retryBaseDelayMs: 5,
      retryMaxDelayMs: 50,
    });
    delivery.deliver(completedResult({ operationId: 'op-malformed-body' }));

    await waitForCondition(() => delivery.unacknowledgedCount === 0, { timeoutMs: 2_000 });
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it('suspend() cancels every scheduled retry — no further POST fires afterward', async () => {
    useFakeTimers();

    let callCount = 0;
    const fetchMock = mock(() => {
      callCount += 1;
      return Promise.resolve(new Response('Server Error', { status: 500 }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const delivery = new LongPollResultDelivery({
      resultUrl: 'http://server/result',
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 50,
    });
    delivery.deliver(completedResult({ operationId: 'op-suspended' }));

    await waitForCondition(() => fetchMock.mock.calls.length === 1, { timeoutMs: 1_000 });
    delivery.suspend();
    const countAtSuspend = fetchMock.mock.calls.length;

    // Not a timing-margin race: suspend() calls the platform's clearTimeout
    // synchronously and deterministically before this wait even starts, so a
    // cancelled timer literally cannot fire afterward. Advance the fake clock
    // well past the entry's own 10ms retry delay instead of waiting on the
    // wall clock — a real timer that somehow survived cancellation would
    // fire well within this advance, so the assertion stays a proof rather
    // than a race, at zero wall-clock cost.
    await advanceTimersByTime(100);
    expect(fetchMock.mock.calls.length).toBe(countAtSuspend);
    // The entry is still buffered — suspend() does not discard it.
    expect(delivery.unacknowledgedCount).toBe(1);
  });

  it('flush() resumes delivery for every currently-buffered entry', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response('Server Error', { status: 500 })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const delivery = new LongPollResultDelivery({
      resultUrl: 'http://server/result',
      retryBaseDelayMs: 10_000, // large — flush(), not the retry timer, must trigger the next attempt
      retryMaxDelayMs: 30_000,
    });
    delivery.deliver(completedResult({ operationId: 'op-flush' }));
    await waitForCondition(() => fetchMock.mock.calls.length === 1, { timeoutMs: 1_000 });

    delivery.suspend();
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(jsonResponse({ ok: true, disposition: 'applied' })),
    );
    delivery.flush();

    await waitForCondition(() => delivery.unacknowledgedCount === 0, { timeoutMs: 1_000 });
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it('dispose() discards buffered entries and cancels retries', async () => {
    useFakeTimers();

    const fetchMock = mock(() => Promise.resolve(new Response('Server Error', { status: 500 })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const delivery = new LongPollResultDelivery({
      resultUrl: 'http://server/result',
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 50,
    });
    delivery.deliver(completedResult({ operationId: 'op-disposed' }));
    await waitForCondition(() => fetchMock.mock.calls.length === 1, { timeoutMs: 1_000 });

    delivery.dispose();
    expect(delivery.unacknowledgedCount).toBe(0);

    const countAtDispose = fetchMock.mock.calls.length;
    // Same deterministic-cancellation reasoning as suspend()'s test above —
    // dispose() calls suspend() (clearTimeout) before this advance starts.
    // Advancing the fake clock past the entry's 10ms retry delay is a proof
    // that no timer survived, with no real wall-clock wait.
    await advanceTimersByTime(100);
    expect(fetchMock.mock.calls.length).toBe(countAtDispose);
  });

  it('full and shouldWarnFull delegate to the injected outbox (COR-235 backpressure)', async () => {
    let releaseResponses: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      releaseResponses = resolve;
    });
    const fetchMock = mock(async () => {
      await held;
      return jsonResponse({ ok: true, disposition: 'applied' });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // A ceiling of 1 (like task-result-outbox.test.ts's own `shouldWarnFull`
    // coverage) reproduces the real MAX_BUFFERED_TASK_RESULTS backpressure
    // `LongPollWorker#atCapacity()` (long-poll.ts) checks, without buffering
    // 1,000 entries: `deliver()` resolves once the first attempt's round
    // trip completes, but that response is held above, so the entry stays
    // buffered while both assertions below run.
    const delivery = new LongPollResultDelivery(
      { resultUrl: 'http://server/result' },
      new TaskResultOutbox(1),
    );
    const deliverPromise = delivery.deliver(completedResult());
    await waitForCondition(() => fetchMock.mock.calls.length === 1, { timeoutMs: 1_000 });

    expect(delivery.full).toBe(true);
    expect(delivery.shouldWarnFull()).toBe(true);
    expect(delivery.shouldWarnFull()).toBe(false);

    releaseResponses?.();
    await deliverPromise;
    await waitForCondition(() => delivery.unacknowledgedCount === 0, { timeoutMs: 1_000 });
    expect(delivery.full).toBe(false);
  });
});
