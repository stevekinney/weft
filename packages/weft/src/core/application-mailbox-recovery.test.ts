/**
 * Recovery contract for the durable application command mailbox (WFT-84):
 * process restart, FIFO order through crash and visibility expiry, bounded
 * retry, dead-lettering, and terminal-receipt retention.
 *
 * Every "restart" here is a fresh `ApplicationMailbox` over the same storage —
 * the only thing a real restart preserves — so nothing in these tests can
 * accidentally depend on process-local state.
 */

import { describe, expect, it } from 'bun:test';

import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { storageBackends, teardown } from '../testing/storage-backends.test-support.ts';
import {
  admitOne,
  claimOne,
  commandInput,
  createIdSource,
  createMailboxClock,
  createMailboxFixture,
  type MailboxClock,
} from './application-mailbox.test-support.ts';
import { ApplicationMailbox } from './application-mailbox.ts';

describe('ApplicationMailbox restart', () => {
  it('reattaches to a receipt and to an open lease after restart', async () => {
    const storage = new MemoryStorage();
    const clock = createMailboxClock();
    const before = createMailboxFixture({ storage, clock }).mailbox;
    const commandId = await admitOne(before, { idempotencyKey: 'k' });
    const claim = await claimOne(before);
    before.dispose();

    const after = createMailboxFixture({ storage, clock }).mailbox;
    const receipt = await after.receipt(commandId);
    expect(receipt?.state).toBe('claimed');
    expect(receipt?.attempt).toBe(1);
    // The token is still the fence: the surviving claimant settles, a stranger cannot.
    const settled = await after.acknowledge({ commandId, attemptToken: 'guessed' });
    expect(settled.status).toBe('stale');
    const settled2 = await after.acknowledge({ commandId, attemptToken: claim.attemptToken });
    expect(settled2.status).toBe('settled');
    after.dispose();
  });

  it('recovers a delayed command and the mailbox sequence across restart', async () => {
    const storage = new MemoryStorage();
    const clock = createMailboxClock();
    const before = createMailboxFixture({ storage, clock }).mailbox;
    await admitOne(before, { idempotencyKey: 'a' });
    await admitOne(before, { idempotencyKey: 'b', availableAfterMs: 10_000 });
    before.dispose();

    const after = createMailboxFixture({ storage, clock }).mailbox;
    const admitted = await after.admit(commandInput({ idempotencyKey: 'c' }));
    expect(admitted.status === 'admitted' && admitted.receipt.sequence).toBe(2);
    expect(await after.capacity()).toMatchObject({ open: 3, admitted: 3 });
    after.dispose();
  });

  it('recovers the payload and re-verifies its digest after restart', async () => {
    const storage = new MemoryStorage();
    const clock = createMailboxClock();
    const before = createMailboxFixture({ storage, clock }).mailbox;
    await before.admit(
      commandInput({ payload: { form: 'inline', value: { blob: new Uint8Array([7, 8, 9]) } } }),
    );
    before.dispose();

    const after = createMailboxFixture({ storage, clock }).mailbox;
    const result = await after.claim();
    expect(result.status).toBe('claimed');
    if (result.status !== 'claimed' || result.claim.payload.form !== 'inline') return;
    const value = result.claim.payload.value as { blob: Uint8Array };
    expect(value.blob).toBeInstanceOf(Uint8Array);
    expect([...value.blob]).toEqual([7, 8, 9]);
    expect(result.claim.payload.verified).toBe(true);
    after.dispose();
  });
});

