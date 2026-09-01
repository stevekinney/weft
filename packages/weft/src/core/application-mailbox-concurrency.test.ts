/**
 * Concurrency contract for the durable application command mailbox (WFT-84).
 *
 * Two consumers sharing one durable store must never both hold a valid claim,
 * a stale attempt must never mutate a newer one, and the state transition and
 * its fleet event must be visible together or not at all. Every race here is
 * driven by real concurrent promises against a shared backend rather than by
 * timing, so the assertions hold regardless of scheduling.
 */

import { describe, expect, it } from 'bun:test';

import { createFleetEventFeed } from '../server/fleet-event-feed.ts';
import { KEYS, type BatchOperation, type ConditionalBatchCondition } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { storageBackends, teardown } from '../testing/storage-backends.test-support.ts';
import {
  admitOne,
  claimOne,
  commandInput,
  createIdSource,
  createMailboxClock,
  createMailboxFixture,
} from './application-mailbox.test-support.ts';
import { ApplicationMailbox } from './application-mailbox.ts';
import { decode } from './codec.ts';

describe('ApplicationMailbox concurrent claims', () => {
  it('lets only one of two concurrent claims on one instance win', async () => {
    const { mailbox } = createMailboxFixture();
    await admitOne(mailbox);

    const [left, right] = await Promise.all([mailbox.claim(), mailbox.claim()]);
    const statuses = [left.status, right.status].toSorted();
    expect(statuses).toEqual(['claimed', 'empty']);
    mailbox.dispose();
  });

  it('lets only one of two separate instances claim the same command', async () => {
    const storage = new MemoryStorage();
    const clock = createMailboxClock();
    const first = createMailboxFixture({ storage, clock, generateId: createIdSource('a') }).mailbox;
    const second = createMailboxFixture({
      storage,
      clock,
      generateId: createIdSource('b'),
    }).mailbox;

    await admitOne(first);
    const [left, right] = await Promise.all([first.claim(), second.claim()]);
    expect([left.status, right.status].toSorted()).toEqual(['claimed', 'empty']);

    const winner = left.status === 'claimed' ? left : right;
    if (winner.status !== 'claimed') throw new Error('one claim must have won');
    const receipt = await first.receipt(winner.claim.receipt.commandId);
    expect(receipt?.state).toBe('claimed');
    expect(receipt?.attempt).toBe(1);

    first.dispose();
    second.dispose();
  });

  it('serializes many concurrent claims into distinct commands, one each', async () => {
    const { mailbox } = createMailboxFixture();
    for (let index = 0; index < 5; index += 1) await admitOne(mailbox);

    const results = await Promise.all(Array.from({ length: 8 }, () => mailbox.claim()));
    const claimed = results.filter((result) => result.status === 'claimed');
    const sequences = claimed.map((result) =>
      result.status === 'claimed' ? result.claim.receipt.sequence : -1,
    );
    expect(claimed.length).toBe(5);
    expect(new Set(sequences).size).toBe(5);
    expect(sequences.toSorted((left, right) => left - right)).toEqual([0, 1, 2, 3, 4]);
    mailbox.dispose();
  });

  it('mints a distinct attempt token per claim so no two attempts collide', async () => {
    const { mailbox, clock } = createMailboxFixture({ maxAttempts: 5, visibilityTimeoutMs: 1_000 });
    const commandId = await admitOne(mailbox);

    const first = await claimOne(mailbox);
    // Expire the lease, then wait out the retry backoff the reclaim schedules.
    clock.advance(1_001);
    await mailbox.runMaintenance();
    expect((await mailbox.receipt(commandId))?.state).toBe('accepted');
    clock.advance(1_000);
    const second = await claimOne(mailbox);

    expect(second.attemptToken).not.toBe(first.attemptToken);
    expect(second.commandId).toBe(commandId);
    mailbox.dispose();
  });
});

