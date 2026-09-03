/**
 * Liveness and cancellation contract for the durable application command
 * mailbox (WFT-84): attempt-fenced renewal, the absolute deadline renewal
 * cannot move, activity evidence kept separate from semantic progress, and the
 * two distinct cancellation channels.
 *
 * The in-process channel is the attempt-scoped `AbortSignal`. The cross-process
 * channel is `renew()`'s `cancellationRequested` flag — a claimant in another
 * process never sees the signal, so both are exercised here.
 */

import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../storage/memory.ts';
import {
  admitOne,
  claimOne,
  createIdSource,
  createMailboxClock,
  createMailboxFixture,
} from './application-mailbox.test-support.ts';

describe('ApplicationMailbox lease renewal', () => {
  it('extends the visibility window from the moment of renewal', async () => {
    const { mailbox, clock } = createMailboxFixture({ visibilityTimeoutMs: 1_000 });
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    const receipt = await mailbox.receipt(commandId);
    const originalExpiry = receipt?.visibilityExpiresAt;

    clock.advance(500);
    const renewal = await mailbox.renew({ commandId, attemptToken: claim.attemptToken });
    expect(renewal.status).toBe('renewed');
    expect(renewal.status === 'renewed' && renewal.visibilityExpiresAt).toBe(clock.now() + 1_000);
    expect(renewal.status === 'renewed' && renewal.visibilityExpiresAt).toBeGreaterThan(
      originalExpiry ?? 0,
    );
    mailbox.dispose();
  });

  it('clamps renewal to the absolute deadline it can never move', async () => {
    const { mailbox, clock } = createMailboxFixture({
      visibilityTimeoutMs: 10_000,
      commandTimeoutMs: 3_000,
    });
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    const receipt = await mailbox.receipt(commandId);
    const deadline = receipt?.absoluteDeadlineAt ?? 0;
    expect(deadline).toBe(clock.now() + 3_000);

    clock.advance(1_000);
    const renewal = await mailbox.renew({ commandId, attemptToken: claim.attemptToken });
    expect(renewal.status === 'renewed' && renewal.visibilityExpiresAt).toBe(deadline);
    const receipt2 = await mailbox.receipt(commandId);
    expect(receipt2?.absoluteDeadlineAt).toBe(deadline);

    // Renewing repeatedly never moves the ceiling.
    clock.advance(1_000);
    await mailbox.renew({ commandId, attemptToken: claim.attemptToken });
    const receipt3 = await mailbox.receipt(commandId);
    expect(receipt3?.absoluteDeadlineAt).toBe(deadline);
    mailbox.dispose();
  });

  it('records activity evidence separately from semantic progress', async () => {
    const { mailbox, clock } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    const receipt = await mailbox.receipt(commandId);
    const claimedAt = receipt?.claimedAt;

    clock.advance(250);
    await mailbox.renew({ commandId, attemptToken: claim.attemptToken });
    const heartbeatOnly = await mailbox.receipt(commandId);
    expect(heartbeatOnly?.lastActivityAt).toBe(clock.now());
    expect(heartbeatOnly?.claimedAt).toBe(claimedAt);
    expect(heartbeatOnly?.progress).toBeUndefined();

    clock.advance(250);
    await mailbox.renew({
      commandId,
      attemptToken: claim.attemptToken,
      progress: { step: 'tokenizing', done: 3 },
    });
    const withProgress = await mailbox.receipt(commandId);
    expect(withProgress?.lastActivityAt).toBe(clock.now());
    expect(withProgress?.progress).toEqual({ step: 'tokenizing', done: 3 });

    // A later heartbeat without progress keeps the last reported progress.
    clock.advance(250);
    await mailbox.renew({ commandId, attemptToken: claim.attemptToken });
    const receipt2 = await mailbox.receipt(commandId);
    expect(receipt2?.progress).toEqual({ step: 'tokenizing', done: 3 });
    mailbox.dispose();
  });

  it('keeps a renewed lease alive through a maintenance pass', async () => {
    const { mailbox, clock } = createMailboxFixture({ visibilityTimeoutMs: 1_000 });
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);

    clock.advance(900);
    await mailbox.renew({ commandId, attemptToken: claim.attemptToken });
    clock.advance(900);
    const report = await mailbox.runMaintenance();
    expect(report.reclaimed).toBe(0);
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('claimed');

    clock.advance(200);
    const report2 = await mailbox.runMaintenance();
    expect(report2.reclaimed).toBe(1);
    mailbox.dispose();
  });

  it('a stale heartbeat cannot alter a newer attempt or a terminal one', async () => {
    const { mailbox, clock } = createMailboxFixture({ visibilityTimeoutMs: 500, maxAttempts: 5 });
    const commandId = await admitOne(mailbox);
    const stale = await claimOne(mailbox);

    clock.advance(501);
    await mailbox.runMaintenance();
    clock.advance(1_000);
    const current = await claimOne(mailbox);
    const before = await mailbox.receipt(commandId);

    const rejected = await mailbox.renew({ commandId, attemptToken: stale.attemptToken });
    expect(rejected.status).toBe('stale');
    expect(await mailbox.receipt(commandId)).toEqual(before);

    await mailbox.acknowledge({ commandId, attemptToken: current.attemptToken });
    const renewal = await mailbox.renew({ commandId, attemptToken: current.attemptToken });
    expect(renewal.status).toBe('stale');
    mailbox.dispose();
  });
});