describe('ApplicationMailbox FIFO order through expiry and retry', () => {
  it('redelivers an expired claim at its original position, ahead of later commands', async () => {
    const { mailbox, clock } = createMailboxFixture({
      visibilityTimeoutMs: 1_000,
      retryBackoffMs: 1,
      maxAttempts: 5,
    });
    const first = await admitOne(mailbox, { idempotencyKey: '0' });
    await admitOne(mailbox, { idempotencyKey: '1' });
    await admitOne(mailbox, { idempotencyKey: '2' });

    const claimed = await claimOne(mailbox);
    expect(claimed.commandId).toBe(first);

    // Sequence 1 gets delivered while 0 is in flight — that is ordinary parallel
    // consumption, not an ordering violation.
    const second = await claimOne(mailbox);
    const receipt = await mailbox.receipt(second.commandId);
    expect(receipt?.sequence).toBe(1);

    clock.advance(1_001);
    const report = await mailbox.runMaintenance();
    expect(report.reclaimed).toBe(2);

    clock.advance(10);
    // Sequence 0 re-enters at its original position, ahead of the untouched 2.
    const redelivered = await claimOne(mailbox);
    expect(redelivered.commandId).toBe(first);
    const receipt2 = await mailbox.receipt(first);
    expect(receipt2?.retryCount).toBe(1);
    mailbox.dispose();
  });

  it('holds the queue head rather than letting a later command overtake it', async () => {
    const { mailbox, clock } = createMailboxFixture();
    await admitOne(mailbox, { idempotencyKey: 'delayed', availableAfterMs: 5_000 });
    await admitOne(mailbox, { idempotencyKey: 'ready' });

    const held = await mailbox.claim();
    expect(held.status).toBe('held');
    expect(held.status === 'held' && held.availableAt).toBe(clock.now() + 5_000);

    clock.advance(5_000);
    const claimed = await claimOne(mailbox);
    const receipt = await mailbox.receipt(claimed.commandId);
    expect(receipt?.sequence).toBe(0);
    mailbox.dispose();
  });

  it('schedules a rejected retry with exponential backoff at the original position', async () => {
    const { mailbox, clock } = createMailboxFixture({ retryBackoffMs: 100, maxAttempts: 4 });
    const commandId = await admitOne(mailbox);

    const first = await claimOne(mailbox);
    const rejected = await mailbox.reject({
      commandId,
      attemptToken: first.attemptToken,
      failure: { reason: 'application', message: 'transient' },
      retry: true,
    });
    expect(rejected.status).toBe('retrying');
    expect(rejected.status === 'retrying' && rejected.receipt.state).toBe('accepted');
    expect(rejected.status === 'retrying' && rejected.receipt.availableAt).toBe(clock.now() + 100);

    const claimResult = await mailbox.claim();
    expect(claimResult.status).toBe('held');
    clock.advance(100);
    const second = await claimOne(mailbox);
    expect(second.commandId).toBe(commandId);

    // Attempt 2 backs off twice as far.
    await mailbox.reject({
      commandId,
      attemptToken: second.attemptToken,
      failure: { reason: 'application' },
      retry: true,
    });
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.availableAt).toBe(clock.now() + 200);
    mailbox.dispose();
  });

  it('caps backoff at the configured ceiling', async () => {
    const { mailbox, clock } = createMailboxFixture({
      retryBackoffMs: 1_000,
      maxRetryBackoffMs: 1_500,
      maxAttempts: 6,
    });
    const commandId = await admitOne(mailbox);
    for (let round = 0; round < 3; round += 1) {
      const claim = await claimOne(mailbox);
      await mailbox.reject({
        commandId,
        attemptToken: claim.attemptToken,
        failure: { reason: 'application' },
        retry: true,
      });
      clock.advance(1_500);
    }
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.retryCount).toBe(3);
    mailbox.dispose();
  });
});

