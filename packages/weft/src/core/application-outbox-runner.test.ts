/**
 * The adapter runner under pressure (WFT-85): a caller abort reaching the
 * adapter mid-send, lease renewal while a send outlasts its visibility
 * window, a renewal refused because another process recovered the lease,
 * bounded adapter error diagnostics, maintenance dispositions counted by the
 * drain, backlog enforced on operator retry, a maintenance pass cut short by
 * disposal, and same-attempt refusals that leave the live lease alone.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../storage/memory.ts';
import {
  advanceTimersByTime,
  createDeferred,
  flushMicrotasks,
  restoreRealTimers,
  useFakeTimers,
} from '../testing/fake-timers.test-support.ts';
import {
  beginOne,
  claimOne,
  createOutboxClock,
  createOutboxFixture,
  deliverOne,
  enqueueOne,
  fieldOf,
  ScriptedAdapter,
  statusOf,
} from './application-outbox.test-support.ts';

/**
 * A second storage identity over the same instance: the durable state is
 * shared, the process-local attempt registry (keyed by storage identity) is
 * not, which is how a separate process looks from inside one test.
 */
function remoteView(storage: MemoryStorage): MemoryStorage {
  return new Proxy(storage, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** A storage whose conditional batches can be observed per call. */
class HookedStorage extends MemoryStorage {
  beforeBatch: ((ordinal: number) => void) | null = null;
  beforeGet: ((key: string) => void | Promise<void>) | null = null;
  #ordinal = 0;

  override async get(key: string): Promise<Uint8Array | null> {
    await this.beforeGet?.(key);
    return super.get(key);
  }

  override async conditionalBatch(
    ...arguments_: Parameters<MemoryStorage['conditionalBatch']>
  ): Promise<boolean> {
    this.#ordinal += 1;
    this.beforeBatch?.(this.#ordinal);
    return super.conditionalBatch(...arguments_);
  }
}

/** Await the adapter's first call; a genuine await, so it works under fake timers too. */
async function untilRequested(adapter: ScriptedAdapter): Promise<void> {
  await adapter.nextRequest();
}

describe('runner: caller abort during a send', () => {
  it('forwards a caller abort to the adapter signal and settles the attempt as unknown', async () => {
    const { outbox, adapter } = createOutboxFixture();
    const deliveryId = await enqueueOne(outbox);
    adapter.block();
    const controller = new AbortController();
    const pending = outbox.deliverNext({ signal: controller.signal });
    await untilRequested(adapter);
    controller.abort(new Error('shutting down'));
    const result = await pending;
    expect(adapter.requests[0]!.signal.aborted).toBe(true);
    expect(adapter.requests[0]!.signal.reason).toMatchObject({ message: 'shutting down' });
    // The caller has stopped waiting; the unknown outcome is still settled,
    // fenced on the attempt, once the settlement finishes on its own.
    expect(result).toMatchObject({ status: 'settled', committed: false });
    await flushMicrotasks(64);
    expect(await fieldOf(outbox.receipt(deliveryId), 'state')).toBe('unknown-outcome');
    const failure = await fieldOf(outbox.receipt(deliveryId), 'failure');
    expect(failure?.message).toContain('aborted while the transport call was in flight');
    outbox.dispose();
  });

  it('stops a drain whose caller aborts mid-send without hanging on the adapter', async () => {
    const { outbox, adapter } = createOutboxFixture();
    const deliveryId = await enqueueOne(outbox);
    adapter.block();
    const controller = new AbortController();
    const draining = outbox.drain({ timeoutMs: 100_000, signal: controller.signal });
    await untilRequested(adapter);
    controller.abort();
    const report = await draining;
    expect(report).toMatchObject({ unknown: 0, pending: 1, drained: false });
    await flushMicrotasks(64);
    expect(await fieldOf(outbox.receipt(deliveryId), 'state')).toBe('unknown-outcome');
    outbox.dispose();
  });
});

describe('runner: abort before the send', () => {
  it('leaves a claim to lapse when the caller aborted while it was committing', async () => {
    const storage = new HookedStorage();
    const { outbox, adapter, clock } = createOutboxFixture({ storage, attemptTimeoutMs: 100 });
    const deliveryId = await enqueueOne(outbox);
    const controller = new AbortController();
    storage.beforeBatch = (ordinal) => {
      if (ordinal === 2) controller.abort(new Error('gone'));
    };
    const result = await outbox.deliverNext({ signal: controller.signal });
    expect(result.status === 'settled' && result.receipt.state).toBe('claimed');
    expect(adapter.requests).toHaveLength(0);
    clock.advance(100);
    expect(await outbox.runMaintenance()).toMatchObject({ rescheduled: 1 });
    expect(await fieldOf(outbox.receipt(deliveryId), 'state')).toBe('retry-scheduled');
    outbox.dispose();
  });

  it('reschedules an attempt whose caller aborted while the begin was committing', async () => {
    const storage = new HookedStorage();
    const { outbox, adapter } = createOutboxFixture({ storage });
    const deliveryId = await enqueueOne(outbox);
    const controller = new AbortController();
    storage.beforeBatch = (ordinal) => {
      if (ordinal === 3) controller.abort(new Error('gone'));
    };
    const result = await outbox.deliverNext({ signal: controller.signal });
    expect(result).toMatchObject({ status: 'settled', committed: false });
    await flushMicrotasks(64);
    expect(await fieldOf(outbox.receipt(deliveryId), 'state')).toBe('retry-scheduled');
    expect(adapter.requests).toHaveLength(0);
    const failure = await fieldOf(outbox.receipt(deliveryId), 'lastFailure');
    expect(failure?.message).toContain('before the transport was called');
    outbox.dispose();
  });
});

describe('runner: lease renewal while the adapter runs', () => {
  afterEach(() => {
    restoreRealTimers();
  });

  it('renews visibility at half the window so a long send is not reclaimed', async () => {
    useFakeTimers();
    const { outbox, adapter, clock } = createOutboxFixture({
      visibilityTimeoutMs: 100,
      attemptTimeoutMs: 10_000,
    });
    const deliveryId = await enqueueOne(outbox);
    const release = adapter.block();
    const pending = outbox.deliverNext();
    await untilRequested(adapter);
    // Three half-windows pass; each renewal moves the expiry forward.
    for (let step = 0; step < 3; step += 1) {
      clock.advance(50);
      await advanceTimersByTime(50);
      await flushMicrotasks(32);
    }
    const midway = await outbox.receipt(deliveryId);
    expect(midway?.state).toBe('attempting');
    expect(midway?.visibilityExpiresAt).toBe(clock.now() + 100);
    expect(await outbox.runMaintenance()).toMatchObject({ parked: 0, rescheduled: 0 });
    release({ status: 'acknowledged' });
    await flushMicrotasks(32);
    const result = await pending;
    expect(result.status === 'settled' && result.receipt.state).toBe('acknowledged');
    outbox.dispose();
  });

  it('aborts the adapter once a renewal is refused because the lease was recovered elsewhere', async () => {
    useFakeTimers();
    const storage = new MemoryStorage();
    const clock = createOutboxClock();
    const { outbox, adapter } = createOutboxFixture({
      storage,
      clock,
      visibilityTimeoutMs: 100,
      attemptTimeoutMs: 10_000,
    });
    const deliveryId = await enqueueOne(outbox);
    const release = adapter.block();
    const pending = outbox.deliverNext();
    await untilRequested(adapter);
    // The clock jumps past the window before any renewal timer fires, and a
    // sibling process recovers the lease.
    clock.advance(100);
    const sibling = createOutboxFixture({ storage, clock }).outbox;
    expect(await sibling.runMaintenance()).toMatchObject({ parked: 1 });
    await advanceTimersByTime(50);
    await flushMicrotasks(32);
    expect(adapter.requests[0]!.signal.aborted).toBe(true);
    release({ status: 'acknowledged' });
    await flushMicrotasks(32);
    const result = await pending;
    // Whatever the adapter said afterwards, the durable disposition stands.
    expect(result.status === 'settled' && result.receipt.state).toBe('unknown-outcome');
    expect(await fieldOf(outbox.receipt(deliveryId), 'cleanupPending')).toBe(true);
    sibling.dispose();
    outbox.dispose();
  });

  it('aborts the adapter when a process that shares no registry recovers the lease', async () => {
    useFakeTimers();
    const storage = new MemoryStorage();
    const clock = createOutboxClock();
    const { outbox, adapter } = createOutboxFixture({
      storage,
      clock,
      visibilityTimeoutMs: 100,
      attemptTimeoutMs: 10_000,
    });
    await enqueueOne(outbox);
    const release = adapter.block();
    const pending = outbox.deliverNext();
    await untilRequested(adapter);
    clock.advance(100);
    // A distinct storage identity stands in for another process: it shares the
    // durable state but not the process-local attempt registry, so only the
    // refused renewal can tell this runner that its lease is gone.
    const remote = createOutboxFixture({ storage: remoteView(storage), clock }).outbox;
    expect(await remote.runMaintenance()).toMatchObject({ parked: 1 });
    expect(adapter.requests[0]!.signal.aborted).toBe(false);
    await advanceTimersByTime(50);
    await flushMicrotasks(32);
    expect(adapter.requests[0]!.signal.aborted).toBe(true);
    // The confirmed window was already gone when the renewal timer fired.
    expect(adapter.requests[0]!.signal.reason).toMatchObject({
      message: 'The attempt lease expired before its renewal could be confirmed.',
    });
    release({ status: 'acknowledged' });
    const result = await pending;
    expect(result.status === 'settled' && result.receipt.state).toBe('unknown-outcome');
    remote.dispose();
    outbox.dispose();
  });

  it('retries a renewal whose storage read failed rather than giving up on the lease', async () => {
    useFakeTimers();
    let failing = false;
    class FlakyStorage extends MemoryStorage {
      override async get(key: string): Promise<Uint8Array | null> {
        if (failing) throw new Error('read failed');
        return super.get(key);
      }
    }
    const { outbox, adapter, clock } = createOutboxFixture({
      storage: new FlakyStorage(),
      visibilityTimeoutMs: 100,
      attemptTimeoutMs: 10_000,
    });
    await enqueueOne(outbox);
    const release = adapter.block();
    const pending = outbox.deliverNext();
    await untilRequested(adapter);
    failing = true;
    clock.advance(50);
    await advanceTimersByTime(50);
    await flushMicrotasks(32);
    failing = false;
    clock.advance(2);
    await advanceTimersByTime(2);
    await flushMicrotasks(32);
    expect(adapter.requests[0]!.signal.aborted).toBe(false);
    release({ status: 'acknowledged' });
    await flushMicrotasks(32);
    const result = await pending;
    expect(result.status === 'settled' && result.receipt.state).toBe('acknowledged');
    outbox.dispose();
  });
});

describe('runner: bounded diagnostics and drain accounting', () => {
  it('bounds an adapter exception message before persisting it', async () => {
    const { outbox, adapter } = createOutboxFixture();
    adapter.fail(new Error('x'.repeat(20_000)));
    const deliveryId = await enqueueOne(outbox);
    expect(await deliverOne(outbox)).toBe('unknown-outcome');
    const failure = await fieldOf(outbox.receipt(deliveryId), 'failure');
    expect(new TextEncoder().encode(failure?.message ?? '').byteLength).toBeLessThanOrEqual(4096);
    expect(failure?.message).toContain('The transport adapter threw');
    outbox.dispose();
  });

  it('counts dispositions the drain committed through maintenance', async () => {
    const storage = new MemoryStorage();
    const clock = createOutboxClock();
    const crashed = createOutboxFixture({ storage, clock, attemptTimeoutMs: 100 }).outbox;
    await enqueueOne(crashed);
    await beginOne(crashed);
    crashed.dispose();
    clock.advance(100);
    const { outbox } = createOutboxFixture({ storage, clock });
    const report = await outbox.drain({ timeoutMs: 0 });
    expect(report).toMatchObject({ unknown: 1, pending: 0, drained: true });
    outbox.dispose();
  });
});

describe('operator retry and backlog', () => {
  it('refuses to reopen a delivery past maxBacklog, fenced on the header', async () => {
    const { outbox, adapter } = createOutboxFixture({ maxBacklog: 1 });
    adapter.reply({ status: 'unknown' });
    const parked = await enqueueOne(outbox);
    expect(await deliverOne(outbox)).toBe('unknown-outcome');
    await enqueueOne(outbox);
    const refused = await outbox.retry({ deliveryId: parked });
    expect(refused).toMatchObject({
      status: 'rejected',
      reason: 'backlog-full',
      capacity: { open: 1, limit: 1, remaining: 0 },
    });
    expect(await fieldOf(outbox.receipt(parked), 'state')).toBe('unknown-outcome');
    expect(await outbox.capacity()).toMatchObject({ open: 1 });
    outbox.dispose();
  });

  it('still dead-letters a parked delivery when the backlog is full', async () => {
    const { outbox, adapter } = createOutboxFixture({ maxBacklog: 1 });
    adapter.reply({ status: 'unknown' });
    const parked = await enqueueOne(outbox);
    await deliverOne(outbox);
    await enqueueOne(outbox);
    expect(await statusOf(outbox.deadLetter({ deliveryId: parked }))).toBe('applied');
    outbox.dispose();
  });
});

describe('automatic maintenance and disposal', () => {
  afterEach(() => {
    restoreRealTimers();
  });

  it('stops an in-flight pass at its next step once the outbox is disposed', async () => {
    useFakeTimers();
    const gate = createDeferred();
    let scans = 0;
    class GatedStorage extends MemoryStorage {
      override async *scan(
        ...arguments_: Parameters<MemoryStorage['scan']>
      ): ReturnType<MemoryStorage['scan']> {
        scans += 1;
        if (scans === 2) await gate.promise;
        yield* super.scan(...arguments_);
      }
    }
    const storage = new GatedStorage();
    const clock = createOutboxClock();
    const worker = createOutboxFixture({ storage, clock, attemptTimeoutMs: 100 }).outbox;
    const deliveryId = await enqueueOne(worker);
    await claimOne(worker);
    worker.dispose();
    clock.advance(100);
    const errors: unknown[] = [];
    const automatic = createOutboxFixture({
      storage,
      clock,
      backgroundTasks: 'automatic',
      maintenanceIntervalMs: 10,
      onMaintenanceError: (error) => {
        errors.push(error);
      },
    }).outbox;
    await advanceTimersByTime(10);
    await flushMicrotasks(8);
    // The pass is parked inside its scan; disposal lands before it resumes.
    automatic.dispose();
    gate.resolve();
    await flushMicrotasks(64);
    const observer = createOutboxFixture({ storage, clock }).outbox;
    expect(await fieldOf(observer.receipt(deliveryId), 'state')).toBe('claimed');
    expect(errors).toHaveLength(0);
    observer.dispose();
  });
});

describe('runner: second review round', () => {
  afterEach(() => {
    restoreRealTimers();
  });

  it('aborts the adapter once renewal cannot be confirmed before the last known expiry', async () => {
    useFakeTimers();
    let failing = false;
    let reads = 0;
    class DownStorage extends MemoryStorage {
      override async get(key: string): Promise<Uint8Array | null> {
        if (failing) {
          reads += 1;
          throw new Error('storage down');
        }
        return super.get(key);
      }
    }
    const { outbox, adapter, clock } = createOutboxFixture({
      storage: new DownStorage(),
      visibilityTimeoutMs: 100,
      attemptTimeoutMs: 10_000,
    });
    await enqueueOne(outbox);
    adapter.block();
    const pending = outbox.deliverNext();
    await untilRequested(adapter);
    failing = true;
    // Retries halve the remaining window each time and stop at expiry.
    for (let step = 0; step < 12; step += 1) {
      clock.advance(10);
      await advanceTimersByTime(10);
      await flushMicrotasks(16);
    }
    expect(adapter.requests[0]!.signal.aborted).toBe(true);
    expect(adapter.requests[0]!.signal.reason).toMatchObject({
      message: 'The attempt lease expired before its renewal could be confirmed.',
    });
    expect(reads).toBeLessThan(12);
    // The settlement that follows the abort meets the same outage and surfaces
    // it to the caller; the lease stays `attempting` for maintenance.
    await expect(pending).rejects.toThrow('storage down');
    failing = false;
    outbox.dispose();
  });

  it('aborts the adapter when a renewal reports cancellation requested elsewhere', async () => {
    useFakeTimers();
    const storage = new MemoryStorage();
    const clock = createOutboxClock();
    const { outbox, adapter } = createOutboxFixture({
      storage,
      clock,
      visibilityTimeoutMs: 100,
      attemptTimeoutMs: 10_000,
    });
    const deliveryId = await enqueueOne(outbox);
    const release = adapter.block();
    const pending = outbox.deliverNext();
    await untilRequested(adapter);
    const remote = createOutboxFixture({ storage: remoteView(storage), clock }).outbox;
    expect(await statusOf(remote.requestCancellation({ deliveryId }))).toBe('requested');
    expect(adapter.requests[0]!.signal.aborted).toBe(false);
    clock.advance(50);
    await advanceTimersByTime(50);
    await flushMicrotasks(32);
    expect(adapter.requests[0]!.signal.aborted).toBe(true);
    release({ status: 'retryable' });
    const result = await pending;
    expect(result.status === 'settled' && result.receipt.state).toBe('unknown-outcome');
    remote.dispose();
    outbox.dispose();
  });

  it('leaves the attempting lease alone when the outbox is disposed mid-send', async () => {
    const storage = new MemoryStorage();
    const clock = createOutboxClock();
    const { outbox, adapter } = createOutboxFixture({ storage, clock, attemptTimeoutMs: 100 });
    const deliveryId = await enqueueOne(outbox);
    adapter.block();
    const pending = outbox.deliverNext();
    await untilRequested(adapter);
    outbox.dispose();
    const result = await pending;
    expect(result).toMatchObject({ status: 'settled', committed: false });
    expect(result.status === 'settled' && result.receipt.state).toBe('attempting');
    const observer = createOutboxFixture({ storage, clock }).outbox;
    expect(await fieldOf(observer.receipt(deliveryId), 'state')).toBe('attempting');
    clock.advance(100);
    expect(await observer.runMaintenance()).toMatchObject({ parked: 1 });
    observer.dispose();
  });

  it('turns an adapter failure that cannot be stringified into a bounded unknown outcome', async () => {
    const { outbox, adapter } = createOutboxFixture();
    adapter.fail({
      toString() {
        throw new Error('no string for you');
      },
    });
    const deliveryId = await enqueueOne(outbox);
    expect(await deliverOne(outbox)).toBe('unknown-outcome');
    const failure = await fieldOf(outbox.receipt(deliveryId), 'failure');
    expect(failure?.message).toContain('could not be converted to a string');
    outbox.dispose();
  });

  it('counts a cancellation it committed itself when the outcome arrived before the abort', async () => {
    const storage = new MemoryStorage();
    const clock = createOutboxClock();
    const remote = createOutboxFixture({ storage: remoteView(storage), clock }).outbox;
    const { outbox } = createOutboxFixture({
      storage,
      clock,
      adapter: {
        async send(request) {
          // The cancellation lands in another process while the send is in
          // flight; this process learns of it only when it settles.
          await remote.requestCancellation({ deliveryId: request.delivery.deliveryId });
          return { status: 'rejected', message: 'refused' };
        },
      },
    });
    await enqueueOne(outbox);
    expect(await outbox.drain({ timeoutMs: 0 })).toMatchObject({ cancelled: 1, pending: 0 });
    remote.dispose();
    outbox.dispose();
  });

  it('reports committed only for dispositions this runner wrote', async () => {
    const { outbox } = createOutboxFixture();
    await enqueueOne(outbox);
    const result = await outbox.deliverNext();
    expect(result).toMatchObject({ status: 'settled', committed: true });
    outbox.dispose();
  });
});

describe('runner: third review round', () => {
  afterEach(() => {
    restoreRealTimers();
  });

  it('aborts the adapter when a renewal hangs past the confirmed lease window', async () => {
    useFakeTimers();
    let hanging = false;
    class HangingStorage extends MemoryStorage {
      override async get(key: string): Promise<Uint8Array | null> {
        if (hanging) return new Promise(() => undefined);
        return super.get(key);
      }
    }
    const { outbox, adapter, clock } = createOutboxFixture({
      storage: new HangingStorage(),
      visibilityTimeoutMs: 100,
      attemptTimeoutMs: 10_000,
    });
    await enqueueOne(outbox);
    adapter.block();
    const pending = outbox.deliverNext();
    await untilRequested(adapter);
    hanging = true;
    // The first renewal fires at half the window and never returns; the race
    // that bounds it ends at the confirmed expiry.
    clock.advance(50);
    await advanceTimersByTime(50);
    await flushMicrotasks(16);
    expect(adapter.requests[0]!.signal.aborted).toBe(false);
    clock.advance(50);
    await advanceTimersByTime(50);
    await flushMicrotasks(16);
    expect(adapter.requests[0]!.signal.aborted).toBe(true);
    expect(adapter.requests[0]!.signal.reason).toMatchObject({
      message: 'The attempt lease expired before its renewal could be confirmed.',
    });
    hanging = false;
    void pending;
    outbox.dispose();
  });

  it('starts renewal from the visibility the begin commit granted', async () => {
    const storage = new HookedStorage();
    const { outbox, adapter, clock } = createOutboxFixture({
      storage,
      visibilityTimeoutMs: 100,
      attemptTimeoutMs: 10_000,
    });
    await enqueueOne(outbox);
    let recordReads = 0;
    storage.beforeGet = (key) => {
      // The claim reads the record once; the begin's own read is the second,
      // and it lands after the claim's original visibility window.
      if (key.startsWith('appdlv:') && (recordReads += 1) === 2) clock.advance(150);
    };
    expect(await deliverOne(outbox)).toBe('acknowledged');
    expect(adapter.requests).toHaveLength(1);
    outbox.dispose();
  });

  it('polls at the poll interval while every open delivery is leased elsewhere', async () => {
    useFakeTimers();
    const storage = new MemoryStorage();
    const clock = createOutboxClock();
    const holder = createOutboxFixture({ storage, clock }).outbox;
    await enqueueOne(holder);
    await claimOne(holder);
    const { outbox, adapter } = createOutboxFixture({ storage, clock });
    const draining = outbox.drain({ timeoutMs: 100, pollIntervalMs: 40 });
    await flushMicrotasks(32);
    for (let step = 0; step < 3; step += 1) {
      clock.advance(40);
      await advanceTimersByTime(40);
      await flushMicrotasks(32);
    }
    const report = await draining;
    expect(report).toMatchObject({ pending: 1, drained: false });
    expect(adapter.requests).toHaveLength(0);
    holder.dispose();
    outbox.dispose();
  });

  it('finishes a drain cut short by disposal without reading storage again', async () => {
    let released = false;
    class ReleasedStorage extends MemoryStorage {
      override async get(key: string): Promise<Uint8Array | null> {
        if (released) throw new Error('storage released');
        return super.get(key);
      }
    }
    const { outbox, adapter } = createOutboxFixture({ storage: new ReleasedStorage() });
    await enqueueOne(outbox);
    adapter.block();
    const draining = outbox.drain({ timeoutMs: 100_000 });
    await untilRequested(adapter);
    outbox.dispose();
    released = true;
    const report = await draining;
    expect(report).toMatchObject({ pending: 1, drained: false, acknowledged: 0 });
  });
});

describe('runner: fourth review round', () => {
  it('ends a drain disposed during its maintenance pass without claiming', async () => {
    const gate = createDeferred();
    let scans = 0;
    class GatedStorage extends MemoryStorage {
      override async *scan(
        ...arguments_: Parameters<MemoryStorage['scan']>
      ): ReturnType<MemoryStorage['scan']> {
        scans += 1;
        // The drain's first maintenance pass scans the delivery keyspace; hold
        // it open until the test has disposed the outbox.
        if (scans === 1) await gate.promise;
        yield* super.scan(...arguments_);
      }
    }
    const { outbox, adapter } = createOutboxFixture({ storage: new GatedStorage() });
    await enqueueOne(outbox);
    const draining = outbox.drain({ timeoutMs: 0 });
    await flushMicrotasks(16);
    outbox.dispose();
    gate.resolve();
    const report = await draining;
    expect(report).toMatchObject({ pending: 1, drained: false, acknowledged: 0 });
    expect(adapter.requests).toHaveLength(0);
  });

  it('turns an Error whose message getter throws into a bounded unknown outcome', async () => {
    class HostileError extends Error {
      override get message(): string {
        throw new Error('no message for you');
      }
    }
    const { outbox, adapter } = createOutboxFixture();
    adapter.fail(new HostileError());
    const deliveryId = await enqueueOne(outbox);
    expect(await deliverOne(outbox)).toBe('unknown-outcome');
    const failure = await fieldOf(outbox.receipt(deliveryId), 'failure');
    expect(failure?.message).toContain('could not be converted to a string');
    outbox.dispose();
  });
});

describe('runner: fifth review round', () => {
  afterEach(() => {
    restoreRealTimers();
  });

  it('honours the drain budget while deliveries keep settling', async () => {
    useFakeTimers();
    const clock = createOutboxClock();
    const { outbox } = createOutboxFixture({
      clock,
      adapter: {
        async send() {
          clock.advance(60);
          return { status: 'acknowledged' };
        },
      },
    });
    for (let index = 0; index < 5; index += 1) await enqueueOne(outbox);
    const report = await outbox.drain({ timeoutMs: 100 });
    expect(report).toMatchObject({ acknowledged: 2, pending: 3, drained: false });
    outbox.dispose();
  });

  it('aborts an in-flight send when the drain budget elapses', async () => {
    useFakeTimers();
    const { outbox, adapter } = createOutboxFixture();
    const id = await enqueueOne(outbox);
    adapter.block();
    const draining = outbox.drain({ timeoutMs: 100 });
    await untilRequested(adapter);
    await advanceTimersByTime(100);
    const report = await draining;
    expect(adapter.requests[0]!.signal.aborted).toBe(true);
    // The drain stopped at its deadline without waiting for the settlement,
    // which finishes on its own and is not this drain's to count.
    expect(report).toMatchObject({ unknown: 0, pending: 1, drained: false });
    await flushMicrotasks(64);
    expect(await fieldOf(outbox.receipt(id), 'state')).toBe('unknown-outcome');
    outbox.dispose();
  });

  it('caps a held sleep by the poll interval so newly due work is seen', async () => {
    useFakeTimers();
    const storage = new MemoryStorage();
    const clock = createOutboxClock();
    const { outbox, adapter } = createOutboxFixture({ storage, clock });
    await enqueueOne(outbox, { availableAfterMs: 10_000 });
    const controller = new AbortController();
    const draining = outbox.drain({
      timeoutMs: 1000,
      pollIntervalMs: 50,
      signal: controller.signal,
    });
    await flushMicrotasks(32);
    const producer = createOutboxFixture({ storage: remoteView(storage), clock }).outbox;
    await enqueueOne(producer);
    // One poll interval later the drain looks again and finds the new delivery
    // due, well before the held one's own instant.
    clock.advance(50);
    await advanceTimersByTime(50);
    await adapter.nextRequest();
    await flushMicrotasks(64);
    controller.abort();
    const report = await draining;
    expect(report).toMatchObject({ acknowledged: 1, pending: 1, drained: false });
    producer.dispose();
    outbox.dispose();
  });

  it('never writes a renewal that resumes after disposal', async () => {
    useFakeTimers();
    const storage = new HookedStorage();
    const clock = createOutboxClock();
    const { outbox, adapter } = createOutboxFixture({
      storage,
      clock,
      visibilityTimeoutMs: 100,
      attemptTimeoutMs: 10_000,
    });
    const deliveryId = await enqueueOne(outbox);
    adapter.block();
    const pending = outbox.deliverNext();
    await untilRequested(adapter);
    const observer = createOutboxFixture({ storage, clock }).outbox;
    const before = await fieldOf(observer.receipt(deliveryId), 'visibilityExpiresAt');
    let reads = 0;
    storage.beforeGet = (key) => {
      // The renewal's own read of the record is where disposal lands.
      if (key.startsWith('appdlv:') && (reads += 1) === 1) outbox.dispose();
    };
    clock.advance(50);
    await advanceTimersByTime(50);
    await flushMicrotasks(32);
    void pending;
    expect(await fieldOf(observer.receipt(deliveryId), 'visibilityExpiresAt')).toBe(before);
    observer.dispose();
  });

  it('leaves a claim that committed after disposal in the provably unsent state', async () => {
    const storage = new HookedStorage();
    const clock = createOutboxClock();
    const { outbox, adapter } = createOutboxFixture({ storage, clock, attemptTimeoutMs: 100 });
    const deliveryId = await enqueueOne(outbox);
    storage.beforeBatch = (ordinal) => {
      if (ordinal === 2) outbox.dispose();
    };
    const result = await outbox.deliverNext();
    expect(result).toMatchObject({ status: 'settled', committed: false });
    expect(result.status === 'settled' && result.receipt.state).toBe('claimed');
    expect(adapter.requests).toHaveLength(0);
    const observer = createOutboxFixture({ storage, clock }).outbox;
    clock.advance(100);
    expect(await observer.runMaintenance()).toMatchObject({ rescheduled: 1, parked: 0 });
    expect(await fieldOf(observer.receipt(deliveryId), 'state')).toBe('retry-scheduled');
    observer.dispose();
  });

  it('keeps the cached pending count current with the work it committed', async () => {
    let released = false;
    class ReleasedStorage extends MemoryStorage {
      override async get(key: string): Promise<Uint8Array | null> {
        if (released) throw new Error('storage released');
        return super.get(key);
      }
    }
    const { outbox, adapter } = createOutboxFixture({ storage: new ReleasedStorage() });
    await enqueueOne(outbox);
    await enqueueOne(outbox);
    adapter.reply({ status: 'acknowledged' });
    adapter.block();
    const draining = outbox.drain({ timeoutMs: 100_000 });
    await untilRequested(adapter);
    await adapter.nextRequest(1);
    outbox.dispose();
    released = true;
    expect(await draining).toMatchObject({ acknowledged: 1, pending: 1, drained: false });
  });

  it('runs maintenance once up front and on idle rounds, not before every send', async () => {
    let recordScans = 0;
    class CountingStorage extends MemoryStorage {
      override async *scan(
        ...arguments_: Parameters<MemoryStorage['scan']>
      ): ReturnType<MemoryStorage['scan']> {
        if (arguments_[0].startsWith('appdlv:')) recordScans += 1;
        yield* super.scan(...arguments_);
      }
    }
    const { outbox } = createOutboxFixture({ storage: new CountingStorage() });
    for (let index = 0; index < 6; index += 1) await enqueueOne(outbox);
    const report = await outbox.drain({ timeoutMs: 0 });
    expect(report).toMatchObject({ acknowledged: 6, drained: true });
    expect(recordScans).toBeLessThanOrEqual(2);
    outbox.dispose();
  });

  it('stops a maintenance pass when the drain caller aborts mid-scan', async () => {
    const gate = createDeferred();
    let scans = 0;
    class GatedStorage extends MemoryStorage {
      override async *scan(
        ...arguments_: Parameters<MemoryStorage['scan']>
      ): ReturnType<MemoryStorage['scan']> {
        scans += 1;
        if (scans === 1) await gate.promise;
        yield* super.scan(...arguments_);
      }
    }
    const { outbox, adapter } = createOutboxFixture({ storage: new GatedStorage() });
    await enqueueOne(outbox);
    const controller = new AbortController();
    const draining = outbox.drain({ timeoutMs: 0, signal: controller.signal });
    await flushMicrotasks(16);
    controller.abort();
    gate.resolve();
    const report = await draining;
    expect(report).toMatchObject({ pending: 1, drained: false });
    expect(adapter.requests).toHaveLength(0);
    outbox.dispose();
  });

  it('turns an Error whose message is not a string into a bounded unknown outcome', async () => {
    class OddError extends Error {
      override get message(): string {
        return Symbol('odd') as unknown as string;
      }
    }
    const { outbox, adapter } = createOutboxFixture();
    adapter.fail(new OddError());
    const deliveryId = await enqueueOne(outbox);
    expect(await deliverOne(outbox)).toBe('unknown-outcome');
    const failure = await fieldOf(outbox.receipt(deliveryId), 'failure');
    expect(failure?.message).toContain('Symbol(odd)');
    outbox.dispose();
  });
});

describe('runner: sixth review round', () => {
  afterEach(() => {
    restoreRealTimers();
  });

  it('aborts the adapter the moment the attempt deadline wins, before settling', async () => {
    useFakeTimers();
    const { outbox, adapter } = createOutboxFixture({
      attemptTimeoutMs: 20,
      visibilityTimeoutMs: 30_000,
    });
    await enqueueOne(outbox);
    adapter.block();
    const pending = outbox.deliverNext();
    await untilRequested(adapter);
    await advanceTimersByTime(20);
    await flushMicrotasks(32);
    // The abort carries the deadline path's own reason; the release that
    // follows settlement uses a different one, so this proves which came first.
    expect(adapter.requests[0]!.signal.aborted).toBe(true);
    expect(adapter.requests[0]!.signal.reason).toMatchObject({
      message: 'The attempt deadline passed while the transport call was in flight.',
    });
    const result = await pending;
    expect(result.status === 'settled' && result.receipt.state).toBe('unknown-outcome');
    outbox.dispose();
  });

  it('ends a drain whose caller aborts while a claim is committing', async () => {
    const storage = new HookedStorage();
    const { outbox, adapter } = createOutboxFixture({ storage });
    await enqueueOne(outbox);
    const controller = new AbortController();
    // Abort on the claim's first delivery-record read, so the stop lands
    // while the head is being resolved and the claim throws the stop reason.
    storage.beforeGet = (key) => {
      if (key.includes('appdlv:')) controller.abort(new Error('gone'));
    };
    const report = await outbox.drain({ timeoutMs: 0, signal: controller.signal });
    expect(report).toMatchObject({ acknowledged: 0, drained: false });
    expect(adapter.requests).toHaveLength(0);
    outbox.dispose();
  });

  it('propagates a storage failure from a claim instead of ending the drain quietly', async () => {
    const storage = new HookedStorage();
    const { outbox, adapter } = createOutboxFixture({ storage });
    await enqueueOne(outbox);
    storage.beforeGet = (key) => {
      if (key.includes('appdlv:')) throw new Error('storage offline');
    };
    await expect(outbox.drain({ timeoutMs: 0 })).rejects.toThrow('storage offline');
    expect(adapter.requests).toHaveLength(0);
    outbox.dispose();
  });

  it('reports pending as null when its first header read never answers within the budget', async () => {
    useFakeTimers();
    const storage = new MemoryStorage();
    const { outbox } = createOutboxFixture({ storage });
    await enqueueOne(outbox);
    const stalled = createOutboxFixture({
      storage: new Proxy(storage, {
        get(target, property, receiver) {
          if (property === 'get') return () => new Promise(() => undefined);
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    }).outbox;
    const draining = stalled.drain({ timeoutMs: 50 });
    await flushMicrotasks(16);
    await advanceTimersByTime(50);
    expect(await draining).toMatchObject({ pending: null, drained: false });
    stalled.dispose();
    outbox.dispose();
  });

  it('refuses a drain without an adapter before maintenance writes anything', async () => {
    const storage = new MemoryStorage();
    const clock = createOutboxClock();
    const worker = createOutboxFixture({ storage, clock, attemptTimeoutMs: 100 }).outbox;
    const deliveryId = await enqueueOne(worker);
    await claimOne(worker);
    worker.dispose();
    clock.advance(100);
    const { outbox } = createOutboxFixture({ storage, clock, adapter: undefined });
    await expect(outbox.drain({ timeoutMs: 0 })).rejects.toThrow(/require an adapter/);
    expect(await fieldOf(outbox.receipt(deliveryId), 'state')).toBe('claimed');
    outbox.dispose();
  });
});

describe('same-attempt refusals keep the lease', () => {
  it('treats a repeated begin as idempotent without aborting the live attempt', async () => {
    const { outbox } = createOutboxFixture();
    await enqueueOne(outbox);
    const claim = await beginOne(outbox);
    const again = await outbox.beginAttempt(claim);
    expect(again.status === 'settled' && again.receipt.state).toBe('attempting');
    expect(claim.signal.aborted).toBe(false);
    const settled = await outbox.settle({ ...claim, outcome: { status: 'acknowledged' } });
    expect(settled.status).toBe('settled');
    outbox.dispose();
  });

  it('refuses a settle before the send began without aborting the live attempt', async () => {
    const { outbox } = createOutboxFixture();
    await enqueueOne(outbox);
    const claim = await claimOne(outbox);
    const early = await outbox.settle({ ...claim, outcome: { status: 'acknowledged' } });
    expect(early.status === 'stale' && early.receipt.state).toBe('claimed');
    expect(claim.signal.aborted).toBe(false);
    expect(await statusOf(outbox.beginAttempt(claim))).toBe('settled');
    outbox.dispose();
  });
});

/**
 * Resolve once an idle drain has read the outbox header for the second time —
 * the read that precedes its first sleep — and the sleep has had the turns it
 * needs to arm, so a fake-timer advance that follows fires it.
 */
async function untilSleeping(storage: HookedStorage): Promise<void> {
  let headerReads = 0;
  await new Promise<void>((resolve) => {
    storage.beforeGet = (key) => {
      if (!key.includes('appobx:')) return;
      headerReads += 1;
      if (headerReads === 2) resolve();
    };
  });
  storage.beforeGet = null;
  await flushMicrotasks(32);
}

/** Hold the first delivery-record read that follows the adapter's call until `gate` resolves. */
function holdSettlementRead(
  storage: HookedStorage,
  adapter: ScriptedAdapter,
  gate: { readonly promise: Promise<void> },
): void {
  let held = false;
  storage.beforeGet = async (key) => {
    if (held || !key.includes('appdlv:') || adapter.requests.length === 0) return;
    held = true;
    await gate.promise;
  };
}

describe('runner: seventh review round', () => {
  afterEach(() => {
    restoreRealTimers();
  });

  it('keeps renewing the lease while the settlement is still being written', async () => {
    useFakeTimers();
    const storage = new HookedStorage();
    const { outbox, adapter, clock } = createOutboxFixture({
      storage,
      visibilityTimeoutMs: 100,
      attemptTimeoutMs: 10_000,
    });
    const id = await enqueueOne(outbox);
    const gate = createDeferred();
    holdSettlementRead(storage, adapter, gate);
    const pending = outbox.deliverNext();
    await untilRequested(adapter);
    await flushMicrotasks(32);
    const before = await fieldOf(outbox.receipt(id), 'visibilityExpiresAt');
    // Half the window later the renewal fires although the send is over, so
    // the still-attempting record is not recoverable underneath the write.
    clock.advance(50);
    await advanceTimersByTime(50);
    await flushMicrotasks(32);
    expect(await fieldOf(outbox.receipt(id), 'visibilityExpiresAt')).toBe(before! + 50);
    gate.resolve();
    const result = await pending;
    expect(result).toMatchObject({ status: 'settled', committed: true });
    expect(await fieldOf(outbox.receipt(id), 'state')).toBe('acknowledged');
    outbox.dispose();
  });

  it('stops waiting for a stalled settlement at the drain deadline and lets it finish', async () => {
    useFakeTimers();
    const storage = new HookedStorage();
    const { outbox, adapter } = createOutboxFixture({ storage });
    const id = await enqueueOne(outbox);
    const gate = createDeferred();
    holdSettlementRead(storage, adapter, gate);
    const draining = outbox.drain({ timeoutMs: 100 });
    await untilRequested(adapter);
    await flushMicrotasks(32);
    await advanceTimersByTime(100);
    const report = await draining;
    expect(report).toMatchObject({ acknowledged: 0, pending: 1, drained: false });
    gate.resolve();
    await flushMicrotasks(64);
    expect(await fieldOf(outbox.receipt(id), 'state')).toBe('acknowledged');
    outbox.dispose();
  });

  it('never writes a settlement that resumes after disposal', async () => {
    useFakeTimers();
    const storage = new HookedStorage();
    const { outbox, adapter } = createOutboxFixture({ storage });
    const id = await enqueueOne(outbox);
    const gate = createDeferred();
    holdSettlementRead(storage, adapter, gate);
    const draining = outbox.drain({ timeoutMs: 100 });
    await untilRequested(adapter);
    await flushMicrotasks(32);
    await advanceTimersByTime(100);
    await draining;
    outbox.dispose();
    gate.resolve();
    await flushMicrotasks(64);
    const observer = createOutboxFixture({ storage: remoteView(storage) }).outbox;
    expect(await fieldOf(observer.receipt(id), 'state')).toBe('attempting');
    observer.dispose();
  });

  it('leaves the record for maintenance when a detached settlement fails', async () => {
    useFakeTimers();
    const storage = new HookedStorage();
    const { outbox, adapter } = createOutboxFixture({ storage });
    const id = await enqueueOne(outbox);
    const gate = createDeferred();
    holdSettlementRead(storage, adapter, gate);
    const draining = outbox.drain({ timeoutMs: 100 });
    await untilRequested(adapter);
    await flushMicrotasks(32);
    await advanceTimersByTime(100);
    expect(await draining).toMatchObject({ acknowledged: 0, pending: 1 });
    // The stalled read fails after the drain returned: nobody waits on the
    // settlement any more, and the failure must not surface as unhandled.
    gate.reject(new Error('storage offline'));
    await flushMicrotasks(64);
    expect(await fieldOf(outbox.receipt(id), 'state')).toBe('attempting');
    outbox.dispose();
  });

  it('lowers the cached pending count by what an idle-round maintenance pass closed', async () => {
    useFakeTimers();
    const storage = new HookedStorage();
    const clock = createOutboxClock();
    const { outbox } = createOutboxFixture({
      storage,
      clock,
      visibilityTimeoutMs: 100,
      attemptTimeoutMs: 100,
    });
    await enqueueOne(outbox);
    await beginOne(outbox);
    // The fourth commit is the idle-round recovery of the lapsed attempt;
    // disposing there means the drain must report from its cache.
    storage.beforeBatch = (ordinal) => {
      if (ordinal === 4) outbox.dispose();
    };
    // The first idle round ends in a sleep. The hooked storage adds turns to
    // every read, so the sleep may arm after the first advance; the second
    // fires it either way, and the round that follows finds the lapsed lease.
    const sleeping = untilSleeping(storage);
    const draining = outbox.drain({ timeoutMs: 1000, pollIntervalMs: 50 });
    await sleeping;
    clock.advance(150);
    await advanceTimersByTime(50);
    await flushMicrotasks(64);
    await advanceTimersByTime(50);
    await flushMicrotasks(64);
    expect(await draining).toMatchObject({ unknown: 1, pending: 0, drained: false });
  });

  it('refuses a repeated begin once cancellation was requested elsewhere', async () => {
    const storage = new MemoryStorage();
    const { outbox } = createOutboxFixture({ storage });
    const id = await enqueueOne(outbox);
    const claim = await beginOne(outbox);
    const other = createOutboxFixture({ storage: remoteView(storage) }).outbox;
    await other.requestCancellation({ deliveryId: id });
    const again = await outbox.beginAttempt(claim);
    expect(again.status).toBe('stale');
    expect(again.status === 'stale' && again.receipt.state).toBe('cancellation-requested');
    other.dispose();
    outbox.dispose();
  });
});
