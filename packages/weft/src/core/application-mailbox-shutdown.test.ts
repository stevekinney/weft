/**
 * Shutdown and abort contract for the durable application command mailbox
 * (WFT-84): the bounded waits, disposal mid-wait, and the promise that
 * releasing process-local resources never deletes durable work.
 *
 * Every wait here runs on fake timers driven by `advanceTimersByTime`, and the
 * mailbox's own clock is injected separately — so both have to be advanced
 * together, exactly as they would move together in production. Nothing sleeps.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../storage/memory.ts';
import {
  advanceTimersByTime,
  flushMicrotasks,
  restoreRealTimers,
  useFakeTimers,
} from '../testing/fake-timers.test-support.ts';
import {
  admitOne,
  claimOne,
  commandInput,
  createMailboxClock,
  createMailboxFixture,
} from './application-mailbox.test-support.ts';
import { ApplicationMailbox } from './application-mailbox.ts';

afterEach(() => {
  restoreRealTimers();
});

/** Advance the fake timer wheel and the mailbox's injected clock in lockstep. */
async function tick(
  clock: { advance(milliseconds: number): void },
  milliseconds: number,
): Promise<void> {
  clock.advance(milliseconds);
  await advanceTimersByTime(milliseconds);
}

describe('ApplicationMailbox waitForAvailable', () => {
  it('resolves true immediately when work is already due', async () => {
    const { mailbox } = createMailboxFixture();
    await admitOne(mailbox);
    expect(await mailbox.waitForAvailable()).toBe(true);
    mailbox.dispose();
  });

  it('resolves false when the mailbox is empty and no time is allowed', async () => {
    const { mailbox } = createMailboxFixture();
    expect(await mailbox.waitForAvailable()).toBe(false);
    mailbox.dispose();
  });

  it('waits out a delay and resolves true once the head becomes due', async () => {
    useFakeTimers();
    const { mailbox, clock } = createMailboxFixture();
    await admitOne(mailbox, { availableAfterMs: 200 });

    const waiting = mailbox.waitForAvailable({ timeoutMs: 1_000, pollIntervalMs: 50 });
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });

    await tick(clock, 50);
    await flushMicrotasks();
    expect(settled).toBe(false);

    await tick(clock, 200);
    await flushMicrotasks();
    expect(await waiting).toBe(true);
    mailbox.dispose();
  });

  it('resolves false once the timeout elapses with nothing due', async () => {
    useFakeTimers();
    const { mailbox, clock } = createMailboxFixture();
    await admitOne(mailbox, { availableAfterMs: 10_000 });

    const waiting = mailbox.waitForAvailable({ timeoutMs: 150, pollIntervalMs: 50 });
    await tick(clock, 200);
    expect(await waiting).toBe(false);
    // The durable work is untouched.
    const listed = await mailbox.list();
    expect(listed.length).toBe(1);
    mailbox.dispose();
  });

  it('resolves false the moment its signal aborts, without deleting durable work', async () => {
    useFakeTimers();
    const { mailbox, clock } = createMailboxFixture();
    const commandId = await admitOne(mailbox, { availableAfterMs: 10_000 });
    const controller = new AbortController();

    const waiting = mailbox.waitForAvailable({
      timeoutMs: 60_000,
      pollIntervalMs: 50,
      signal: controller.signal,
    });
    await tick(clock, 50);
    controller.abort();
    expect(await waiting).toBe(false);
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('accepted');
    mailbox.dispose();
  });

  it('resolves false immediately when handed an already-aborted signal', async () => {
    const { mailbox } = createMailboxFixture();
    await admitOne(mailbox, { availableAfterMs: 10_000 });
    expect(
      await mailbox.waitForAvailable({
        timeoutMs: 60_000,
        signal: AbortSignal.abort(),
      }),
    ).toBe(false);
    mailbox.dispose();
  });

  it('resolves false when the mailbox is disposed mid-wait', async () => {
    useFakeTimers();
    const { mailbox, clock } = createMailboxFixture();
    await admitOne(mailbox, { availableAfterMs: 10_000 });

    const waiting = mailbox.waitForAvailable({ timeoutMs: 60_000, pollIntervalMs: 50 });
    await tick(clock, 50);
    mailbox.dispose();
    expect(await waiting).toBe(false);
  });

  it('ignores a delivery-index entry whose command vanished while waiting', async () => {
    const { mailbox, storage } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const { KEYS } = await import('../storage/interface.ts');
    await storage.delete(KEYS.applicationCommand('bureau', 'agent-7', commandId));
    expect(await mailbox.waitForAvailable()).toBe(false);
    mailbox.dispose();
  });
});