describe('ApplicationMailbox dead-lettering', () => {
  it('dead-letters a rejected retry once attempts are exhausted', async () => {
    const { mailbox, clock } = createMailboxFixture({ maxAttempts: 2, retryBackoffMs: 1 });
    const commandId = await admitOne(mailbox);

    const first = await claimOne(mailbox);
    await mailbox.reject({
      commandId,
      attemptToken: first.attemptToken,
      failure: { reason: 'application' },
      retry: true,
    });
    clock.advance(10);

    const second = await claimOne(mailbox);
    const settled = await mailbox.reject({
      commandId,
      attemptToken: second.attemptToken,
      failure: { reason: 'application', message: 'still broken' },
      retry: true,
    });
    expect(settled.status).toBe('settled');
    expect(settled.status === 'settled' && settled.receipt.state).toBe('dead-lettered');
    expect(settled.status === 'settled' && settled.receipt.failure).toEqual({
      reason: 'attempts-exhausted',
      message: 'still broken',
      details: undefined,
    });
    expect(await mailbox.capacity()).toMatchObject({ open: 0 });
    mailbox.dispose();
  });

  it('dead-letters an expired claim once attempts are exhausted', async () => {
    const { mailbox, clock } = createMailboxFixture({ maxAttempts: 1, visibilityTimeoutMs: 500 });
    const commandId = await admitOne(mailbox);
    await claimOne(mailbox);

    clock.advance(501);
    const report = await mailbox.runMaintenance();
    expect(report.deadLettered).toBe(1);

    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('dead-lettered');
    expect(receipt?.failure?.reason).toBe('attempts-exhausted');
    expect(receipt?.terminalAt).toBe(clock.now());
    mailbox.dispose();
  });

  it('dead-letters any non-terminal command past its absolute deadline', async () => {
    const { mailbox, clock } = createMailboxFixture({
      commandTimeoutMs: 2_000,
      visibilityTimeoutMs: 10_000,
      maxAttempts: 10,
    });
    const claimedId = await admitOne(mailbox, { idempotencyKey: 'claimed' });
    const waitingId = await admitOne(mailbox, { idempotencyKey: 'waiting' });
    const claim = await claimOne(mailbox);

    clock.advance(2_000);
    const report = await mailbox.runMaintenance();
    expect(report.deadLettered).toBe(2);

    const claimedReceipt = await mailbox.receipt(claimedId);
    expect(claimedReceipt?.state).toBe('dead-lettered');
    expect(claimedReceipt?.failure?.reason).toBe('deadline-exceeded');
    expect(claimedReceipt?.cleanupPending).toBe(true);

    const waitingReceipt = await mailbox.receipt(waitingId);
    expect(waitingReceipt?.state).toBe('dead-lettered');
    expect(waitingReceipt?.cleanupPending).toBeUndefined();

    // The abandoned attempt cannot write a result after the deadline.
    const abandoned = await mailbox.acknowledge({
      commandId: claimedId,
      attemptToken: claim.attemptToken,
    });
    expect(abandoned.status).toBe('stale');
    mailbox.dispose();
  });

  it('refuses to renew or settle past the absolute deadline, before maintenance runs', async () => {
    const { mailbox, clock } = createMailboxFixture({
      commandTimeoutMs: 1_000,
      visibilityTimeoutMs: 10_000,
    });
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);

    clock.advance(1_000);
    const renewal = await mailbox.renew({ commandId, attemptToken: claim.attemptToken });
    expect(renewal.status).toBe('deadline-exceeded');
    const settlement = await mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken });
    expect(settlement.status).toBe('deadline-exceeded');
    // Still `claimed` on disk; maintenance owns the terminal write.
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('claimed');
    mailbox.dispose();
  });

  it('retains bounded terminal evidence for every terminal disposition', async () => {
    const { mailbox } = createMailboxFixture();
    const appliedId = await admitOne(mailbox, { idempotencyKey: 'a' });
    const rejectedId = await admitOne(mailbox, { idempotencyKey: 'r' });

    const appliedClaim = await claimOne(mailbox);
    await mailbox.acknowledge({
      commandId: appliedId,
      attemptToken: appliedClaim.attemptToken,
      outcome: { applied: true },
    });
    const rejectedClaim = await claimOne(mailbox);
    await mailbox.reject({
      commandId: rejectedId,
      attemptToken: rejectedClaim.attemptToken,
      failure: { reason: 'application', message: 'unsupported kind', details: { code: 7 } },
    });

    const applied = await mailbox.receipt(appliedId);
    expect(applied?.state).toBe('applied');
    expect(applied?.outcome).toEqual({ applied: true });
    expect(applied?.terminalAt).toBeGreaterThan(0);

    const rejected = await mailbox.receipt(rejectedId);
    expect(rejected?.state).toBe('rejected');
    expect(rejected?.failure).toEqual({
      reason: 'application',
      message: 'unsupported kind',
      details: { code: 7 },
    });
    mailbox.dispose();
  });
});

describe('ApplicationMailbox maintenance', () => {
  it('releases a delayed command and reports what it did', async () => {
    const { mailbox, clock } = createMailboxFixture();
    const commandId = await admitOne(mailbox, { availableAfterMs: 1_000 });
    const tooEarly = await mailbox.runMaintenance();
    expect(tooEarly.released).toBe(0);

    clock.advance(1_000);
    const report = await mailbox.runMaintenance();
    expect(report).toEqual({
      released: 1,
      reclaimed: 0,
      deadLettered: 0,
      cancelled: 0,
      retired: 0,
    });
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('available');

    // A second pass finds nothing left to do.
    const report2 = await mailbox.runMaintenance();
    expect(report2.released).toBe(0);
    mailbox.dispose();
  });

  it('starts no timer of its own, so a manual host drives every time-based transition', async () => {
    const { mailbox, clock } = createMailboxFixture({ visibilityTimeoutMs: 100 });
    const commandId = await admitOne(mailbox);
    await claimOne(mailbox);

    clock.advance(1_000);
    // Nothing has run in the background: the record is still leased.
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('claimed');
    await mailbox.runMaintenance();
    const receipt2 = await mailbox.receipt(commandId);
    expect(receipt2?.state).toBe('accepted');
    mailbox.dispose();
  });

  it('accepts an explicit instant so a host can drive maintenance off its own clock', async () => {
    const { mailbox, clock } = createMailboxFixture();
    const commandId = await admitOne(mailbox, { availableAfterMs: 1_000 });
    await mailbox.runMaintenance(clock.now() + 1_000);
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('available');
    mailbox.dispose();
  });

  it('fails closed rather than sweeping around a corrupt record', async () => {
    const { mailbox, storage } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    await storage.put(
      KEYS.applicationCommand('bureau', 'agent-7', commandId),
      new Uint8Array([0xc1, 0xc1]),
    );
    await expect(mailbox.runMaintenance()).rejects.toThrow(/corrupt/);
    mailbox.dispose();
  });
});

