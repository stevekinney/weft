/**
 * Hardening for the durable application delivery outbox (WFT-85): the
 * failure and race branches the happy-path suites do not reach — commit
 * failures during a claim, an exhausted sequence allocator, a corrupt
 * idempotency binding, deliveries that move between a maintenance scan and
 * its recovery, malformed retention keys, the page cap, contention on every
 * operation, and the runner's refused-begin and retired-mid-flight paths.
 */

import { describe, expect, it } from 'bun:test';

import type { BatchOperation, ConditionalBatchCondition } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { ApplicationDeliveryValidationError } from './application-outbox-guards.ts';
import { encodeApplicationOutboxRecord } from './application-outbox-index-codec.ts';
import { ApplicationOutboxContentionError } from './application-outbox-internals.ts';
import { isApplicationDeliveryAttempting } from './application-outbox-types.ts';
import { validateOutcome } from './application-outbox-validation.ts';
import {
  beginOne,
  claimOne,
  createOutboxClock,
  createOutboxFixture,
  deliverOne,
  deliveryInput,
  enqueueOne,
  fieldOf,
  statusOf,
} from './application-outbox.test-support.ts';
import { decode, encode } from './codec.ts';
import { PersistedDataCorruptError } from './persisted-data-incompatible-error.ts';

/** A storage whose compare-and-swap can be scripted per call. */
class ScriptedStorage extends MemoryStorage {
  /** Called before every conditional batch with its ordinal; may mutate state or throw. */
  beforeBatch: ((ordinal: number) => Promise<void> | void) | null = null;
  /** When set, every conditional batch loses. */
  losing = false;
  #ordinal = 0;

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    this.#ordinal += 1;
    await this.beforeBatch?.(this.#ordinal);
    if (this.losing) return false;
    return super.conditionalBatch(conditions, operations);
  }
}

const NAMESPACE = 'bureau';
const OWNER = 'agent-7';

describe('claim commit failures', () => {
  it('releases the registration and rethrows when the claim commit throws', async () => {
    const storage = new ScriptedStorage();
    const { outbox } = createOutboxFixture({ storage });
    await enqueueOne(outbox);
    storage.beforeBatch = (ordinal) => {
      if (ordinal === 2) throw new Error('storage down');
    };
    await expect(outbox.claim()).rejects.toThrow('storage down');
    storage.beforeBatch = null;
    // The delivery is still claimable and the registry holds no leaked attempt.
    const claim = await claimOne(outbox);
    expect(claim.signal.aborted).toBe(false);
    outbox.dispose();
  });

  it('hands back an already-aborted signal when the request aborts mid-commit', async () => {
    const storage = new ScriptedStorage();
    const { outbox } = createOutboxFixture({ storage });
    await enqueueOne(outbox);
    const controller = new AbortController();
    storage.beforeBatch = (ordinal) => {
      if (ordinal === 2) controller.abort(new Error('caller left'));
    };
    const result = await outbox.claim({ signal: controller.signal });
    expect(result.status).toBe('claimed');
    expect(result.status === 'claimed' && result.claim.signal.aborted).toBe(true);
    outbox.dispose();
  });

  it('looks past a whole look-ahead of orphaned due entries', async () => {
    const { outbox, storage } = createOutboxFixture();
    const real = await enqueueOne(outbox, { availableAfterMs: 5 });
    for (let index = 0; index < 9; index += 1) {
      await storage.put(
        KEYS.applicationDeliveryDue(NAMESPACE, OWNER, index, `ghost-${index}`),
        encode(`ghost-${index}`),
      );
    }
    expect(await outbox.claim()).toMatchObject({ status: 'held' });
    outbox.dispose();
    void real;
  });
});