describe('ApplicationMailbox attempt fencing', () => {
  it('refuses every settlement from a superseded attempt', async () => {
    const { mailbox, clock } = createMailboxFixture({ maxAttempts: 5, visibilityTimeoutMs: 1_000 });
    const commandId = await admitOne(mailbox);
    const stale = await claimOne(mailbox);

    clock.advance(1_001);
    await mailbox.runMaintenance();
    clock.advance(1_000);
    const current = await claimOne(mailbox);
    expect(current.attemptToken).not.toBe(stale.attemptToken);

    const failure = { reason: 'application' as const };
    expect((await mailbox.renew({ commandId, attemptToken: stale.attemptToken })).status).toBe(
      'stale',
    );
    expect(
      (await mailbox.acknowledge({ commandId, attemptToken: stale.attemptToken })).status,
    ).toBe('stale');
    expect(
      (await mailbox.reject({ commandId, attemptToken: stale.attemptToken, failure })).status,
    ).toBe('stale');

    // The newer attempt is untouched by any of that.
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('claimed');
    expect(
      (await mailbox.acknowledge({ commandId, attemptToken: current.attemptToken })).status,
    ).toBe('settled');
    mailbox.dispose();
  });

  it('refuses settlement against an unknown command and an unleased one', async () => {
    const { mailbox } = createMailboxFixture();
    expect((await mailbox.renew({ commandId: 'nope', attemptToken: 't' })).status).toBe('unknown');
    expect((await mailbox.acknowledge({ commandId: 'nope', attemptToken: 't' })).status).toBe(
      'unknown',
    );

    const commandId = await admitOne(mailbox);
    expect((await mailbox.renew({ commandId, attemptToken: 't' })).status).toBe('stale');
    mailbox.dispose();
  });

  it('refuses settlement once the command is terminal', async () => {
    const { mailbox } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    await mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken });

    const again = await mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken });
    expect(again.status).toBe('stale');
    expect(again.status === 'stale' && again.receipt.state).toBe('applied');
    mailbox.dispose();
  });

  it('lets two concurrent settlements of one attempt produce exactly one terminal write', async () => {
    const { mailbox } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);

    const [left, right] = await Promise.all([
      mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken, outcome: 'left' }),
      mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken, outcome: 'right' }),
    ]);
    const statuses = [left.status, right.status].toSorted();
    expect(statuses).toEqual(['settled', 'stale']);
    expect((await mailbox.receipt(commandId))?.state).toBe('applied');
    mailbox.dispose();
  });
});

describe('ApplicationMailbox concurrent admission', () => {
  it('converges concurrent same-key admissions on one command', async () => {
    const storage = new MemoryStorage();
    const clock = createMailboxClock();
    const first = createMailboxFixture({ storage, clock, generateId: createIdSource('a') }).mailbox;
    const second = createMailboxFixture({
      storage,
      clock,
      generateId: createIdSource('b'),
    }).mailbox;

    const [left, right] = await Promise.all([
      first.admit(commandInput({ idempotencyKey: 'shared' })),
      second.admit(commandInput({ idempotencyKey: 'shared' })),
    ]);
    expect([left.status, right.status].toSorted()).toEqual(['admitted', 'duplicate']);
    expect((await first.list()).length).toBe(1);
    expect((await first.capacity()).admitted).toBe(1);
    first.dispose();
    second.dispose();
  });

  it('allocates a gap-free FIFO sequence under concurrent admission', async () => {
    const { mailbox } = createMailboxFixture();
    await Promise.all(
      Array.from({ length: 6 }, (_unused, index) =>
        mailbox.admit(commandInput({ idempotencyKey: `k-${index}` })),
      ),
    );
    const sequences = (await mailbox.list()).map((receipt) => receipt.sequence);
    expect(sequences).toEqual([0, 1, 2, 3, 4, 5]);
    mailbox.dispose();
  });
});