describe('ApplicationMailbox terminal retention', () => {
  it('retires a terminal receipt and its idempotency binding once retention passes', async () => {
    const { mailbox, storage, clock } = createMailboxFixture({ terminalRetentionMs: 10_000 });
    const commandId = await admitOne(mailbox, { idempotencyKey: 'k' });
    const claim = await claimOne(mailbox);
    await mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken });

    clock.advance(9_000);
    const report = await mailbox.runMaintenance();
    expect(report.retired).toBe(0);
    expect(await mailbox.receipt(commandId)).not.toBeNull();

    clock.advance(2_000);
    const report2 = await mailbox.runMaintenance();
    expect(report2.retired).toBe(1);
    expect(await mailbox.receipt(commandId)).toBeNull();
    expect(
      await storage.get(KEYS.applicationCommandIdempotency('bureau', 'agent-7', 'k')),
    ).toBeNull();

    // Past retention the key is spent, so a retry is admitted afresh.
    const retry = await mailbox.admit(commandInput({ idempotencyKey: 'k' }));
    expect(retry.status).toBe('admitted');
    mailbox.dispose();
  });

  it('retires the oldest receipts first and stops at the retention horizon', async () => {
    const { mailbox, clock } = createMailboxFixture({ terminalRetentionMs: 5_000 });
    const older = await admitOne(mailbox, { idempotencyKey: 'older' });
    const olderClaim = await claimOne(mailbox);
    await mailbox.acknowledge({ commandId: older, attemptToken: olderClaim.attemptToken });

    clock.advance(4_000);
    const newer = await admitOne(mailbox, { idempotencyKey: 'newer' });
    const newerClaim = await claimOne(mailbox);
    await mailbox.acknowledge({ commandId: newer, attemptToken: newerClaim.attemptToken });

    clock.advance(2_000);
    const report = await mailbox.runMaintenance();
    expect(report.retired).toBe(1);
    expect(await mailbox.receipt(older)).toBeNull();
    expect(await mailbox.receipt(newer)).not.toBeNull();
    mailbox.dispose();
  });

  it('treats a binding whose command was retired as spent rather than as a conflict', async () => {
    const { mailbox, storage, clock } = createMailboxFixture({ terminalRetentionMs: 1_000 });
    const commandId = await admitOne(mailbox, { idempotencyKey: 'k' });
    const claim = await claimOne(mailbox);
    await mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken });

    // Drop only the command record, leaving a dangling binding behind.
    await storage.delete(KEYS.applicationCommand('bureau', 'agent-7', commandId));
    clock.advance(10);

    const retry = await mailbox.admit(commandInput({ idempotencyKey: 'k' }));
    expect(retry.status).toBe('admitted');
    mailbox.dispose();
  });
});

describe('ApplicationMailbox recovery across storage backends', () => {
  for (const backend of storageBackends) {
    it(`preserves FIFO order through expiry on ${backend.name}`, async () => {
      const created = backend.factory();
      const capabilities = created.storage.capabilities();
      if (!capabilities.conditionalBatch || capabilities.scanConsistency !== 'snapshot') {
        await teardown(undefined, created.cleanup);
        return;
      }
      const clock: MailboxClock = createMailboxClock();
      const build = (): ApplicationMailbox =>
        new ApplicationMailbox({
          storage: created.storage,
          namespace: 'bureau',
          resourceId: 'agent-7',
          now: clock.now,
          generateId: createIdSource(backend.name),
          visibilityTimeoutMs: 1_000,
          retryBackoffMs: 1,
          maxAttempts: 5,
        });

      const before = build();
      let head = '';
      try {
        head = await admitOne(before, { idempotencyKey: '0' });
        await admitOne(before, { idempotencyKey: '1' });
        const claim = await claimOne(before);
        expect(claim.commandId).toBe(head);
      } finally {
        before.dispose();
      }

      // A fresh instance stands in for a restarted process.
      const after = build();
      try {
        clock.advance(1_001);
        const report = await after.runMaintenance();
        expect(report.reclaimed).toBe(1);
        clock.advance(10);
        const redelivered = await claimOne(after);
        expect(redelivered.commandId).toBe(head);
        const receipt = await after.receipt(head);
        expect(receipt?.retryCount).toBe(1);
      } finally {
        after.dispose();
        await teardown(undefined, created.cleanup);
      }
    });
  }
});