describe('enqueue edge cases', () => {
  it('admits idempotency keys only up to the ceiling the record decoder accepts', async () => {
    const { outbox } = createOutboxFixture();
    for (const field of ['idempotencyKey', 'externalIdempotencyKey'] as const) {
      await expect(outbox.enqueue(deliveryInput({ [field]: 'k'.repeat(257) }))).rejects.toThrow(
        ApplicationDeliveryValidationError,
      );
      const admitted = await outbox.enqueue(
        deliveryInput({ [field]: `${field}-`.padEnd(256, 'k'), kind: field }),
      );
      expect(admitted.status).toBe('enqueued');
      if (admitted.status !== 'enqueued') return;
      // Every later read decodes what admission accepted.
      expect(await fieldOf(outbox.receipt(admitted.receipt.deliveryId), 'state')).toBe('queued');
    }
    expect(await outbox.list()).toHaveLength(2);
    outbox.dispose();
  });

  it('refuses to enqueue once the sequence allocator is exhausted', async () => {
    const { outbox, storage } = createOutboxFixture();
    await storage.put(
      KEYS.applicationOutbox(NAMESPACE, OWNER),
      encodeApplicationOutboxRecord({
        recordVersion: 1,
        namespace: NAMESPACE,
        ownerId: OWNER,
        nextSequence: Number.MAX_SAFE_INTEGER,
        openCount: 0,
        enqueuedCount: 0,
      }),
    );
    await expect(outbox.enqueue(deliveryInput())).rejects.toThrow(/sequence allocator/);
    outbox.dispose();
  });

  it('fails closed on an idempotency binding that names an unrelated delivery', async () => {
    const { outbox, storage } = createOutboxFixture();
    const other = await enqueueOne(outbox, { idempotencyKey: 'other' });
    const bindingKey = KEYS.applicationDeliveryIdempotency(NAMESPACE, OWNER, 'forged');
    await storage.put(
      bindingKey,
      encode({ recordVersion: 1, deliveryId: other, identityDigest: 'x'.repeat(64) }),
    );
    await expect(outbox.enqueue(deliveryInput({ idempotencyKey: 'forged' }))).rejects.toThrow(
      PersistedDataCorruptError,
    );
    outbox.dispose();
  });

  it('fails closed on undecodable index bytes', async () => {
    const { outbox, storage } = createOutboxFixture();
    const garbage = encode({ nested: { deep: true } }).slice(0, 3);
    await storage.put(KEYS.applicationOutbox(NAMESPACE, OWNER), garbage);
    await expect(outbox.capacity()).rejects.toThrow(PersistedDataCorruptError);
    await storage.delete(KEYS.applicationOutbox(NAMESPACE, OWNER));
    await storage.put(KEYS.applicationDeliveryIdempotency(NAMESPACE, OWNER, 'k'), garbage);
    await expect(outbox.enqueue(deliveryInput({ idempotencyKey: 'k' }))).rejects.toThrow(
      PersistedDataCorruptError,
    );
    await storage.put(KEYS.applicationDeliveryDue(NAMESPACE, OWNER, 0, 'x'), garbage);
    await expect(outbox.claim()).rejects.toThrow(PersistedDataCorruptError);
    outbox.dispose();
  });
});

