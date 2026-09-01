/**
 * Regressions for the durability and safety holes review found in the first
 * cut of the application command mailbox (WFT-84).
 *
 * Each of these is a case where the mailbox previously did something plausible
 * but wrong: leased work past its own deadline, scanned only the first page of a
 * large mailbox forever, persisted a payload the caller could still mutate,
 * accepted metadata its own decoder would later reject, or reported a durable
 * commit that landed in a different backend.
 */

import { describe, expect, it } from 'bun:test';

import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import {
  advanceTimersByTime,
  restoreRealTimers,
  useFakeTimers,
} from '../testing/fake-timers.test-support.ts';
import { MAILBOX_MAINTENANCE_SCAN_LIMIT } from './application-mailbox-internals.ts';
import { ApplicationCommandValidationError } from './application-mailbox-validation.ts';
import {
  admitOne,
  claimOne,
  commandInput,
  createIdSource,
  createMailboxClock,
  createMailboxFixture,
  RecordingEventSink,
} from './application-mailbox.test-support.ts';

describe('claiming past the absolute deadline', () => {
  it('refuses to lease a command whose deadline passed, and dead-letters it instead', async () => {
    const { mailbox, clock } = createMailboxFixture({ commandTimeoutMs: 1_000 });
    const commandId = await admitOne(mailbox);

    clock.advance(1_000);
    // Without this the consumer would receive a claim it is no longer allowed to
    // apply, and would only learn that after performing the side effect.
    const result = await mailbox.claim();
    expect(result.status).toBe('empty');

    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('dead-lettered');
    expect(receipt?.failure?.reason).toBe('deadline-exceeded');
    mailbox.dispose();
  });

  it('still leases a command that is inside its deadline', async () => {
    const { mailbox, clock } = createMailboxFixture({ commandTimeoutMs: 1_000 });
    await admitOne(mailbox);
    clock.advance(999);
    const result = await mailbox.claim();
    expect(result.status).toBe('claimed');
    mailbox.dispose();
  });
});

describe('maintenance over a mailbox larger than one scan page', () => {
  it('reaches due work beyond the first page', async () => {
    const total = MAILBOX_MAINTENANCE_SCAN_LIMIT + 25;
    const { mailbox, clock } = createMailboxFixture({
      maxBacklog: total + 10,
      // Deterministic ids that sort in a different order than admission, so the
      // due records really are spread across pages rather than clustered.
      generateId: createIdSource('cmd'),
    });
    for (let index = 0; index < total; index += 1) {
      await admitOne(mailbox, { idempotencyKey: `k-${index}`, availableAfterMs: 1_000 });
    }

    clock.advance(1_000);
    const report = await mailbox.runMaintenance();
    // A single-page scan would have released at most one page's worth and then
    // kept re-reading the same page on every later call.
    expect(report.released).toBe(total);

    const listed = await mailbox.list({ limit: 1_000, states: ['available'] });
    expect(listed.length).toBe(total);
    mailbox.dispose();
  });
});

describe('bounded listing', () => {
  it('reads only what the requested limit needs', async () => {
    const storage = new MemoryStorage();
    let scannedEntries = 0;
    const originalScan = storage.scan.bind(storage);
    storage.scan = async function* (prefix: string, options?: Parameters<typeof originalScan>[1]) {
      for await (const entry of originalScan(prefix, options)) {
        if (prefix.startsWith('appseq:')) scannedEntries += 1;
        yield entry;
      }
    };
    const { mailbox } = createMailboxFixture({ storage, maxBacklog: 500 });
    for (let index = 0; index < 300; index += 1) {
      await admitOne(mailbox, { idempotencyKey: `k-${index}` });
    }

    scannedEntries = 0;
    const listed = await mailbox.list({ limit: 3 });
    expect(listed.map((receipt) => receipt.sequence)).toEqual([0, 1, 2]);
    // Reading every record to sort-then-slice would have touched all 300.
    expect(scannedEntries).toBeLessThanOrEqual(10);
    mailbox.dispose();
  });

  it('returns receipts in FIFO order across pages', async () => {
    const { mailbox } = createMailboxFixture({ maxBacklog: 600 });
    for (let index = 0; index < 250; index += 1) {
      await admitOne(mailbox, { idempotencyKey: `k-${index}` });
    }
    const listed = await mailbox.list({ limit: 250 });
    expect(listed.map((receipt) => receipt.sequence)).toEqual(
      Array.from({ length: 250 }, (_unused, index) => index),
    );
    mailbox.dispose();
  });

  it('skips a listing entry whose record retention already removed', async () => {
    const { mailbox, storage } = createMailboxFixture();
    const commandId = await admitOne(mailbox, { idempotencyKey: 'a' });
    await admitOne(mailbox, { idempotencyKey: 'b' });
    await storage.delete(KEYS.applicationCommand('bureau', 'agent-7', commandId));

    const listed = await mailbox.list();
    expect(listed.map((receipt) => receipt.sequence)).toEqual([1]);
    mailbox.dispose();
  });

  it('retires the listing entry along with the record', async () => {
    const { mailbox, storage, clock } = createMailboxFixture({ terminalRetentionMs: 1_000 });
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    await mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken });

    clock.advance(1_001);
    await mailbox.runMaintenance();

    let remaining = 0;
    for await (const _entry of storage.scan(
      KEYS.applicationCommandBySequencePrefix('bureau', 'agent-7'),
    )) {
      remaining += 1;
    }
    expect(remaining).toBe(0);
    expect(await mailbox.list()).toEqual([]);
    mailbox.dispose();
  });
});