describe('ApplicationMailbox state and event atomicity', () => {
  it('exposes neither the state transition nor the event when the commit fails', async () => {
    const storage = new MemoryStorage();
    const feed = createFleetEventFeed(storage);
    const { mailbox } = createMailboxFixture({ storage, events: feed });

    const tailBefore = await feed.snapshotTailSequence();
    const failure = new Error('storage unavailable');
    let failNext = true;
    const original = storage.conditionalBatch.bind(storage);
    storage.conditionalBatch = async (
      conditions: ConditionalBatchCondition[],
      operations: BatchOperation[],
    ): Promise<boolean> => {
      if (failNext) {
        failNext = false;
        throw failure;
      }
      return original(conditions, operations);
    };

    await expect(mailbox.admit(commandInput())).rejects.toThrow(failure);

    let persisted = 0;
    for await (const _entry of storage.scan(KEYS.applicationCommandPrefix('bureau', 'agent-7'))) {
      persisted += 1;
    }
    expect(persisted).toBe(0);
    expect(await feed.snapshotTailSequence()).toBe(tailBefore);

    // The very next admission commits both sides together.
    const admitted = await mailbox.admit(commandInput());
    expect(admitted.status).toBe('admitted');
    expect(await feed.snapshotTailSequence()).toBe(tailBefore + 1);
    expect(await storage.get(KEYS.applicationCommandPrefix('bureau', 'agent-7'))).toBeNull();

    const events = [];
    for await (const envelope of feed.replay()) events.push(envelope);
    expect(events.map((envelope) => envelope.kind)).toEqual(['mailbox:command-available']);
    feed.dispose();
    mailbox.dispose();
  });

  it('commits the command record and its fleet event in one conditional batch', async () => {
    const storage = new MemoryStorage();
    const feed = createFleetEventFeed(storage);
    const batches: BatchOperation[][] = [];
    const original = storage.conditionalBatch.bind(storage);
    storage.conditionalBatch = async (
      conditions: ConditionalBatchCondition[],
      operations: BatchOperation[],
    ): Promise<boolean> => {
      batches.push(operations);
      return original(conditions, operations);
    };
    const { mailbox } = createMailboxFixture({ storage, events: feed });

    await admitOne(mailbox);
    const admissionBatch = batches.at(-1) ?? [];
    const keys = admissionBatch.map((operation) => operation.key);
    expect(keys.some((key) => key.startsWith('appcmd:v1:'))).toBe(true);
    expect(keys.some((key) => key.startsWith('appready:v1:'))).toBe(true);
    expect(keys.some((key) => key.startsWith('appmbx:v1:'))).toBe(true);
    expect(keys).toContain(KEYS.fleetEventTail());

    feed.dispose();
    mailbox.dispose();
  });

  it('drives a real fleet feed through a full command lifecycle', async () => {
    const storage = new MemoryStorage();
    const feed = createFleetEventFeed(storage);
    const { mailbox } = createMailboxFixture({ storage, events: feed, maxAttempts: 2 });

    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    await mailbox.reject({
      commandId,
      attemptToken: claim.attemptToken,
      failure: { reason: 'application' },
      retry: false,
    });

    const kinds = [];
    for await (const envelope of feed.replay()) kinds.push(envelope.kind);
    expect(kinds).toEqual([
      'mailbox:command-available',
      'mailbox:command-claimed',
      'mailbox:command-rejected',
    ]);
    feed.dispose();
    mailbox.dispose();
  });

  it('never publishes an event whose command record is missing after a lost race', async () => {
    const storage = new MemoryStorage();
    const feed = createFleetEventFeed(storage);
    const clock = createMailboxClock();
    const first = createMailboxFixture({
      storage,
      clock,
      events: feed,
      generateId: createIdSource('a'),
    }).mailbox;
    const second = createMailboxFixture({
      storage,
      clock,
      events: feed,
      generateId: createIdSource('b'),
    }).mailbox;

    await admitOne(first);
    await Promise.all([first.claim(), second.claim()]);

    const claimedEvents = [];
    for await (const envelope of feed.replay()) {
      if (envelope.kind === 'mailbox:command-claimed') claimedEvents.push(envelope);
    }
    expect(claimedEvents.length).toBe(1);

    const payload = claimedEvents[0]?.payload as { commandId: string };
    const stored = await storage.get(
      KEYS.applicationCommand('bureau', 'agent-7', payload.commandId),
    );
    expect(stored).not.toBeNull();
    expect((decode(stored!) as { state: string }).state).toBe('claimed');

    feed.dispose();
    first.dispose();
    second.dispose();
  });
});

describe('ApplicationMailbox concurrency across storage backends', () => {
  for (const backend of storageBackends) {
    it(`fences concurrent claims on ${backend.name}`, async () => {
      const created = backend.factory();
      if (!created.storage.capabilities().conditionalBatch) {
        await teardown(undefined, created.cleanup);
        return;
      }
      const clock = createMailboxClock();
      const left = new ApplicationMailbox({
        storage: created.storage,
        namespace: 'bureau',
        resourceId: 'agent-7',
        now: clock.now,
        generateId: createIdSource('left'),
      });
      const right = new ApplicationMailbox({
        storage: created.storage,
        namespace: 'bureau',
        resourceId: 'agent-7',
        now: clock.now,
        generateId: createIdSource('right'),
      });
      try {
        await admitOne(left);
        const results = await Promise.all([left.claim(), right.claim()]);
        expect(results.map((result) => result.status).toSorted()).toEqual(['claimed', 'empty']);
      } finally {
        left.dispose();
        right.dispose();
        await teardown(undefined, created.cleanup);
      }
    });
  }
});