describe('maintenance races and bounds', () => {
  it('skips a lapsed delivery that another actor settled or retired between scan and recovery', async () => {
    const storage = new ScriptedStorage();
    const clock = createOutboxClock();
    const { outbox } = createOutboxFixture({ storage, clock, attemptTimeoutMs: 10 });
    const settledLate = await enqueueOne(outbox);
    const retiredLate = await enqueueOne(outbox);
    const first = await beginOne(outbox);
    const second = await claimOne(outbox);
    clock.advance(10);
    // Both leases have lapsed. Before recovery commits either, one delivery is
    // settled by its (late but still fenced-at-the-time) attempt in another
    // handle, and the other vanishes.
    const sibling = createOutboxFixture({ storage, clock }).outbox;
    let armed = true;
    storage.beforeBatch = async () => {
      if (!armed) return;
      armed = false;
      storage.beforeBatch = null;
      await storage.delete(KEYS.applicationDelivery(NAMESPACE, OWNER, retiredLate));
      await storage.put(
        KEYS.applicationDelivery(NAMESPACE, OWNER, settledLate),
        encode({
          ...(decode(
            (await storage.get(KEYS.applicationDelivery(NAMESPACE, OWNER, settledLate)))!,
          ) as object),
          state: 'queued',
          attempt: 0,
          attemptToken: undefined,
          claimedAt: undefined,
          attemptDeadlineAt: undefined,
          visibilityExpiresAt: undefined,
          lastActivityAt: undefined,
          attemptStartedAt: undefined,
        }),
      );
    };
    const report = await outbox.runMaintenance();
    expect(report).toMatchObject({ rescheduled: 0, parked: 0, deadLettered: 0 });
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    sibling.dispose();
    outbox.dispose();
    void second;
  });

  it('surfaces contention from recovery and keeps its cursor', async () => {
    const storage = new ScriptedStorage();
    const clock = createOutboxClock();
    const { outbox } = createOutboxFixture({ storage, clock, attemptTimeoutMs: 10 });
    await enqueueOne(outbox);
    await claimOne(outbox);
    clock.advance(10);
    storage.losing = true;
    await expect(outbox.runMaintenance()).rejects.toThrow(ApplicationOutboxContentionError);
    storage.losing = false;
    expect(await outbox.runMaintenance()).toMatchObject({ rescheduled: 1 });
    outbox.dispose();
  });

  it('surfaces contention from an operator transition', async () => {
    const storage = new ScriptedStorage();
    const { outbox, adapter } = createOutboxFixture({ storage });
    adapter.reply({ status: 'unknown' });
    const deliveryId = await enqueueOne(outbox);
    await deliverOne(outbox);
    storage.losing = true;
    await expect(outbox.retry({ deliveryId })).rejects.toThrow(ApplicationOutboxContentionError);
    await expect(outbox.deadLetter({ deliveryId })).rejects.toThrow(
      ApplicationOutboxContentionError,
    );
    outbox.dispose();
  });

  it('discards retention entries with a non-canonical instant or an undecodable id', async () => {
    const { outbox, clock, storage } = createOutboxFixture({ terminalRetentionMs: 1 });
    const prefix = KEYS.applicationDeliveryTerminalPrefix(NAMESPACE, OWNER);
    const overPadded = `${prefix}00000000000000001:x`;
    const badEncoding = `${prefix}0000000000000001:%E0%A4%A`;
    await storage.put(overPadded, encode('x'));
    await storage.put(badEncoding, encode('x'));
    clock.advance(10);
    expect(await outbox.runMaintenance()).toMatchObject({ retired: 0 });
    expect(await storage.get(overPadded)).toBeNull();
    expect(await storage.get(badEncoding)).toBeNull();
    outbox.dispose();
  });

  it('retires an entry whose record is already gone, fenced on the entry bytes', async () => {
    const { outbox, clock, storage } = createOutboxFixture({ terminalRetentionMs: 1 });
    const key = KEYS.applicationDeliveryTerminal(NAMESPACE, OWNER, 1, 'gone');
    await storage.put(key, encode('gone'));
    clock.advance(10);
    expect(await outbox.runMaintenance()).toMatchObject({ retired: 1 });
    expect(await storage.get(key)).toBeNull();
    outbox.dispose();
  });

  it('stops at the page cap and resumes from its cursor on the next pass', async () => {
    const { outbox, clock } = createOutboxFixture({
      maintenanceBatchSize: 1,
      attemptTimeoutMs: 10,
      maxBacklog: 1000,
    });
    // 201 records at one record per page exceeds the 200-page cap.
    for (let index = 0; index < 201; index += 1) await enqueueOne(outbox);
    for (let index = 0; index < 201; index += 1) await claimOne(outbox);
    clock.advance(10);
    const first = await outbox.runMaintenance();
    const second = await outbox.runMaintenance();
    expect(first.rescheduled + second.rescheduled).toBe(201);
    expect(first.rescheduled).toBe(200);
    outbox.dispose();
  });
});