describe('payload snapshotting', () => {
  it('persists the payload as offered, even if the caller mutates it afterwards', async () => {
    const { mailbox } = createMailboxFixture();
    const value: { text: string; extra?: string } = { text: 'stop' };
    const admission = await mailbox.admit(commandInput({ payload: { form: 'inline', value } }));
    expect(admission.status).toBe('admitted');

    // Retaining the caller's reference would have stored these mutated bytes
    // under the earlier digest, and the command would then fail digest
    // verification at the FIFO head and block the mailbox behind it forever.
    value.text = 'go';
    value.extra = 'injected';

    const result = await mailbox.claim();
    expect(result.status).toBe('claimed');
    if (result.status !== 'claimed' || result.claim.payload.form !== 'inline') return;
    expect(result.claim.payload.value).toEqual({ text: 'stop' });
    expect(result.claim.payload.verified).toBe(true);
    mailbox.dispose();
  });
});

describe('durable settlement metadata', () => {
  it.each([
    ['outcome', { outcome: new Map([['a', 1]]) as never }],
    ['progress', { progress: new Set([1]) as never }],
  ])('rejects a non-JSON %s instead of poisoning the record', async (_name, override) => {
    const { mailbox } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    const call =
      'outcome' in override
        ? mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken, ...override })
        : mailbox.renew({ commandId, attemptToken: claim.attemptToken, ...override });
    await expect(call).rejects.toThrow(ApplicationCommandValidationError);

    // The record is untouched and still readable.
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('claimed');
    mailbox.dispose();
  });

  it('rejects non-JSON failure details and an unknown failure reason', async () => {
    const { mailbox } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);

    await expect(
      mailbox.reject({
        commandId,
        attemptToken: claim.attemptToken,
        failure: { reason: 'application', details: new Date() as never },
      }),
    ).rejects.toThrow(/JSON-safe/);
    await expect(
      mailbox.reject({
        commandId,
        attemptToken: claim.attemptToken,
        failure: { reason: 'made-up' as never },
      }),
    ).rejects.toThrow(/failure.reason/);
    await expect(
      mailbox.reject({ commandId, attemptToken: claim.attemptToken, failure: null as never }),
    ).rejects.toThrow(/failure must be an object/);
    mailbox.dispose();
  });

  it('rejects settlement metadata the codec cannot encode at all', async () => {
    const { mailbox } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    await expect(
      mailbox.acknowledge({
        commandId,
        attemptToken: claim.attemptToken,
        outcome: cyclic as never,
      }),
    ).rejects.toThrow(/not encodable/);
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('claimed');
    mailbox.dispose();
  });

  it('accepts and round-trips JSON-safe settlement metadata', async () => {
    const { mailbox } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    await mailbox.renew({
      commandId,
      attemptToken: claim.attemptToken,
      progress: { step: 'phase-1', done: [1, 2] },
    });
    const settled = await mailbox.acknowledge({
      commandId,
      attemptToken: claim.attemptToken,
      outcome: { applied: true, notes: null },
    });
    expect(settled.status === 'settled' && settled.receipt.outcome).toEqual({
      applied: true,
      notes: null,
    });
    mailbox.dispose();
  });
});

describe('injected identifier and clock validation', () => {
  it('refuses an empty or oversized generated identifier before writing anything', async () => {
    const empty = createMailboxFixture({ generateId: () => '' });
    await expect(empty.mailbox.admit(commandInput())).rejects.toThrow(/generateId/);
    empty.mailbox.dispose();

    const oversized = createMailboxFixture({ generateId: () => 'x'.repeat(300) });
    await expect(oversized.mailbox.admit(commandInput())).rejects.toThrow(/generateId/);
    oversized.mailbox.dispose();
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a negative instant', -1],
    ['a fractional instant', 1.5],
  ])('refuses %s as a maintenance instant before reading or writing', async (_name, instant) => {
    const { mailbox } = createMailboxFixture({ terminalRetentionMs: 1_000 });
    const commandId = await admitOne(mailbox);
    await expect(mailbox.runMaintenance(instant)).rejects.toThrow(
      ApplicationCommandValidationError,
    );
    // Nothing was swept and nothing was terminalized.
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('available');
    mailbox.dispose();
  });
});