describe('ApplicationMailbox awaitCleanup', () => {
  it('resolves as soon as the claimant settles', async () => {
    useFakeTimers();
    const { mailbox, clock } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    await mailbox.requestCancellation({ commandId });

    const waiting = mailbox.awaitCleanup({ commandId, timeoutMs: 5_000, pollIntervalMs: 50 });
    await tick(clock, 50);
    await mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken });
    await tick(clock, 50);

    const cleanup = await waiting;
    expect(cleanup.status).toBe('settled');
    mailbox.dispose();
  });

  it('reports pending when the budget runs out, never that the handler stopped', async () => {
    useFakeTimers();
    const { mailbox, clock } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    await claimOne(mailbox);
    await mailbox.requestCancellation({ commandId });

    const waiting = mailbox.awaitCleanup({ commandId, timeoutMs: 150, pollIntervalMs: 50 });
    await tick(clock, 200);
    const cleanup = await waiting;
    expect(cleanup.status).toBe('pending');
    expect(cleanup.status === 'pending' && cleanup.receipt.state).toBe('cancellation-requested');
    mailbox.dispose();
  });

  it('stops waiting when its signal aborts', async () => {
    useFakeTimers();
    const { mailbox, clock } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    await claimOne(mailbox);
    await mailbox.requestCancellation({ commandId });
    const controller = new AbortController();

    const waiting = mailbox.awaitCleanup({
      commandId,
      timeoutMs: 60_000,
      pollIntervalMs: 50,
      signal: controller.signal,
    });
    await tick(clock, 50);
    controller.abort();
    const value = await waiting;
    expect(value.status).toBe('pending');
    mailbox.dispose();
  });

  it('stops waiting when the mailbox is disposed', async () => {
    useFakeTimers();
    const { mailbox, clock } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    await claimOne(mailbox);
    await mailbox.requestCancellation({ commandId });

    const waiting = mailbox.awaitCleanup({ commandId, timeoutMs: 60_000, pollIntervalMs: 50 });
    await tick(clock, 50);
    mailbox.dispose();
    const value = await waiting;
    expect(value.status).toBe('pending');
  });
});

describe('ApplicationMailbox disposal', () => {
  it('aborts every attempt this process holds without touching durable work', async () => {
    const storage = new MemoryStorage();
    const clock = createMailboxClock();
    const { mailbox } = createMailboxFixture({ storage, clock });
    const firstId = await admitOne(mailbox, { idempotencyKey: 'a' });
    await admitOne(mailbox, { idempotencyKey: 'b' });
    const first = await claimOne(mailbox);
    const second = await claimOne(mailbox);

    mailbox.dispose();
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);

    // The leases survive disposal; only maintenance may reclaim them.
    const reopened = createMailboxFixture({ storage, clock }).mailbox;
    const receipt = await reopened.receipt(firstId);
    expect(receipt?.state).toBe('claimed');
    const listed = await reopened.list();
    expect(listed.length).toBe(2);
    expect(await reopened.capacity()).toMatchObject({ open: 2 });
    reopened.dispose();
  });

  it('leaves a claim settleable by a later process after disposal', async () => {
    const storage = new MemoryStorage();
    const clock = createMailboxClock();
    const { mailbox } = createMailboxFixture({ storage, clock });
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    mailbox.dispose();

    const reopened = createMailboxFixture({ storage, clock }).mailbox;
    const settled = await reopened.acknowledge({ commandId, attemptToken: claim.attemptToken });
    expect(settled.status).toBe('settled');
    reopened.dispose();
  });

  it('releases the attempt signal when a claim settles normally', async () => {
    const { mailbox } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    expect(claim.signal.aborted).toBe(false);

    await mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken });
    expect(claim.signal.aborted).toBe(true);
    mailbox.dispose();
  });

  it('releases the attempt signal when maintenance reclaims an expired lease', async () => {
    const { mailbox, clock } = createMailboxFixture({ visibilityTimeoutMs: 500, maxAttempts: 5 });
    await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    expect(claim.signal.aborted).toBe(false);

    clock.advance(501);
    await mailbox.runMaintenance();
    expect(claim.signal.aborted).toBe(true);
    mailbox.dispose();
  });

  it('aborts a pending claim through its own signal', async () => {
    const { mailbox } = createMailboxFixture();
    await admitOne(mailbox);
    await expect(mailbox.claim({ signal: AbortSignal.abort() })).rejects.toThrow();
    // The durable work is untouched by an aborted claim attempt.
    const listed = await mailbox.list();
    expect(listed[0]?.state).toBe('available');
    mailbox.dispose();
  });

  it('supports `await using` over a mailbox handle', async () => {
    const storage = new MemoryStorage();
    {
      using mailbox = new ApplicationMailbox({
        storage,
        namespace: 'bureau',
        resourceId: 'agent-7',
      });
      await mailbox.admit(commandInput());
    }
    const reopened = new ApplicationMailbox({
      storage,
      namespace: 'bureau',
      resourceId: 'agent-7',
    });
    const listed = await reopened.list();
    expect(listed.length).toBe(1);
    reopened.dispose();
  });
});