describe('runner edge cases', () => {
  it('returns the cancelled receipt when the begin is refused, without calling the adapter', async () => {
    const storage = new ScriptedStorage();
    const clock = createOutboxClock();
    const { outbox, adapter } = createOutboxFixture({ storage, clock });
    const deliveryId = await enqueueOne(outbox);
    const sibling = createOutboxFixture({ storage, clock }).outbox;
    storage.beforeBatch = async (ordinal) => {
      // Ordinal 1 is the enqueue, 2 the claim; cancel before the begin commits.
      if (ordinal === 3) {
        storage.beforeBatch = null;
        await sibling.requestCancellation({ deliveryId });
      }
    };
    const result = await outbox.deliverNext();
    expect(result.status === 'settled' && result.receipt.state).toBe('cancelled');
    expect(adapter.requests).toHaveLength(0);
    sibling.dispose();
    outbox.dispose();
  });

  it('reports a delivery retired mid-flight as a validation error', async () => {
    const storage = new ScriptedStorage();
    const { outbox } = createOutboxFixture({ storage });
    const deliveryId = await enqueueOne(outbox);
    storage.beforeBatch = async (ordinal) => {
      if (ordinal === 3) {
        storage.beforeBatch = null;
        await storage.delete(KEYS.applicationDelivery(NAMESPACE, OWNER, deliveryId));
      }
    };
    await expect(outbox.deliverNext()).rejects.toThrow(/retired while its attempt/);
    outbox.dispose();
  });

  it('never calls the adapter when the attempt deadline passes before the send', async () => {
    const storage = new ScriptedStorage();
    const clock = createOutboxClock();
    const { outbox, adapter } = createOutboxFixture({ storage, clock, attemptTimeoutMs: 10 });
    const deliveryId = await enqueueOne(outbox);
    storage.beforeBatch = (ordinal) => {
      // The begin commit lands, and the clock crosses the deadline right after.
      if (ordinal === 3) {
        storage.beforeBatch = null;
        clock.advance(10);
      }
    };
    const result = await outbox.deliverNext();
    expect(result.status === 'settled' && result.receipt.state).toBe('attempting');
    expect(adapter.requests).toHaveLength(0);
    expect(await outbox.runMaintenance()).toMatchObject({ parked: 1 });
    expect(await fieldOf(outbox.receipt(deliveryId), 'state')).toBe('unknown-outcome');
    outbox.dispose();
  });

  it('counts a delivery cancelled between claim and begin in the drain report', async () => {
    const storage = new ScriptedStorage();
    const clock = createOutboxClock();
    const { outbox, adapter } = createOutboxFixture({ storage, clock });
    const deliveryId = await enqueueOne(outbox);
    const sibling = createOutboxFixture({ storage, clock }).outbox;
    storage.beforeBatch = async (ordinal) => {
      if (ordinal === 3) {
        storage.beforeBatch = null;
        await sibling.requestCancellation({ deliveryId });
      }
    };
    // The cancellation was another actor's disposition, not this drain's.
    expect(await outbox.drain({ timeoutMs: 0 })).toMatchObject({ cancelled: 0, pending: 0 });
    expect(adapter.requests).toHaveLength(0);
    sibling.dispose();
    outbox.dispose();
  });

  it('parks a delivery whose adapter call was aborted by cancellation mid-send', async () => {
    const storage = new MemoryStorage();
    const clock = createOutboxClock();
    const sibling = createOutboxFixture({ storage, clock }).outbox;
    const { outbox } = createOutboxFixture({
      storage,
      clock,
      adapter: {
        async send(request) {
          await sibling.requestCancellation({ deliveryId: request.delivery.deliveryId });
          return { status: 'retryable' };
        },
      },
    });
    await enqueueOne(outbox);
    // The abort wins the race: whatever the adapter returned afterwards, the
    // outbox cannot know what the transport did once it stopped waiting.
    expect(await outbox.drain({ timeoutMs: 0 })).toMatchObject({ unknown: 1, pending: 0 });
    sibling.dispose();
    outbox.dispose();
  });
});

describe('outcome validation', () => {
  it('rethrows a non-validation failure from a hostile outcome', () => {
    const hostile = {
      get status(): string {
        throw new Error('boom');
      },
    };
    expect(() => validateOutcome(hostile)).toThrow('boom');
  });

  it('narrows attempting records', () => {
    expect(isApplicationDeliveryAttempting({ state: 'attempting' } as never)).toBe(true);
    expect(isApplicationDeliveryAttempting({ state: 'claimed' } as never)).toBe(false);
  });

  it('rejects a cleanup wait aborted while its read is stalled', async () => {
    const { outbox } = createOutboxFixture();
    const deliveryId = await enqueueOne(outbox);
    const stalled = createOutboxFixture({
      storage: new Proxy(outbox.storage, {
        get(target, property, receiver) {
          if (property === 'get') return () => new Promise(() => undefined);
          return Reflect.get(target, property, receiver);
        },
      }),
    }).outbox;
    const controller = new AbortController();
    const waiting = stalled.awaitCleanup({
      deliveryId,
      timeoutMs: 1_000_000,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort(new Error('gave up'));
    await expect(waiting).rejects.toThrow('gave up');
    stalled.dispose();
    outbox.dispose();
  });

  it('rejects a heartbeat whose delivery id cannot form a key', async () => {
    const { outbox } = createOutboxFixture();
    await expect(outbox.heartbeat({ deliveryId: '\uD800', attemptToken: 't' })).rejects.toThrow(
      ApplicationDeliveryValidationError,
    );
    expect(
      await statusOf(
        outbox.settle({ deliveryId: 'x', attemptToken: 't', outcome: { status: 'acknowledged' } }),
      ),
    ).toBe('unknown');
    outbox.dispose();
  });
});