describe('cancellation across sibling handles in one process', () => {
  it('aborts a claimant holding a different handle onto the same mailbox', async () => {
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
    expect(claim.signal.aborted).toBe(false);

    // Two handles onto the same durable mailbox are the same mailbox. Without a
    // shared registry the claimant's signal would never fire and it would learn
    // of the cancellation only through renewal — the cross-process fallback.
    await controller.requestCancellation({ commandId, reason: 'sibling handle' });
    expect(claim.signal.aborted).toBe(true);

    consumer.dispose();
    controller.dispose();
  });

  it('does not let one handle abort another handle attempts on disposal', async () => {
    const storage = new MemoryStorage();
    const clock = createMailboxClock();
    const worker = createMailboxFixture({
      storage,
      clock,
      generateId: createIdSource('w'),
    }).mailbox;
    const observer = createMailboxFixture({
      storage,
      clock,
      generateId: createIdSource('o'),
    }).mailbox;

    await admitOne(worker);
    const claim = await claimOne(worker);

    observer.dispose();
    expect(claim.signal.aborted).toBe(false);

    worker.dispose();
    expect(claim.signal.aborted).toBe(true);
  });
});

describe('disposal racing a claim commit', () => {
  it('hands back an already-aborted signal rather than a live claim from a disposed mailbox', async () => {
    const storage = new MemoryStorage();
    const { mailbox } = createMailboxFixture({ storage });
    await admitOne(mailbox);

    // Dispose in the window between the claim's compare-and-swap and the
    // controller registration. Registering an un-aborted controller then would
    // start work during shutdown, and no later `dispose()` could reach it.
    const originalBatch = storage.conditionalBatch.bind(storage);
    let disposedDuringCommit = false;
    storage.conditionalBatch = async (conditions, operations): Promise<boolean> => {
      const committed = await originalBatch(conditions, operations);
      if (!disposedDuringCommit) {
        disposedDuringCommit = true;
        mailbox.dispose();
      }
      return committed;
    };

    const result = await mailbox.claim();
    expect(result.status).toBe('claimed');
    if (result.status !== 'claimed') return;
    expect(result.claim.signal.aborted).toBe(true);
  });
});

describe('a mismatched event sink', () => {
  it('refuses to report a commit that landed in a different backend', async () => {
    const mailboxStorage = new MemoryStorage();
    const elsewhere = new MemoryStorage();
    // A feed accidentally built over a different Storage would apply the
    // mailbox's own operations there and return success, so `admit()` would hand
    // back a receipt for a command that never existed here.
    const events = new RecordingEventSink(elsewhere);
    const { mailbox } = createMailboxFixture({ storage: mailboxStorage, events });

    await expect(mailbox.admit(commandInput())).rejects.toThrow(/different storage backend/);
    expect(await mailbox.list()).toEqual([]);
    mailbox.dispose();
  });

  it('accepts a sink over the mailbox storage', async () => {
    const storage = new MemoryStorage();
    const events = new RecordingEventSink(storage);
    const { mailbox } = createMailboxFixture({ storage, events });
    await admitOne(mailbox);
    await admitOne(mailbox, { idempotencyKey: 'second' });
    const listed = await mailbox.list();
    expect(listed.length).toBe(2);
    mailbox.dispose();
  });
});

describe('waiting inside the caller budget', () => {
  it('does not overshoot the timeout when the poll interval is longer than it', async () => {
    useFakeTimers();
    const { mailbox, clock } = createMailboxFixture();
    await admitOne(mailbox, { availableAfterMs: 10_000 });

    // A 5-second interval against a 10ms budget must sleep only the 10ms that is
    // left, or an observation taken after the sleep would land far past the bound
    // the caller asked for and could report a late success.
    const waiting = mailbox.waitForAvailable({ timeoutMs: 10, pollIntervalMs: 5_000 });
    clock.advance(10);
    await advanceTimersByTime(10);
    expect(await waiting).toBe(false);
    mailbox.dispose();
    restoreRealTimers();
  });

  it('reports work that is already due even with the zero-millisecond default', async () => {
    const { mailbox } = createMailboxFixture();
    await admitOne(mailbox);
    expect(await mailbox.waitForAvailable()).toBe(true);
    mailbox.dispose();
  });
});