describe('ApplicationMailbox cancellation', () => {
  it('cancels an unclaimed command immediately, with nothing to clean up', async () => {
    const { mailbox } = createMailboxFixture();
    const commandId = await admitOne(mailbox);

    const result = await mailbox.requestCancellation({ commandId, reason: 'user aborted' });
    expect(result.status).toBe('cancelled');
    expect(result.status === 'cancelled' && result.receipt.state).toBe('cancelled');
    expect(result.status === 'cancelled' && result.receipt.cleanupPending).toBe(false);
    expect(result.status === 'cancelled' && result.receipt.cancellationReason).toBe('user aborted');
    expect(result.status === 'cancelled' && result.receipt.failure).toEqual({
      reason: 'cancelled',
    });

    // It leaves the delivery queue entirely.
    const claimResult = await mailbox.claim();
    expect(claimResult.status).toBe('empty');
    expect(await mailbox.capacity()).toMatchObject({ open: 0 });
    mailbox.dispose();
  });

  it('records a durable request against a claimed command and leaves the lease intact', async () => {
    const { mailbox } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);

    const result = await mailbox.requestCancellation({ commandId, reason: 'superseded' });
    expect(result.status).toBe('requested');
    expect(result.status === 'requested' && result.cleanupPending).toBe(true);
    expect(result.status === 'requested' && result.receipt.state).toBe('cancellation-requested');

    // Only the current attempt may still settle it.
    const fromStranger = await mailbox.acknowledge({ commandId, attemptToken: 'other' });
    expect(fromStranger.status).toBe('stale');
    const settled = await mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken });
    expect(settled.status).toBe('settled');
    expect(settled.status === 'settled' && settled.receipt.state).toBe('cancelled');
    expect(settled.status === 'settled' && settled.receipt.cleanupPending).toBe(false);
    mailbox.dispose();
  });

  it('aborts an in-process claimant the moment the request is durable', async () => {
    const { mailbox } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    expect(claim.signal.aborted).toBe(false);

    await mailbox.requestCancellation({ commandId });
    expect(claim.signal.aborted).toBe(true);
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('cancellation-requested');
    mailbox.dispose();
  });

  it('reaches a claimant in another process through the renewal flag instead', async () => {
    const storage = new MemoryStorage();
    const clock = createMailboxClock();
    const consumer = createMailboxFixture({
      storage,
      clock,
      generateId: createIdSource('consumer'),
    }).mailbox;
    const controller = createMailboxFixture({
      storage,
      clock,
      generateId: createIdSource('controller'),
    }).mailbox;

    const commandId = await admitOne(consumer);
    const claim = await claimOne(consumer);

    // The controller holds no local controller for this attempt, so the signal
    // stays quiet — renewal is the only channel that reaches the consumer.
    await controller.requestCancellation({ commandId, reason: 'remote stop' });
    const renewal = await consumer.renew({ commandId, attemptToken: claim.attemptToken });
    expect(renewal.status).toBe('renewed');
    expect(renewal.status === 'renewed' && renewal.cancellationRequested).toBe(true);

    const settled = await consumer.reject({
      commandId,
      attemptToken: claim.attemptToken,
      failure: { reason: 'application', message: 'stopped early' },
    });
    expect(settled.status === 'settled' && settled.receipt.state).toBe('cancelled');
    consumer.dispose();
    controller.dispose();
  });

  it('is idempotent and distinguishes every target disposition', async () => {
    const { mailbox } = createMailboxFixture();
    const cancellation = await mailbox.requestCancellation({ commandId: 'nope' });
    expect(cancellation.status).toBe('unknown');

    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    const first = await mailbox.requestCancellation({ commandId, reason: 'once' });
    const second = await mailbox.requestCancellation({ commandId, reason: 'twice' });
    expect([first.status, second.status]).toEqual(['requested', 'requested']);
    // The second request does not rewrite the original reason.
    expect(second.status === 'requested' && second.receipt.cancellationReason).toBe('once');

    await mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken });
    const afterTerminal = await mailbox.requestCancellation({ commandId });
    expect(afterTerminal.status).toBe('already-terminal');
    expect(afterTerminal.status === 'already-terminal' && afterTerminal.receipt.state).toBe(
      'cancelled',
    );
    mailbox.dispose();
  });

  it('reports cleanup honestly when an uncooperative claimant never settles', async () => {
    const { mailbox, clock } = createMailboxFixture({ visibilityTimeoutMs: 1_000 });
    const commandId = await admitOne(mailbox);
    await claimOne(mailbox);
    await mailbox.requestCancellation({ commandId, reason: 'stop' });

    const beforeExpiry = await mailbox.cleanupState(commandId);
    expect(beforeExpiry.status).toBe('pending');

    clock.advance(1_001);
    const report = await mailbox.runMaintenance();
    expect(report.cancelled).toBe(1);

    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('cancelled');
    // The mailbox stopped waiting. It does not claim the handler stopped.
    expect(receipt?.cleanupPending).toBe(true);

    const cleanup = await mailbox.cleanupState(commandId);
    expect(cleanup.status).toBe('pending');
    expect(cleanup.status === 'pending' && cleanup.receipt.state).toBe('cancelled');
    mailbox.dispose();
  });

  it('reports settled cleanup once the claimant responds', async () => {
    const { mailbox } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    await mailbox.requestCancellation({ commandId });

    const beforeSettle = await mailbox.cleanupState(commandId);
    expect(beforeSettle.status).toBe('pending');
    await mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken });

    const cleanup = await mailbox.cleanupState(commandId);
    expect(cleanup.status).toBe('settled');
    expect(cleanup.status === 'settled' && cleanup.receipt.cleanupPending).toBe(false);
    const cleanup2 = await mailbox.cleanupState('nope');
    expect(cleanup2.status).toBe('unknown');
    mailbox.dispose();
  });

  it('returns immediately from awaitCleanup once the record is terminal', async () => {
    const { mailbox, clock } = createMailboxFixture({ visibilityTimeoutMs: 100 });
    const commandId = await admitOne(mailbox);
    await claimOne(mailbox);
    await mailbox.requestCancellation({ commandId });
    clock.advance(101);
    await mailbox.runMaintenance();

    // The record is terminal with cleanup outstanding — a value that can never
    // change, so the wait must not burn its budget polling for it.
    const cleanup = await mailbox.awaitCleanup({ commandId, timeoutMs: 60_000 });
    expect(cleanup.status).toBe('pending');
    expect(cleanup.status === 'pending' && cleanup.receipt.cleanupPending).toBe(true);
    const cleanup3 = await mailbox.awaitCleanup({ commandId: 'nope', timeoutMs: 1 });
    expect(cleanup3.status).toBe('unknown');
    mailbox.dispose();
  });

  it('keeps the outcome of work that completed before the cancellation was seen', async () => {
    const { mailbox } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    await mailbox.requestCancellation({ commandId, reason: 'too late' });

    // The claimant had already finished. The effect really happened, so the
    // result is retained even though the disposition is `cancelled`.
    const settled = await mailbox.acknowledge({
      commandId,
      attemptToken: claim.attemptToken,
      outcome: { chargedCents: 500 },
    });
    expect(settled.status).toBe('settled');
    expect(settled.status === 'settled' && settled.receipt.state).toBe('cancelled');
    expect(settled.status === 'settled' && settled.receipt.outcome).toEqual({ chargedCents: 500 });
    expect(settled.status === 'settled' && settled.receipt.cleanupPending).toBe(false);
    mailbox.dispose();
  });

  it('settles a cancelled command whose claimant reports failure', async () => {
    const { mailbox } = createMailboxFixture({ maxAttempts: 5 });
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    await mailbox.requestCancellation({ commandId });

    // Even a retryable rejection settles as cancelled: a failed cleanup is cleanup.
    const settled = await mailbox.reject({
      commandId,
      attemptToken: claim.attemptToken,
      failure: { reason: 'application' },
      retry: true,
    });
    expect(settled.status).toBe('settled');
    expect(settled.status === 'settled' && settled.receipt.state).toBe('cancelled');
    expect(settled.status === 'settled' && settled.receipt.failure).toEqual({
      reason: 'cancelled',
    });
    mailbox.dispose();
  });

  it('dead-letters a cancellation-requested command past its absolute deadline', async () => {
    const { mailbox, clock } = createMailboxFixture({
      commandTimeoutMs: 2_000,
      visibilityTimeoutMs: 10_000,
    });
    const commandId = await admitOne(mailbox);
    await claimOne(mailbox);
    await mailbox.requestCancellation({ commandId, reason: 'stop' });

    clock.advance(2_000);
    const report = await mailbox.runMaintenance();
    expect(report.deadLettered).toBe(1);
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('dead-lettered');
    expect(receipt?.failure?.reason).toBe('deadline-exceeded');
    expect(receipt?.cancellationReason).toBe('stop');
    expect(receipt?.cleanupPending).toBe(true);
    mailbox.dispose();
  });
});

describe('ApplicationMailbox observation during a live attempt', () => {
  it('lets many observers read liveness without disturbing the claimant', async () => {
    const { mailbox, clock } = createMailboxFixture({ visibilityTimeoutMs: 1_000 });
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    clock.advance(100);
    await mailbox.renew({ commandId, attemptToken: claim.attemptToken, progress: { done: 1 } });

    const observations = await Promise.all([
      mailbox.receipt(commandId),
      mailbox.receipt(commandId),
      mailbox.list({ states: ['claimed'] }),
      mailbox.cleanupState(commandId),
      mailbox.capacity(),
    ]);
    const [left, right] = observations;
    expect(left).toEqual(right);
    expect((left as { lastActivityAt?: number } | null)?.lastActivityAt).toBe(clock.now());

    // Nothing an observer did disturbed the lease.
    expect(claim.signal.aborted).toBe(false);
    const settled = await mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken });
    expect(settled.status).toBe('settled');
    mailbox.dispose();
  });
});
