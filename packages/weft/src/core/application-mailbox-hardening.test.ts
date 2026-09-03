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

import type { Storage } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import {
  advanceTimersByTime,
  flushMicrotasks,
  restoreRealTimers,
  useFakeTimers,
} from '../testing/fake-timers.test-support.ts';
import { WaitBudgetElapsedError } from './application-mailbox-abort.ts';
import {
  AttemptRegistry,
  type AttemptRegistration,
} from './application-mailbox-attempt-registry.ts';
import type {
  ApplicationCommandCleanupResult,
  ApplicationCommandRejection,
} from './application-mailbox-contract.ts';
import { encodeApplicationReadyEntry } from './application-mailbox-index-codec.ts';
import {
  ApplicationMailboxContentionError,
  attemptControllerRegistry,
  hasAttemptControllerScope,
  MAILBOX_MAINTENANCE_MAX_PAGES,
} from './application-mailbox-internals.ts';
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
import { ApplicationMailbox } from './application-mailbox.ts';
import { computePayloadDigest } from './application-payload-digest.ts';
import { decode, encode } from './codec.ts';
import { PersistedDataCorruptError } from './persisted-data-incompatible-error.ts';

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

  it('dead-letters a backing-off head past its deadline instead of holding forever', async () => {
    const { mailbox, clock } = createMailboxFixture({
      commandTimeoutMs: 5_000,
      retryBackoffMs: 100_000,
      maxAttempts: 5,
    });
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    // Schedule a retry whose backoff lands past the absolute deadline.
    await mailbox.reject({
      commandId,
      attemptToken: claim.attemptToken,
      failure: { reason: 'application' },
      retry: true,
    });
    const scheduled = await mailbox.receipt(commandId);
    expect(scheduled?.state).toBe('accepted');

    clock.advance(5_000);
    // Checking availability before the deadline would report `held` forever: the
    // head can never come due, and `claim()` would never terminalize it either,
    // so a manual-maintenance host would block on it permanently.
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
    const total = 120;
    const { mailbox, clock } = createMailboxFixture({
      maxBacklog: total + 10,
      // Small pages, so the mailbox spans many of them.
      maintenanceBatchSize: 10,
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

describe('the delivery-index fence', () => {
  it('discards a stale entry pointing at a command that is already claimed', async () => {
    const { mailbox, storage } = createMailboxFixture();
    const first = await admitOne(mailbox, { idempotencyKey: 'a' });
    await admitOne(mailbox, { idempotencyKey: 'b' });
    const claim = await claimOne(mailbox);
    expect(claim.commandId).toBe(first);

    // Re-add the entry the claim removed, standing in for a crash artifact or a
    // reader holding a stale view of the index.
    await storage.put(
      KEYS.applicationCommandReady('bureau', 'agent-7', 0),
      encodeApplicationReadyEntry(first),
    );

    const next = await mailbox.claim();
    expect(next.status).toBe('claimed');
    if (next.status !== 'claimed') return;
    expect(next.claim.receipt.sequence).toBe(1);
    expect(await storage.get(KEYS.applicationCommandReady('bureau', 'agent-7', 0))).toBeNull();
    mailbox.dispose();
  });

  it('refuses to discard an entry when the command changed under the reader', async () => {
    const { mailbox, storage, clock } = createMailboxFixture({
      visibilityTimeoutMs: 1_000,
      retryBackoffMs: 1,
      maxAttempts: 5,
    });
    const commandId = await admitOne(mailbox);
    await claimOne(mailbox);
    const readyKey = KEYS.applicationCommandReady('bureau', 'agent-7', 0);
    // A stale entry for the claimed record, as the ABA window would leave.
    await storage.put(readyKey, encodeApplicationReadyEntry(commandId));

    // Between this reader observing the claimed record and its delete landing,
    // maintenance reclaims the lease and re-adds a byte-identical entry. Fencing
    // on the entry alone would delete that newly valid entry and lose the command
    // from the FIFO for good.
    const memoryStorage = storage as MemoryStorage;
    const originalBatch = memoryStorage.conditionalBatch.bind(memoryStorage);
    let reclaimed = false;
    memoryStorage.conditionalBatch = async (conditions, operations): Promise<boolean> => {
      if (!reclaimed && operations.some((operation) => operation.key === readyKey)) {
        reclaimed = true;
        clock.advance(1_001);
        await mailbox.runMaintenance();
        await storage.put(readyKey, encodeApplicationReadyEntry(commandId));
      }
      return originalBatch(conditions, operations);
    };

    await mailbox.claim();
    // The entry survived: the record's bytes changed, so the stale delete lost.
    expect(await storage.get(readyKey)).not.toBeNull();
    expect(await mailbox.receipt(commandId)).not.toBeNull();
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

    // Dispose while the claim's compare-and-swap is in flight. The attempt is
    // already registered by then, so `dispose()` itself aborts it; the claim
    // must still come back with that aborted signal rather than a live one.
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

  it('registers an already-aborted controller when disposed before the lease commits', async () => {
    const storage = new MemoryStorage();
    const { mailbox } = createMailboxFixture({ storage });
    await admitOne(mailbox);

    // Dispose during the record read, before the attempt is registered. The
    // registration then finds a disposed handle and hands back an aborted
    // controller instead of a live signal nothing could ever reach.
    const originalGet = storage.get.bind(storage);
    let disposedDuringRead = false;
    storage.get = async (key: string): Promise<Uint8Array | null> => {
      const value = await originalGet(key);
      if (!disposedDuringRead && key.startsWith('appcmd:')) {
        disposedDuringRead = true;
        mailbox.dispose();
      }
      return value;
    };

    const result = await mailbox.claim();
    expect(result.status).toBe('claimed');
    if (result.status !== 'claimed') return;
    expect(result.claim.signal.aborted).toBe(true);
    expect(result.claim.signal.reason).toBeInstanceOf(Error);
    expect((result.claim.signal.reason as Error).message).toContain('disposed');
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

describe('second-round hardening', () => {
  it('digests the snapshot, so a mutation during the digest await cannot diverge', async () => {
    const { mailbox } = createMailboxFixture();
    const value: { text: string } = { text: 'stop' };
    const admission = mailbox.admit(commandInput({ payload: { form: 'inline', value } }));
    // Mutate while Web Crypto is still pending. Snapshotting after the digest
    // would persist these bytes under the earlier digest.
    value.text = 'mutated-during-await';
    const admitted = await admission;
    expect(admitted.status).toBe('admitted');

    const claimed = await mailbox.claim();
    expect(claimed.status).toBe('claimed');
    if (claimed.status !== 'claimed' || claimed.claim.payload.form !== 'inline') return;
    expect(claimed.claim.payload.value).toEqual({ text: 'stop' });
    mailbox.dispose();
  });

  it('resumes past the page cap instead of re-reading the same prefix', async () => {
    // One record per page, so the mailbox is larger than the page cap and a
    // single pass cannot reach the end.
    const total = MAILBOX_MAINTENANCE_MAX_PAGES + 20;
    const { mailbox, clock } = createMailboxFixture({
      maxBacklog: total + 10,
      maintenanceBatchSize: 1,
    });
    for (let index = 0; index < total; index += 1) {
      await admitOne(mailbox, { idempotencyKey: `k-${index}`, availableAfterMs: 1_000 });
    }
    clock.advance(1_000);

    const first = await mailbox.runMaintenance();
    expect(first.released).toBe(MAILBOX_MAINTENANCE_MAX_PAGES);
    // Without a carried cursor the second pass would re-read the same first
    // pages and never reach the tail.
    const second = await mailbox.runMaintenance();
    expect(first.released + second.released).toBe(total);
    expect(await mailbox.list({ limit: 1_000, states: ['accepted'] })).toEqual([]);
    mailbox.dispose();
  });

  it('verifies each sink separately, not just each backend', async () => {
    const storage = new MemoryStorage();
    const good = createMailboxFixture({ storage, events: new RecordingEventSink(storage) }).mailbox;
    await admitOne(good);

    // The backend is now "verified" for the first sink. A second mailbox on the
    // same backend with a sink over a different store must still be caught.
    const bad = createMailboxFixture({
      storage,
      resourceId: 'agent-8',
      events: new RecordingEventSink(new MemoryStorage()),
    }).mailbox;
    await expect(bad.admit(commandInput())).rejects.toThrow(/different storage backend/);
    good.dispose();
    bad.dispose();
  });

  it('rejects an injected clock that cannot produce a durable timestamp', async () => {
    for (const instant of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const { mailbox } = createMailboxFixture({ now: () => instant });
      await expect(mailbox.admit(commandInput())).rejects.toThrow(
        ApplicationCommandValidationError,
      );
      mailbox.dispose();
    }
  });

  it('rejects a derived timestamp that leaves the safe-integer range', async () => {
    // Both the clock reading and the timeout are individually valid; their sum is
    // not, and the record decoder would reject the result.
    const nearCeiling = Number.MAX_SAFE_INTEGER - 1_000;
    const { mailbox } = createMailboxFixture({ now: () => nearCeiling });
    await expect(mailbox.admit(commandInput({ commandTimeoutMs: 60_000 }))).rejects.toThrow(
      /safe-integer millisecond range/,
    );
    mailbox.dispose();
  });

  it('reflects a request abort that races the claim commit', async () => {
    const storage = new MemoryStorage();
    const { mailbox } = createMailboxFixture({ storage });
    await admitOne(mailbox);
    const controller = new AbortController();

    // Abort after the compare-and-swap has already committed. The lease is
    // durable either way, but returning a live signal would hide the abort from
    // the caller that raised it.
    const originalBatch = storage.conditionalBatch.bind(storage);
    let abortedDuringCommit = false;
    storage.conditionalBatch = async (conditions, operations): Promise<boolean> => {
      const committed = await originalBatch(conditions, operations);
      if (!abortedDuringCommit) {
        abortedDuringCommit = true;
        controller.abort();
      }
      return committed;
    };

    const result = await mailbox.claim({ signal: controller.signal });
    expect(result.status).toBe('claimed');
    if (result.status !== 'claimed') return;
    expect(result.claim.signal.aborted).toBe(true);
    mailbox.dispose();
  });

  it('rejects identity components containing an unpaired surrogate', async () => {
    const { mailbox } = createMailboxFixture();
    // A lone surrogate passes a byte-length check but makes `encodeURIComponent`
    // throw a raw URIError when the storage key is built.
    await expect(mailbox.admit(commandInput({ caller: 'user:\ud800' }))).rejects.toThrow(
      /well-formed Unicode/,
    );
    expect(() => createMailboxFixture({ namespace: 'bureau\udfff' })).toThrow(
      /well-formed Unicode/,
    );
    mailbox.dispose();
  });

  it('bounds the cancellation reason', async () => {
    const { mailbox } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    await expect(
      mailbox.requestCancellation({ commandId, reason: 'x'.repeat(4_096) }),
    ).rejects.toThrow(ApplicationCommandValidationError);
    mailbox.dispose();
  });

  it.each([
    ['a NaN timeout', { timeoutMs: Number.NaN }],
    ['an infinite timeout', { timeoutMs: Number.POSITIVE_INFINITY }],
    ['a zero poll interval', { timeoutMs: 10, pollIntervalMs: 0 }],
  ])('rejects %s rather than waiting forever', async (_name, options) => {
    const { mailbox } = createMailboxFixture();
    await expect(mailbox.waitForAvailable(options)).rejects.toThrow(
      ApplicationCommandValidationError,
    );
    mailbox.dispose();
  });

  it('does not advertise a due head that is already past its deadline', async () => {
    const { mailbox, clock } = createMailboxFixture({ commandTimeoutMs: 1_000 });
    await admitOne(mailbox);
    expect(await mailbox.waitForAvailable()).toBe(true);

    clock.advance(1_000);
    // `claim()` would terminalize this head and report `empty`, so reporting it
    // as available would advertise work that does not exist.
    expect(await mailbox.waitForAvailable()).toBe(false);
    mailbox.dispose();
  });

  it('stops mid-sleep when the wait is aborted between polls', async () => {
    useFakeTimers();
    const { mailbox } = createMailboxFixture();
    await admitOne(mailbox, { availableAfterMs: 10_000 });
    const controller = new AbortController();

    // Schedule the abort on the same fake clock so it lands strictly inside the
    // poll sleep rather than between iterations: the sleep itself has to unwind,
    // not run to completion and be caught by the next loop check.
    setTimeout(() => {
      controller.abort();
    }, 20);
    const waiting = mailbox.waitForAvailable({
      timeoutMs: 60_000,
      pollIntervalMs: 50,
      signal: controller.signal,
    });
    // Enough turns for the wait to get past its first observation and actually
    // be sitting in the poll sleep when the abort timer fires.
    await flushMicrotasks(50);
    await advanceTimersByTime(25);
    expect(await waiting).toBe(false);
    mailbox.dispose();
    restoreRealTimers();
  });

  it('reports false from waitForAvailable when the signal is already aborted', async () => {
    const { mailbox } = createMailboxFixture();
    await admitOne(mailbox);
    // Work IS due; the abort still outranks it, or a shutdown caller would be
    // told to start new work.
    expect(await mailbox.waitForAvailable({ signal: AbortSignal.abort() })).toBe(false);
    mailbox.dispose();
  });

  it('dead-letters rather than cancelling a command past its deadline', async () => {
    const { mailbox, clock } = createMailboxFixture({ commandTimeoutMs: 1_000 });
    const commandId = await admitOne(mailbox);
    clock.advance(1_000);

    // The disposition must not depend on whether cancellation or maintenance
    // happened to win the race.
    const cancelled = await mailbox.requestCancellation({ commandId });
    expect(cancelled.status).toBe('already-terminal');
    await mailbox.runMaintenance();
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('dead-lettered');
    expect(receipt?.failure?.reason).toBe('deadline-exceeded');
    mailbox.dispose();
  });

  it('forgets an attempt once it settles, so ownership cannot grow without bound', async () => {
    const { mailbox } = createMailboxFixture({ maxBacklog: 10 });
    for (let index = 0; index < 5; index += 1) {
      const commandId = await admitOne(mailbox, { idempotencyKey: `k-${index}` });
      const claim = await claimOne(mailbox);
      await mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken });
    }
    // Every attempt settled, so nothing should remain registered for this scope.
    const registry = attemptControllerRegistry(mailbox.storage, 'bureau', 'agent-7');
    expect(registry.size).toBe(0);
    mailbox.dispose();
  });

  it('freezes nested receipt metadata, not just the receipt', async () => {
    const { mailbox } = createMailboxFixture();
    const commandId = await admitOne(mailbox, {
      causation: { correlationId: 'conv-7' },
    });
    const receipt = await mailbox.receipt(commandId);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt?.causation)).toBe(true);
    mailbox.dispose();
  });

  it('digests a Map identically regardless of insertion order when keys tie', async () => {
    // Two distinct keys that encode identically: a stable sort on key bytes alone
    // would leave insertion order observable in the digest.
    const left = new Map<unknown, unknown>([
      [{}, 'first'],
      [{}, 'second'],
    ]);
    const right = new Map<unknown, unknown>([
      [{}, 'second'],
      [{}, 'first'],
    ]);
    expect(await computePayloadDigest(left)).toBe(await computePayloadDigest(right));
  });
});

describe('third-round hardening', () => {
  it('dead-letters an expired command when cancellation reaches it first', async () => {
    const { mailbox, clock } = createMailboxFixture({
      commandTimeoutMs: 1_000,
      visibilityTimeoutMs: 10_000,
    });
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    clock.advance(1_000);

    // Reporting `already-terminal` while the record was still `claimed` would
    // leave a live lease and an un-aborted local signal behind a receipt that
    // says the command is over.
    const result = await mailbox.requestCancellation({ commandId });
    expect(result.status).toBe('already-terminal');
    expect(result.status === 'already-terminal' && result.receipt.state).toBe('dead-lettered');
    expect(claim.signal.aborted).toBe(true);
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('dead-lettered');
    mailbox.dispose();
  });

  it('refuses a settlement whose storage read crossed the deadline', async () => {
    const storage = new MemoryStorage();
    const clock = createMailboxClock();
    const { mailbox } = createMailboxFixture({
      storage,
      clock,
      commandTimeoutMs: 1_000,
      visibilityTimeoutMs: 10_000,
    });
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);

    // The deadline passes DURING the settlement's own storage read. A decision
    // made on the clock reading taken before the read would commit a success the
    // contract says must be `deadline-exceeded`.
    const originalGet = storage.get.bind(storage);
    let crossed = false;
    storage.get = async (key: string): Promise<Uint8Array | null> => {
      const value = await originalGet(key);
      if (!crossed && key.startsWith('appcmd:')) {
        crossed = true;
        clock.advance(1_000);
      }
      return value;
    };

    const settled = await mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken });
    expect(settled.status).toBe('deadline-exceeded');
    mailbox.dispose();
  });

  it('keeps fencing intact even when the injected id generator repeats', async () => {
    // A generator that returns the same value forever. Fencing must not depend
    // on the generator: the attempt number makes each token unique per command.
    const { mailbox, clock } = createMailboxFixture({
      generateId: () => 'repeat',
      visibilityTimeoutMs: 500,
      retryBackoffMs: 1,
      maxAttempts: 5,
    });
    const commandId = await admitOne(mailbox);
    const stale = await claimOne(mailbox);

    clock.advance(501);
    await mailbox.runMaintenance();
    clock.advance(10);
    const current = await claimOne(mailbox);
    expect(current.attemptToken).not.toBe(stale.attemptToken);

    const settled = await mailbox.acknowledge({ commandId, attemptToken: stale.attemptToken });
    expect(settled.status).toBe('stale');
    mailbox.dispose();
  });

  it('rejects a storage backend without snapshot scans', () => {
    class BestEffortScans extends MemoryStorage {
      override capabilities(): ReturnType<MemoryStorage['capabilities']> {
        return { ...super.capabilities(), scanConsistency: 'best-effort' };
      }
    }
    expect(
      () =>
        new ApplicationMailbox({
          storage: new BestEffortScans(),
          namespace: 'n',
          resourceId: 'r',
        }),
    ).toThrow(/snapshot scan consistency/);
  });

  it('verifies a sink by a probe it must commit locally, not by key presence', async () => {
    const storage = new MemoryStorage();
    const { mailbox } = createMailboxFixture({ storage });
    const commandId = await admitOne(mailbox);
    mailbox.dispose();

    // A sink over a different backend that holds a byte-identical copy of the
    // local records, first used for a TRANSITION on an existing record. The key
    // already exists locally, so a presence check on the record would pass
    // against the pre-transition bytes and cache the bad sink as verified. The
    // sink's probe lands on the other backend and is never observed here.
    const elsewhere = new MemoryStorage();
    for await (const [key, value] of storage.scan('')) {
      await elsewhere.put(key, value);
    }
    const withBadSink = createMailboxFixture({
      storage,
      events: new RecordingEventSink(elsewhere),
    }).mailbox;
    await expect(withBadSink.requestCancellation({ commandId })).rejects.toThrow(
      /different storage backend/,
    );
    // The local record is untouched.
    const receipt = await withBadSink.receipt(commandId);
    expect(receipt?.state).toBe('available');
    withBadSink.dispose();
  });

  it('rejects a retry whose backoff would leave the safe-integer range', async () => {
    const nearCeiling = Number.MAX_SAFE_INTEGER - 5_000;
    const { mailbox } = createMailboxFixture({
      now: () => nearCeiling,
      commandTimeoutMs: 4_000,
      retryBackoffMs: 60_000,
      maxRetryBackoffMs: 60_000,
      maxAttempts: 5,
    });
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    await expect(
      mailbox.reject({
        commandId,
        attemptToken: claim.attemptToken,
        failure: { reason: 'application' },
        retry: true,
      }),
    ).rejects.toThrow(/safe-integer millisecond range/);
    mailbox.dispose();
  });

  it('releases ownership from the claiming handle when a sibling settles', async () => {
    const storage = new MemoryStorage();
    const clock = createMailboxClock();
    const claimant = createMailboxFixture({
      storage,
      clock,
      generateId: createIdSource('c'),
    }).mailbox;
    const settler = createMailboxFixture({
      storage,
      clock,
      generateId: createIdSource('s'),
    }).mailbox;
    for (let index = 0; index < 4; index += 1) {
      const commandId = await admitOne(claimant, { idempotencyKey: `k-${index}` });
      const claim = await claimOne(claimant);
      await settler.acknowledge({ commandId, attemptToken: claim.attemptToken });
    }
    // Every attempt was settled by the OTHER handle. The claimant's own
    // registry entries have to be gone all the same.
    expect(attemptControllerRegistry(storage, 'bureau', 'agent-7').size).toBe(0);
    claimant.dispose();
    settler.dispose();
  });

  it('bounds durable JSON metadata', async () => {
    const { mailbox } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    await expect(
      mailbox.acknowledge({
        commandId,
        attemptToken: claim.attemptToken,
        outcome: { blob: 'x'.repeat(70_000) },
      }),
    ).rejects.toThrow(/durable metadata ceiling/);
    mailbox.dispose();
  });

  it('rejects a null causation with the public validation error', async () => {
    const { mailbox } = createMailboxFixture();
    await expect(mailbox.admit(commandInput({ causation: null as never }))).rejects.toThrow(
      ApplicationCommandValidationError,
    );
    mailbox.dispose();
  });

  it('rejects a generated identifier containing an unpaired surrogate', async () => {
    const { mailbox } = createMailboxFixture({ generateId: () => 'id-\ud800' });
    await expect(mailbox.admit(commandInput())).rejects.toThrow(ApplicationCommandValidationError);
    mailbox.dispose();
  });
});

describe('fourth-round hardening', () => {
  it('rejects a storage backend without linearizable read-after-write', () => {
    class SessionReads extends MemoryStorage {
      override capabilities(): ReturnType<MemoryStorage['capabilities']> {
        return { ...super.capabilities(), readAfterWrite: 'session' };
      }
    }
    expect(
      () =>
        new ApplicationMailbox({
          storage: new SessionReads(),
          namespace: 'n',
          resourceId: 'r',
        }),
    ).toThrow(/linearizable read-after-write/);
  });

  it('keeps attempt tokens unique across commands when the generator repeats', async () => {
    // Unique ids for the two admissions (a repeated command id fails admission's
    // own compare-and-swap, which is a different guarantee), then a generator
    // that repeats forever for every claim.
    let generated = 0;
    const { mailbox } = createMailboxFixture({
      generateId: () => {
        generated += 1;
        return generated <= 2 ? `command-${generated}` : 'repeat';
      },
    });
    const first = await admitOne(mailbox, { idempotencyKey: 'a' });
    const second = await admitOne(mailbox, { idempotencyKey: 'b' });
    const firstClaim = await claimOne(mailbox);
    const secondClaim = await claimOne(mailbox);
    expect(firstClaim.commandId).toBe(first);
    expect(secondClaim.commandId).toBe(second);
    expect(firstClaim.attemptToken).not.toBe(secondClaim.attemptToken);

    // The registry is mailbox-wide: with colliding tokens, cancelling the first
    // command would abort the second claim's signal, and the first token could
    // settle the second command.
    const cancelled = await mailbox.requestCancellation({ commandId: first });
    expect(cancelled.status).toBe('requested');
    expect(firstClaim.signal.aborted).toBe(true);
    expect(secondClaim.signal.aborted).toBe(false);
    const settled = await mailbox.acknowledge({
      commandId: second,
      attemptToken: firstClaim.attemptToken,
    });
    expect(settled.status).toBe('stale');
    mailbox.dispose();
  });

  it('withholds a claim whose commit completed past the deadline', async () => {
    const storage = new MemoryStorage();
    const clock = createMailboxClock();
    const { mailbox } = createMailboxFixture({
      storage,
      clock,
      commandTimeoutMs: 1_000,
      visibilityTimeoutMs: 10_000,
    });
    const commandId = await admitOne(mailbox);

    // The deadline passes while the lease commit is in flight (a fleet-event sink
    // retrying its compare-and-swap, say). The claim was checked against the
    // clock before the commit, so without a recheck the caller would receive
    // live work the contract already calls expired.
    const original = storage.conditionalBatch.bind(storage);
    let crossed = false;
    storage.conditionalBatch = async (
      ...args: Parameters<MemoryStorage['conditionalBatch']>
    ): Promise<boolean> => {
      const result = await original(...args);
      if (!crossed) {
        crossed = true;
        clock.advance(1_000);
      }
      return result;
    };

    const claim = await mailbox.claim();
    expect(claim.status).toBe('empty');
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('dead-lettered');
    expect(receipt?.failure?.reason).toBe('deadline-exceeded');
    mailbox.dispose();
  });

  it('reserves mailbox-owned failure reasons for mailbox transitions', async () => {
    const { mailbox } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    for (const reason of ['attempts-exhausted', 'deadline-exceeded', 'cancelled'] as const) {
      await expect(
        mailbox.reject({
          commandId,
          attemptToken: claim.attemptToken,
          failure: { reason } as unknown as ApplicationCommandRejection,
          retry: false,
        }),
      ).rejects.toThrow(ApplicationCommandValidationError);
    }
    // The claim is still live: nothing above was persisted.
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('claimed');
    mailbox.dispose();
  });

  it.each([['maxAttempts'], ['visibilityTimeoutMs']])(
    'fails closed on a persisted record with %s of zero',
    async (field) => {
      const { mailbox, storage } = createMailboxFixture();
      const commandId = await admitOne(mailbox);
      const key = KEYS.applicationCommand('bureau', 'agent-7', commandId);
      const bytes = await storage.get(key);
      const record = decode(bytes as Uint8Array) as Record<string, unknown>;
      await storage.put(key, encode({ ...record, [field]: 0 }));
      await expect(mailbox.claim()).rejects.toThrow(PersistedDataCorruptError);
      mailbox.dispose();
    },
  );
});

describe('fifth-round hardening', () => {
  it('admits exactly once when a sibling claims during the first sink verification', async () => {
    const storage = new MemoryStorage();
    const events = new RecordingEventSink(storage);
    const { mailbox } = createMailboxFixture({ storage, events });
    const sibling = createMailboxFixture({ storage, events }).mailbox;

    // The sink's first commit is followed by a verification read. A sibling that
    // claims the new command in between changes the record's bytes; the old
    // byte comparison then reported a lost admission and a keyless admit retried
    // into a second command. The probe key is untouched by that claim.
    const originalGet = storage.get.bind(storage);
    let raced = false;
    storage.get = async (key: string): Promise<Uint8Array | null> => {
      if (!raced && key.startsWith('appprobe:')) {
        raced = true;
        await sibling.claim();
      }
      return originalGet(key);
    };

    const admission = await mailbox.admit(commandInput());
    expect(admission.status).toBe('admitted');
    expect(raced).toBe(true);
    const listed = await mailbox.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.state).toBe('claimed');
    // The probe is single-use and gone.
    let probes = 0;
    for await (const _entry of storage.scan('appprobe:')) probes += 1;
    expect(probes).toBe(0);
    sibling.dispose();
    mailbox.dispose();
  });

  it('refuses a renewal whose commit crossed the deadline', async () => {
    const storage = new MemoryStorage();
    const clock = createMailboxClock();
    const { mailbox } = createMailboxFixture({
      storage,
      clock,
      commandTimeoutMs: 1_000,
      visibilityTimeoutMs: 10_000,
    });
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);

    const original = storage.conditionalBatch.bind(storage);
    let crossed = false;
    storage.conditionalBatch = async (
      ...args: Parameters<MemoryStorage['conditionalBatch']>
    ): Promise<boolean> => {
      const result = await original(...args);
      if (!crossed) {
        crossed = true;
        clock.advance(1_000);
      }
      return result;
    };

    const renewal = await mailbox.renew({ commandId, attemptToken: claim.attemptToken });
    expect(renewal.status).toBe('deadline-exceeded');
    expect(renewal.status === 'deadline-exceeded' && renewal.receipt.state).toBe('dead-lettered');
    expect(claim.signal.aborted).toBe(true);
    mailbox.dispose();
  });

  it('does not report due work for a head claimed between the index and record reads', async () => {
    const storage = new MemoryStorage();
    const { mailbox } = createMailboxFixture({ storage, generateId: createIdSource('w') });
    const other = createMailboxFixture({ storage, generateId: createIdSource('o') }).mailbox;
    await admitOne(mailbox);

    const originalGet = storage.get.bind(storage);
    let raced = false;
    storage.get = async (key: string): Promise<Uint8Array | null> => {
      if (!raced && key.startsWith('appcmd:')) {
        raced = true;
        await other.claim();
      }
      return originalGet(key);
    };

    expect(await mailbox.waitForAvailable({ timeoutMs: 0 })).toBe(false);
    expect(raced).toBe(true);
    other.dispose();
    mailbox.dispose();
  });

  it('rejects a wait deadline outside the safe-integer range', async () => {
    const { mailbox } = createMailboxFixture({ now: () => Number.MAX_SAFE_INTEGER - 5_000 });
    await expect(mailbox.waitForAvailable({ timeoutMs: 10_000 })).rejects.toThrow(
      /safe-integer millisecond range/,
    );
    await expect(mailbox.awaitCleanup({ commandId: 'c', timeoutMs: 10_000 })).rejects.toThrow(
      /safe-integer millisecond range/,
    );
    mailbox.dispose();
  });

  it('rejects a malformed command id with the public validation error', async () => {
    const { mailbox } = createMailboxFixture();
    await expect(mailbox.receipt('id-\ud800')).rejects.toThrow(ApplicationCommandValidationError);
    await expect(mailbox.requestCancellation({ commandId: 'x'.repeat(300) })).rejects.toThrow(
      ApplicationCommandValidationError,
    );
    await expect(mailbox.cleanupState('')).rejects.toThrow(ApplicationCommandValidationError);
    mailbox.dispose();
  });

  it('releases the per-scope controller registry when the last handle is disposed', async () => {
    const storage = new MemoryStorage();
    const first = createMailboxFixture({ storage }).mailbox;
    const second = createMailboxFixture({ storage }).mailbox;
    await admitOne(first);
    const claim = await claimOne(first);
    expect(hasAttemptControllerScope(storage, 'bureau', 'agent-7')).toBe(true);
    second.dispose();
    // One handle and one live attempt remain.
    expect(hasAttemptControllerScope(storage, 'bureau', 'agent-7')).toBe(true);
    await first.acknowledge({ commandId: claim.commandId, attemptToken: claim.attemptToken });
    first.dispose();
    expect(hasAttemptControllerScope(storage, 'bureau', 'agent-7')).toBe(false);
  });
});

describe('sixth-round hardening', () => {
  it('keeps a committed sink-backed admission when probe cleanup fails', async () => {
    const storage = new MemoryStorage();
    const events = new RecordingEventSink(storage);
    const { mailbox } = createMailboxFixture({ storage, events });
    const originalDelete = storage.delete.bind(storage);
    storage.delete = async (key: string): Promise<void> => {
      if (key.startsWith('appprobe:')) throw new Error('transient');
      return originalDelete(key);
    };

    // The transition and its event are durable before the probe is cleaned up;
    // a cleanup failure must not turn that into a rejection the caller retries.
    const admission = await mailbox.admit(commandInput());
    expect(admission.status).toBe('admitted');
    expect(await mailbox.list()).toHaveLength(1);
    let probes = 0;
    for await (const _entry of storage.scan('appprobe:')) probes += 1;
    expect(probes).toBe(1);
    mailbox.dispose();
  });

  it('accepts a generated identifier at the byte ceiling for attempt tokens', async () => {
    const ceiling = 'a'.repeat(256);
    const { mailbox } = createMailboxFixture({ generateId: () => ceiling });
    await admitOne(mailbox);
    const claim = await mailbox.claim();
    expect(claim.status).toBe('claimed');
    expect(claim.status === 'claimed' && claim.claim.attemptToken.endsWith(ceiling)).toBe(true);
    mailbox.dispose();
  });

  it("fails closed on a record stored under another command's key", async () => {
    const { mailbox, storage } = createMailboxFixture({ generateId: createIdSource('c') });
    const first = await admitOne(mailbox, { idempotencyKey: 'a' });
    const second = await admitOne(mailbox, { idempotencyKey: 'b' });
    const bytes = await storage.get(KEYS.applicationCommand('bureau', 'agent-7', first));
    await storage.put(KEYS.applicationCommand('bureau', 'agent-7', second), bytes as Uint8Array);
    await expect(mailbox.receipt(second)).rejects.toThrow(PersistedDataCorruptError);
    mailbox.dispose();
  });

  it('aborts a claim cancelled between its lease commit and its return', async () => {
    const storage = new MemoryStorage();
    const { mailbox } = createMailboxFixture({ storage, generateId: createIdSource('m') });
    const sibling = createMailboxFixture({ storage, generateId: createIdSource('s') }).mailbox;
    const commandId = await admitOne(mailbox);

    const original = storage.conditionalBatch.bind(storage);
    let raced = false;
    storage.conditionalBatch = async (
      ...args: Parameters<MemoryStorage['conditionalBatch']>
    ): Promise<boolean> => {
      const result = await original(...args);
      if (!raced) {
        raced = true;
        // The lease is durable; the claim has not returned yet.
        const cancelled = await sibling.requestCancellation({ commandId });
        expect(cancelled.status).toBe('requested');
      }
      return result;
    };

    const claim = await mailbox.claim();
    expect(claim.status).toBe('claimed');
    expect(claim.status === 'claimed' && claim.claim.signal.aborted).toBe(true);
    sibling.dispose();
    mailbox.dispose();
  });

  it('stores an explicit null progress marker', async () => {
    const { mailbox } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    await mailbox.renew({ commandId, attemptToken: claim.attemptToken, progress: { step: 1 } });
    const withMarker = await mailbox.receipt(commandId);
    expect(withMarker?.progress).toEqual({ step: 1 });
    await mailbox.renew({ commandId, attemptToken: claim.attemptToken, progress: null });
    const cleared = await mailbox.receipt(commandId);
    expect(cleared?.progress).toBeNull();
    // Omitting the marker keeps whatever was recorded last.
    await mailbox.renew({ commandId, attemptToken: claim.attemptToken });
    const kept = await mailbox.receipt(commandId);
    expect(kept?.progress).toBeNull();
    mailbox.dispose();
  });

  it('reports a held head as due at its deadline when the backoff lies beyond it', async () => {
    const { mailbox, clock } = createMailboxFixture({
      commandTimeoutMs: 5_000,
      retryBackoffMs: 60_000,
      maxRetryBackoffMs: 60_000,
      maxAttempts: 3,
    });
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    await mailbox.reject({
      commandId,
      attemptToken: claim.attemptToken,
      failure: { reason: 'application' },
      retry: true,
    });
    const receipt = await mailbox.receipt(commandId);
    const held = await mailbox.claim();
    expect(held.status).toBe('held');
    expect(held.status === 'held' ? held.availableAt : null).toBe(
      receipt?.absoluteDeadlineAt ?? null,
    );
    clock.advance(5_000);
    const afterDeadline = await mailbox.claim();
    expect(afterDeadline.status).toBe('empty');
    const terminal = await mailbox.receipt(commandId);
    expect(terminal?.state).toBe('dead-lettered');
    mailbox.dispose();
  });
});

describe('seventh-round hardening', () => {
  it('keeps the winning registration when concurrent claims share a token', async () => {
    const storage = new MemoryStorage();
    let generated = 0;
    const generateId = (): string => {
      generated += 1;
      return generated <= 1 ? 'command-1' : 'repeat';
    };
    const left = createMailboxFixture({ storage, generateId }).mailbox;
    const right = createMailboxFixture({ storage, generateId }).mailbox;
    const commandId = await admitOne(left);

    // Both handles derive the same token and register before either
    // compare-and-swap settles. The loser must not remove or abort the winner's
    // registration, and cancellation must still reach the winner.
    const [first, second] = await Promise.all([left.claim(), right.claim()]);
    const winner = first.status === 'claimed' ? first : second;
    const loser = first.status === 'claimed' ? second : first;
    expect(winner.status).toBe('claimed');
    expect(loser.status).toBe('empty');
    if (winner.status !== 'claimed') return;
    expect(winner.claim.signal.aborted).toBe(false);

    const cancelled = await right.requestCancellation({ commandId });
    expect(cancelled.status).toBe('requested');
    expect(winner.claim.signal.aborted).toBe(true);
    left.dispose();
    right.dispose();
  });

  it('keeps a committed sink-backed admission when the probe read fails', async () => {
    const storage = new MemoryStorage();
    const events = new RecordingEventSink(storage);
    const { mailbox } = createMailboxFixture({ storage, events });
    const originalGet = storage.get.bind(storage);
    let failed = false;
    storage.get = async (key: string): Promise<Uint8Array | null> => {
      if (!failed && key.startsWith('appprobe:')) {
        failed = true;
        throw new Error('transient');
      }
      return originalGet(key);
    };

    const admission = await mailbox.admit(commandInput({ idempotencyKey: 'a' }));
    expect(admission.status).toBe('admitted');
    expect(failed).toBe(true);
    // Still unverified, so the next commit probes again — and succeeds.
    const again = await mailbox.admit(commandInput({ idempotencyKey: 'b' }));
    expect(again.status).toBe('admitted');
    expect(await mailbox.list()).toHaveLength(2);
    mailbox.dispose();
  });

  it('fails closed on a persisted identity with an unpaired surrogate', async () => {
    const { mailbox, storage } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const key = KEYS.applicationCommand('bureau', 'agent-7', commandId);
    const record = decode((await storage.get(key)) as Uint8Array) as Record<string, unknown>;
    await storage.put(key, encode({ ...record, namespace: 'bureau\ud800' }));
    await expect(mailbox.receipt(commandId)).rejects.toThrow(PersistedDataCorruptError);
    mailbox.dispose();
  });

  it('fails closed on a mailbox header stored under another scope', async () => {
    const { mailbox, storage } = createMailboxFixture();
    await admitOne(mailbox);
    const header = await storage.get(KEYS.applicationMailbox('bureau', 'agent-7'));
    await storage.put(KEYS.applicationMailbox('bureau', 'agent-8'), header as Uint8Array);
    const other = new ApplicationMailbox({ storage, namespace: 'bureau', resourceId: 'agent-8' });
    await expect(other.capacity()).rejects.toThrow(PersistedDataCorruptError);
    await expect(other.admit(commandInput())).rejects.toThrow(PersistedDataCorruptError);
    other.dispose();
    mailbox.dispose();
  });

  it('does not retire a live command through a stale terminal-index entry', async () => {
    const { mailbox, storage, clock } = createMailboxFixture({ terminalRetentionMs: 1_000 });
    const commandId = await admitOne(mailbox);
    // A corrupt index entry claims this open command reached a terminal state
    // long ago.
    const stale = KEYS.applicationCommandTerminal('bureau', 'agent-7', 0, commandId);
    await storage.put(stale, encodeApplicationReadyEntry(commandId));
    clock.advance(5_000);

    await mailbox.runMaintenance();
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('available');
    expect(await storage.get(stale)).toBeNull();
    expect(await mailbox.list()).toHaveLength(1);
    mailbox.dispose();
  });
});

describe('eighth-round hardening', () => {
  it('fails closed on a waiting record with an exhausted attempt budget', async () => {
    const { mailbox, storage } = createMailboxFixture({ maxAttempts: 3 });
    const commandId = await admitOne(mailbox);
    const key = KEYS.applicationCommand('bureau', 'agent-7', commandId);
    const record = decode((await storage.get(key)) as Uint8Array) as Record<string, unknown>;
    await storage.put(key, encode({ ...record, attempt: 3 }));
    await expect(mailbox.claim()).rejects.toThrow(PersistedDataCorruptError);
    mailbox.dispose();
  });

  it('discards a ready entry whose key disagrees with its record', async () => {
    const { mailbox, storage } = createMailboxFixture({ generateId: createIdSource('c') });
    await admitOne(mailbox, { idempotencyKey: 'a' });
    const second = await admitOne(mailbox, { idempotencyKey: 'b' });
    // Claim the first command so its genuine entry (sequence 0) is gone, then
    // plant a stale entry at sequence 0 that names the second command, whose
    // real entry sits at sequence 1.
    await claimOne(mailbox);
    const stale = KEYS.applicationCommandReady('bureau', 'agent-7', 0);
    await storage.put(stale, encodeApplicationReadyEntry(second));

    const claim = await claimOne(mailbox);
    expect(claim.commandId).toBe(second);
    // Both the stale entry and the genuine one are gone; claiming through the
    // stale one would have left it behind.
    let entries = 0;
    for await (const _entry of storage.scan(
      KEYS.applicationCommandReadyPrefix('bureau', 'agent-7'),
    )) {
      entries += 1;
    }
    expect(entries).toBe(0);
    mailbox.dispose();
  });

  it('returns the terminal receipt when a renewal race already dead-lettered the command', async () => {
    const storage = new MemoryStorage();
    const clock = createMailboxClock();
    const { mailbox } = createMailboxFixture({
      storage,
      clock,
      commandTimeoutMs: 1_000,
      visibilityTimeoutMs: 10_000,
    });
    const other = createMailboxFixture({ storage, clock }).mailbox;
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);

    // The renewal commits; the deadline passes; maintenance dead-letters the
    // command before the renewal's post-commit reload.
    const original = storage.conditionalBatch.bind(storage);
    let raced = false;
    storage.conditionalBatch = async (
      ...args: Parameters<MemoryStorage['conditionalBatch']>
    ): Promise<boolean> => {
      const result = await original(...args);
      if (!raced) {
        raced = true;
        clock.advance(1_000);
        await other.runMaintenance();
      }
      return result;
    };

    const renewal = await mailbox.renew({ commandId, attemptToken: claim.attemptToken });
    expect(renewal.status).toBe('deadline-exceeded');
    expect(renewal.status === 'deadline-exceeded' && renewal.receipt.state).toBe('dead-lettered');
    other.dispose();
    mailbox.dispose();
  });

  it('retires valid receipts behind a malformed terminal entry', async () => {
    const { mailbox, storage, clock } = createMailboxFixture({
      terminalRetentionMs: 1_000,
      maintenanceBatchSize: 1,
    });
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    await mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken });
    // An entry that sorts first and whose command-id suffix cannot be decoded.
    const malformed = `${KEYS.applicationCommandTerminalPrefix('bureau', 'agent-7')}${'0'.repeat(16)}:%ZZ`;
    await storage.put(malformed, encodeApplicationReadyEntry('nope'));
    clock.advance(5_000);

    await mailbox.runMaintenance();
    expect(await storage.get(malformed)).toBeNull();
    await mailbox.runMaintenance();
    expect(await mailbox.receipt(commandId)).toBeNull();
    mailbox.dispose();
  });
});

describe('ninth-round hardening', () => {
  it('fails closed on an index entry whose command id is malformed', async () => {
    const { mailbox, storage } = createMailboxFixture();
    await admitOne(mailbox);
    await storage.put(
      KEYS.applicationCommandReady('bureau', 'agent-7', 0),
      encodeApplicationReadyEntry('id-\ud800'),
    );
    await expect(mailbox.claim()).rejects.toThrow(PersistedDataCorruptError);
    mailbox.dispose();
  });

  it('fails closed on a listing entry whose key disagrees with its record', async () => {
    const { mailbox, storage } = createMailboxFixture({ generateId: createIdSource('c') });
    const first = await admitOne(mailbox, { idempotencyKey: 'a' });
    const second = await admitOne(mailbox, { idempotencyKey: 'b' });
    // Sequence 0 belongs to the first command; point its listing entry at the second.
    await storage.put(
      KEYS.applicationCommandBySequence('bureau', 'agent-7', 0),
      encodeApplicationReadyEntry(second),
    );
    await expect(mailbox.list()).rejects.toThrow(PersistedDataCorruptError);
    expect(first).not.toBe(second);
    mailbox.dispose();
  });

  it('looks past a ready entry that is not the record own to the genuine head', async () => {
    const { mailbox, storage } = createMailboxFixture({ generateId: createIdSource('c') });
    await admitOne(mailbox, { idempotencyKey: 'a' });
    const second = await admitOne(mailbox, { idempotencyKey: 'b' });
    await claimOne(mailbox);
    await storage.put(
      KEYS.applicationCommandReady('bureau', 'agent-7', 0),
      encodeApplicationReadyEntry(second),
    );
    // The stale entry is one `claim()` would discard; the second command's own
    // entry behind it is the claimable head, so there IS due work.
    expect(await mailbox.waitForAvailable({ timeoutMs: 0 })).toBe(true);
    mailbox.dispose();
  });

  it.each([
    ['zero', 0],
    ['beyond the budget', 4],
  ])('fails closed on a leased record whose attempt is %s', async (_name, attempt) => {
    const { mailbox, storage } = createMailboxFixture({ maxAttempts: 3 });
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    const key = KEYS.applicationCommand('bureau', 'agent-7', commandId);
    const record = decode((await storage.get(key)) as Uint8Array) as Record<string, unknown>;
    await storage.put(key, encode({ ...record, attempt }));
    await expect(mailbox.renew({ commandId, attemptToken: claim.attemptToken })).rejects.toThrow(
      PersistedDataCorruptError,
    );
    mailbox.dispose();
  });

  it('releases the provisional registration when the claim commit throws', async () => {
    const storage = new MemoryStorage();
    const { mailbox } = createMailboxFixture({ storage });
    await admitOne(mailbox);
    const original = storage.conditionalBatch.bind(storage);
    let thrown = false;
    storage.conditionalBatch = async (
      ...args: Parameters<MemoryStorage['conditionalBatch']>
    ): Promise<boolean> => {
      if (!thrown) {
        thrown = true;
        throw new Error('transient');
      }
      return original(...args);
    };
    await expect(mailbox.claim()).rejects.toThrow('transient');
    expect(attemptControllerRegistry(storage, 'bureau', 'agent-7').size).toBe(0);
    // The handle is still usable and the command is still claimable.
    const claim = await mailbox.claim();
    expect(claim.status).toBe('claimed');
    mailbox.dispose();
  });

  it('releases the local controller when renewal finds the lease no longer current', async () => {
    const storage = new MemoryStorage();
    const clock = createMailboxClock();
    const { mailbox } = createMailboxFixture({ storage, clock, visibilityTimeoutMs: 500 });
    const other = createMailboxFixture({ storage, clock }).mailbox;
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    // Another handle (standing in for another process) reclaims the expired lease.
    clock.advance(501);
    await other.runMaintenance();

    const renewal = await mailbox.renew({ commandId, attemptToken: claim.attemptToken });
    expect(renewal.status).toBe('stale');
    expect(claim.signal.aborted).toBe(true);
    expect(attemptControllerRegistry(storage, 'bureau', 'agent-7').has(claim.attemptToken)).toBe(
      false,
    );
    other.dispose();
    mailbox.dispose();
  });

  it('does not report a late observation as a successful bounded wait', async () => {
    const storage = new MemoryStorage();
    const clock = createMailboxClock();
    const { mailbox } = createMailboxFixture({ storage, clock });
    await admitOne(mailbox);
    // The record read finishes after the deadline; work is due, but late.
    const originalGet = storage.get.bind(storage);
    let slowed = false;
    storage.get = async (key: string): Promise<Uint8Array | null> => {
      const value = await originalGet(key);
      if (!slowed && key.startsWith('appcmd:')) {
        slowed = true;
        clock.advance(1_001);
      }
      return value;
    };
    expect(await mailbox.waitForAvailable({ timeoutMs: 1_000 })).toBe(false);
    mailbox.dispose();
  });

  it('fails closed on a mailbox header whose counters disagree', async () => {
    const { mailbox, storage } = createMailboxFixture();
    await admitOne(mailbox);
    const key = KEYS.applicationMailbox('bureau', 'agent-7');
    const header = decode((await storage.get(key)) as Uint8Array) as Record<string, unknown>;
    await storage.put(key, encode({ ...header, nextSequence: 0 }));
    await expect(mailbox.capacity()).rejects.toThrow(PersistedDataCorruptError);
    await storage.put(key, encode({ ...header, openCount: 99 }));
    await expect(mailbox.capacity()).rejects.toThrow(PersistedDataCorruptError);
    mailbox.dispose();
  });

  it('fails closed on an idempotency binding that names an unrelated command', async () => {
    const { mailbox, storage } = createMailboxFixture({ generateId: createIdSource('c') });
    await admitOne(mailbox, { idempotencyKey: 'a' });
    const unrelated = await admitOne(mailbox, { idempotencyKey: 'b' });
    const key = KEYS.applicationCommandIdempotency('bureau', 'agent-7', 'a');
    const binding = decode((await storage.get(key)) as Uint8Array) as Record<string, unknown>;
    await storage.put(key, encode({ ...binding, commandId: unrelated }));
    await expect(mailbox.admit(commandInput({ idempotencyKey: 'a' }))).rejects.toThrow(
      PersistedDataCorruptError,
    );
    mailbox.dispose();
  });

  it('counts a receipt as retired by exactly one concurrent maintenance pass', async () => {
    const storage = new MemoryStorage();
    const clock = createMailboxClock();
    const left = createMailboxFixture({ storage, clock, terminalRetentionMs: 1_000 }).mailbox;
    const right = createMailboxFixture({ storage, clock, terminalRetentionMs: 1_000 }).mailbox;
    const commandId = await admitOne(left);
    const claim = await claimOne(left);
    await left.acknowledge({ commandId, attemptToken: claim.attemptToken });
    clock.advance(5_000);

    const [a, b] = await Promise.all([left.runMaintenance(), right.runMaintenance()]);
    expect(a.retired + b.retired).toBe(1);
    expect(await left.receipt(commandId)).toBeNull();
    left.dispose();
    right.dispose();
  });

  it('fails closed on a reference payload whose digest disagrees with the record', async () => {
    const { mailbox, storage } = createMailboxFixture();
    const digest = 'a'.repeat(64);
    const admission = await mailbox.admit(
      commandInput({ payload: { form: 'reference', reference: 'blob:1', digest } }),
    );
    expect(admission.status).toBe('admitted');
    if (admission.status !== 'admitted') return;
    const key = KEYS.applicationCommand('bureau', 'agent-7', admission.receipt.commandId);
    const record = decode((await storage.get(key)) as Uint8Array) as Record<string, unknown>;
    await storage.put(key, encode({ ...record, payloadDigest: 'b'.repeat(64) }));
    await expect(mailbox.receipt(admission.receipt.commandId)).rejects.toThrow(
      PersistedDataCorruptError,
    );
    await storage.put(
      key,
      encode({ ...record, payload: { form: 'reference', reference: 'blob:1', digest: 'nope' } }),
    );
    await expect(mailbox.receipt(admission.receipt.commandId)).rejects.toThrow(
      PersistedDataCorruptError,
    );
    mailbox.dispose();
  });
});

describe('tenth-round hardening', () => {
  it('does not release another command attempt on a mismatched renewal', async () => {
    const { mailbox, storage } = createMailboxFixture({ generateId: createIdSource('c') });
    const first = await admitOne(mailbox, { idempotencyKey: 'a' });
    const second = await admitOne(mailbox, { idempotencyKey: 'b' });
    const firstClaim = await claimOne(mailbox);
    const secondClaim = await claimOne(mailbox);
    expect(firstClaim.commandId).toBe(first);
    expect(secondClaim.commandId).toBe(second);

    // Command A's id paired with command B's token is refused as stale for A —
    // and must leave B's live attempt exactly as it was.
    const mismatched = await mailbox.renew({
      commandId: first,
      attemptToken: secondClaim.attemptToken,
    });
    expect(mismatched.status).toBe('stale');
    expect(secondClaim.signal.aborted).toBe(false);
    expect(
      attemptControllerRegistry(storage, 'bureau', 'agent-7').has(secondClaim.attemptToken),
    ).toBe(true);
    const genuine = await mailbox.renew({
      commandId: second,
      attemptToken: secondClaim.attemptToken,
    });
    expect(genuine.status).toBe('renewed');
    mailbox.dispose();
  });

  it('fails closed on an idempotency binding whose command id is malformed', async () => {
    const { mailbox, storage } = createMailboxFixture();
    await admitOne(mailbox, { idempotencyKey: 'a' });
    const key = KEYS.applicationCommandIdempotency('bureau', 'agent-7', 'a');
    const binding = decode((await storage.get(key)) as Uint8Array) as Record<string, unknown>;
    await storage.put(key, encode({ ...binding, commandId: 'id-\ud800' }));
    await expect(mailbox.admit(commandInput({ idempotencyKey: 'a' }))).rejects.toThrow(
      PersistedDataCorruptError,
    );
    mailbox.dispose();
  });

  it('fails closed on a terminal record whose failure disagrees with its state', async () => {
    const { mailbox, storage } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    await mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken });
    const key = KEYS.applicationCommand('bureau', 'agent-7', commandId);
    const applied = decode((await storage.get(key)) as Uint8Array) as Record<string, unknown>;

    // An applied record cannot carry a failure.
    await storage.put(key, encode({ ...applied, failure: { reason: 'attempts-exhausted' } }));
    await expect(mailbox.receipt(commandId)).rejects.toThrow(PersistedDataCorruptError);
    // A dead-lettered record cannot carry a claimant failure, and a rejected one
    // cannot carry a mailbox-owned reason.
    await storage.put(
      key,
      encode({ ...applied, state: 'dead-lettered', failure: { reason: 'application' } }),
    );
    await expect(mailbox.receipt(commandId)).rejects.toThrow(PersistedDataCorruptError);
    await storage.put(
      key,
      encode({ ...applied, state: 'rejected', failure: { reason: 'cancelled' } }),
    );
    await expect(mailbox.receipt(commandId)).rejects.toThrow(PersistedDataCorruptError);
    // The legal pairings still decode.
    await storage.put(
      key,
      encode({ ...applied, state: 'dead-lettered', failure: { reason: 'deadline-exceeded' } }),
    );
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('dead-lettered');
    mailbox.dispose();
  });
});

describe('eleventh-round hardening', () => {
  it('records cleanup as pending when an exhausted final attempt is abandoned', async () => {
    const { mailbox, clock } = createMailboxFixture({ maxAttempts: 1, visibilityTimeoutMs: 500 });
    const commandId = await admitOne(mailbox);
    await claimOne(mailbox);
    clock.advance(501);
    await mailbox.runMaintenance();
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('dead-lettered');
    expect(receipt?.failure?.reason).toBe('attempts-exhausted');
    // The lease expired; the claimant may still be running. That is not settled.
    const cleanup = await mailbox.cleanupState(commandId);
    expect(cleanup.status).toBe('pending');
    mailbox.dispose();
  });

  it('releases the local registration when a settlement is refused', async () => {
    const storage = new MemoryStorage();
    const clock = createMailboxClock();
    const { mailbox } = createMailboxFixture({ storage, clock, visibilityTimeoutMs: 500 });
    const other = createMailboxFixture({ storage, clock }).mailbox;
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    clock.advance(501);
    await other.runMaintenance();

    const settled = await mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken });
    expect(settled.status).toBe('stale');
    expect(claim.signal.aborted).toBe(true);
    expect(attemptControllerRegistry(storage, 'bureau', 'agent-7').has(claim.attemptToken)).toBe(
      false,
    );
    other.dispose();
    mailbox.dispose();
  });

  it('does not release another command attempt on a mismatched settlement', async () => {
    const { mailbox, storage } = createMailboxFixture({ generateId: createIdSource('c') });
    const first = await admitOne(mailbox, { idempotencyKey: 'a' });
    await admitOne(mailbox, { idempotencyKey: 'b' });
    await claimOne(mailbox);
    const secondClaim = await claimOne(mailbox);
    const mismatched = await mailbox.reject({
      commandId: first,
      attemptToken: secondClaim.attemptToken,
      failure: { reason: 'application' },
    });
    expect(mismatched.status).toBe('stale');
    expect(secondClaim.signal.aborted).toBe(false);
    expect(
      attemptControllerRegistry(storage, 'bureau', 'agent-7').has(secondClaim.attemptToken),
    ).toBe(true);
    mailbox.dispose();
  });

  it('fails closed on a persisted idempotency key that is malformed', async () => {
    const { mailbox, storage } = createMailboxFixture();
    const commandId = await admitOne(mailbox, { idempotencyKey: 'a' });
    const key = KEYS.applicationCommand('bureau', 'agent-7', commandId);
    const record = decode((await storage.get(key)) as Uint8Array) as Record<string, unknown>;
    await storage.put(key, encode({ ...record, idempotencyKey: 'k-\ud800' }));
    await expect(mailbox.receipt(commandId)).rejects.toThrow(PersistedDataCorruptError);
    mailbox.dispose();
  });

  it('snapshots the failure reason it validated', async () => {
    const { mailbox } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    let reads = 0;
    const failure = {
      get reason(): 'application' | 'cancelled' {
        reads += 1;
        return reads === 1 ? 'application' : 'cancelled';
      },
    };
    const settled = await mailbox.reject({
      commandId,
      attemptToken: claim.attemptToken,
      failure: failure as unknown as ApplicationCommandRejection,
    });
    expect(settled.status).toBe('settled');
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('rejected');
    expect(receipt?.failure?.reason).toBe('application');
    mailbox.dispose();
  });

  it('refuses an already-aborted cleanup wait before reading storage', async () => {
    const storage = new MemoryStorage();
    const { mailbox } = createMailboxFixture({ storage });
    const commandId = await admitOne(mailbox);
    let reads = 0;
    const originalGet = storage.get.bind(storage);
    storage.get = async (key: string): Promise<Uint8Array | null> => {
      reads += 1;
      return originalGet(key);
    };
    const controller = new AbortController();
    controller.abort(new Error('gone'));
    await expect(
      mailbox.awaitCleanup({ commandId, timeoutMs: 1_000, signal: controller.signal }),
    ).rejects.toThrow('gone');
    expect(reads).toBe(0);
    mailbox.dispose();
  });
});

describe('twelfth-round hardening', () => {
  it('re-reads durable state when the post-renewal dead-letter loses its race', async () => {
    const storage = new MemoryStorage();
    const clock = createMailboxClock();
    const { mailbox } = createMailboxFixture({
      storage,
      clock,
      commandTimeoutMs: 1_000,
      visibilityTimeoutMs: 10_000,
    });
    const other = createMailboxFixture({ storage, clock }).mailbox;
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);

    // Batch 1 is the renewal commit; the deadline passes right after it. Batch
    // 2 is the renewal's own dead-letter attempt: maintenance from another
    // handle dead-letters the command first, so that attempt loses.
    const original = storage.conditionalBatch.bind(storage);
    let batches = 0;
    let racing = false;
    storage.conditionalBatch = async (
      ...args: Parameters<MemoryStorage['conditionalBatch']>
    ): Promise<boolean> => {
      if (racing) return original(...args);
      batches += 1;
      if (batches === 2) {
        racing = true;
        await other.runMaintenance();
        racing = false;
      }
      const result = await original(...args);
      if (batches === 1) clock.advance(1_000);
      return result;
    };

    const renewal = await mailbox.renew({ commandId, attemptToken: claim.attemptToken });
    expect(renewal.status).toBe('deadline-exceeded');
    expect(renewal.status === 'deadline-exceeded' && renewal.receipt.state).toBe('dead-lettered');
    other.dispose();
    mailbox.dispose();
  });

  it('stops a cleanup wait aborted during a stalled storage read', async () => {
    const storage = new MemoryStorage();
    const { mailbox } = createMailboxFixture({ storage });
    const commandId = await admitOne(mailbox);
    const controller = new AbortController();
    let stalled = false;
    const originalGet = storage.get.bind(storage);
    storage.get = (key: string): Promise<Uint8Array | null> => {
      if (!stalled && key.startsWith('appcmd:')) {
        stalled = true;
        // A read that never returns; the abort arrives while it is in flight.
        queueMicrotask(() => {
          controller.abort(new Error('gone mid-read'));
        });
        return new Promise<Uint8Array | null>(() => {});
      }
      return originalGet(key);
    };
    await expect(
      mailbox.awaitCleanup({ commandId, timeoutMs: 1_000, signal: controller.signal }),
    ).rejects.toThrow('gone mid-read');
    mailbox.dispose();
  });

  it('propagates a failing cleanup read', async () => {
    const storage = new MemoryStorage();
    const { mailbox } = createMailboxFixture({ storage });
    const commandId = await admitOne(mailbox);
    storage.get = async (): Promise<Uint8Array | null> => {
      throw new Error('storage down');
    };
    await expect(
      mailbox.awaitCleanup({ commandId, timeoutMs: 1_000, signal: new AbortController().signal }),
    ).rejects.toThrow('storage down');
    mailbox.dispose();
  });

  it('retires a record without deleting auxiliary entries it does not own', async () => {
    const { mailbox, storage, clock } = createMailboxFixture({
      terminalRetentionMs: 1_000,
      generateId: createIdSource('c'),
    });
    const first = await admitOne(mailbox, { idempotencyKey: 'a' });
    const second = await admitOne(mailbox, { idempotencyKey: 'b' });
    const claim = await claimOne(mailbox);
    await mailbox.acknowledge({ commandId: first, attemptToken: claim.attemptToken });
    // Corrupt the terminal record so its auxiliary references name the live
    // second command's binding and listing entry.
    const key = KEYS.applicationCommand('bureau', 'agent-7', first);
    const record = decode((await storage.get(key)) as Uint8Array) as Record<string, unknown>;
    await storage.put(key, encode({ ...record, idempotencyKey: 'b', sequence: 1 }));
    clock.advance(5_000);

    await mailbox.runMaintenance();
    expect(await mailbox.receipt(first)).toBeNull();
    expect(
      await storage.get(KEYS.applicationCommandIdempotency('bureau', 'agent-7', 'b')),
    ).not.toBeNull();
    expect(
      await storage.get(KEYS.applicationCommandBySequence('bureau', 'agent-7', 1)),
    ).not.toBeNull();
    const listed = await mailbox.list();
    expect(listed.map((receipt) => receipt.commandId)).toEqual([second]);
    // A retry of key `b` still resolves the live command rather than admitting anew.
    const retry = await mailbox.admit(commandInput({ idempotencyKey: 'b' }));
    expect(retry.status).toBe('duplicate');
    mailbox.dispose();
  });

  it('refuses admission once the sequence allocator is exhausted', async () => {
    const { mailbox, storage } = createMailboxFixture();
    const key = KEYS.applicationMailbox('bureau', 'agent-7');
    await storage.put(
      key,
      encode({
        recordVersion: 1,
        namespace: 'bureau',
        resourceId: 'agent-7',
        nextSequence: Number.MAX_SAFE_INTEGER,
        openCount: 0,
        admittedCount: Number.MAX_SAFE_INTEGER,
      }),
    );
    await expect(mailbox.admit(commandInput())).rejects.toThrow(/sequence allocator/);
    // Nothing was written: the header still decodes.
    const capacity = await mailbox.capacity();
    expect(capacity.admitted).toBe(Number.MAX_SAFE_INTEGER);
    mailbox.dispose();
  });

  it('rejects a poll interval beyond the timer range', async () => {
    const { mailbox } = createMailboxFixture();
    await expect(
      mailbox.waitForAvailable({ timeoutMs: 0, pollIntervalMs: 2_147_483_648 }),
    ).rejects.toThrow(/largest delay a timer can schedule/);
    mailbox.dispose();
  });
});

describe('thirteenth-round hardening', () => {
  it('releases the attempt when the post-renewal dead-letter was done elsewhere', async () => {
    const storage = new MemoryStorage();
    const clock = createMailboxClock();
    const { mailbox } = createMailboxFixture({
      storage,
      clock,
      commandTimeoutMs: 1_000,
      visibilityTimeoutMs: 10_000,
    });
    const other = createMailboxFixture({ storage, clock }).mailbox;
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    const original = storage.conditionalBatch.bind(storage);
    let batches = 0;
    let racing = false;
    storage.conditionalBatch = async (
      ...args: Parameters<MemoryStorage['conditionalBatch']>
    ): Promise<boolean> => {
      if (racing) return original(...args);
      batches += 1;
      if (batches === 2) {
        racing = true;
        await other.runMaintenance();
        racing = false;
      }
      const result = await original(...args);
      if (batches === 1) clock.advance(1_000);
      return result;
    };

    const renewal = await mailbox.renew({ commandId, attemptToken: claim.attemptToken });
    expect(renewal.status).toBe('deadline-exceeded');
    expect(claim.signal.aborted).toBe(true);
    expect(attemptControllerRegistry(storage, 'bureau', 'agent-7').has(claim.attemptToken)).toBe(
      false,
    );
    other.dispose();
    mailbox.dispose();
  });

  it('returns false when a due-work read stalls and the wait is aborted', async () => {
    const storage = new MemoryStorage();
    const { mailbox } = createMailboxFixture({ storage });
    await admitOne(mailbox);
    const controller = new AbortController();
    let stalled = false;
    const originalGet = storage.get.bind(storage);
    storage.get = (key: string): Promise<Uint8Array | null> => {
      if (!stalled && key.startsWith('appcmd:')) {
        stalled = true;
        queueMicrotask(() => {
          controller.abort();
        });
        return new Promise<Uint8Array | null>(() => {});
      }
      return originalGet(key);
    };
    expect(await mailbox.waitForAvailable({ timeoutMs: 10_000, signal: controller.signal })).toBe(
      false,
    );
  });

  it('returns false when a due-work read stalls and the mailbox is disposed', async () => {
    const storage = new MemoryStorage();
    const { mailbox } = createMailboxFixture({ storage });
    await admitOne(mailbox);
    let stalled = false;
    const originalGet = storage.get.bind(storage);
    storage.get = (key: string): Promise<Uint8Array | null> => {
      if (!stalled && key.startsWith('appcmd:')) {
        stalled = true;
        queueMicrotask(() => {
          mailbox.dispose();
        });
        return new Promise<Uint8Array | null>(() => {});
      }
      return originalGet(key);
    };
    expect(await mailbox.waitForAvailable({ timeoutMs: 10_000 })).toBe(false);
  });

  it('stops a cleanup wait when the mailbox is disposed during a stalled read', async () => {
    const storage = new MemoryStorage();
    const { mailbox } = createMailboxFixture({ storage });
    const commandId = await admitOne(mailbox);
    let stalled = false;
    const originalGet = storage.get.bind(storage);
    storage.get = (key: string): Promise<Uint8Array | null> => {
      if (!stalled && key.startsWith('appcmd:')) {
        stalled = true;
        queueMicrotask(() => {
          mailbox.dispose();
        });
        return new Promise<Uint8Array | null>(() => {});
      }
      return originalGet(key);
    };
    await expect(mailbox.awaitCleanup({ commandId, timeoutMs: 10_000 })).rejects.toThrow(
      /disposed/,
    );
  });
});

/** A second identity over the same bytes, standing in for another process's storage handle. */
function remoteView(storage: MemoryStorage): Storage {
  return {
    get: storage.get.bind(storage),
    put: storage.put.bind(storage),
    delete: storage.delete.bind(storage),
    scan: storage.scan.bind(storage),
    batch: storage.batch.bind(storage),
    conditionalBatch: storage.conditionalBatch.bind(storage),
    capabilities: () => storage.capabilities(),
    [Symbol.dispose]: () => {},
  };
}

describe('fourteenth-round hardening', () => {
  it('releases local attempts when a cleanup read finds the command retired elsewhere', async () => {
    const storage = new MemoryStorage();
    const clock = createMailboxClock();
    const local = createMailboxFixture({
      storage,
      clock,
      visibilityTimeoutMs: 500,
      terminalRetentionMs: 1_000,
      retryBackoffMs: 1,
      generateId: createIdSource('l'),
    }).mailbox;
    // Another process: same durable bytes, a different registry.
    const remote = new ApplicationMailbox({
      storage: remoteView(storage),
      namespace: 'bureau',
      resourceId: 'agent-7',
      now: clock.now,
      generateId: createIdSource('r'),
      visibilityTimeoutMs: 500,
      terminalRetentionMs: 1_000,
      retryBackoffMs: 1,
    });
    const commandId = await admitOne(local);
    const claim = await claimOne(local);
    clock.advance(501);
    await remote.runMaintenance();
    // Past the retry backoff the reclaimed command is due again.
    clock.advance(10);
    const reclaimed = await remote.claim();
    expect(reclaimed.status).toBe('claimed');
    if (reclaimed.status !== 'claimed') return;
    await remote.acknowledge({ commandId, attemptToken: reclaimed.claim.attemptToken });
    clock.advance(5_000);
    await remote.runMaintenance();
    // The local claimant's attempt was never released by anything in this process.
    expect(claim.signal.aborted).toBe(false);

    const cleanup = await local.cleanupState(commandId);
    expect(cleanup.status).toBe('unknown');
    expect(claim.signal.aborted).toBe(true);
    expect(attemptControllerRegistry(storage, 'bureau', 'agent-7').has(claim.attemptToken)).toBe(
      false,
    );
    remote.dispose();
    local.dispose();
  });

  it('stops a claim aborted during a stalled head read', async () => {
    const storage = new MemoryStorage();
    const { mailbox } = createMailboxFixture({ storage });
    await admitOne(mailbox);
    const controller = new AbortController();
    let stalled = false;
    const originalGet = storage.get.bind(storage);
    storage.get = (key: string): Promise<Uint8Array | null> => {
      if (!stalled && key.startsWith('appcmd:')) {
        stalled = true;
        queueMicrotask(() => {
          controller.abort(new Error('caller gone'));
        });
        return new Promise<Uint8Array | null>(() => {});
      }
      return originalGet(key);
    };
    await expect(mailbox.claim({ signal: controller.signal })).rejects.toThrow('caller gone');
    mailbox.dispose();
  });

  it('does not hide an abort behind an empty claim result', async () => {
    const storage = new MemoryStorage();
    const { mailbox } = createMailboxFixture({ storage });
    const controller = new AbortController();
    // The index scan sees an empty mailbox; the abort lands just as it returns.
    const originalScan = storage.scan.bind(storage);
    storage.scan = (
      ...args: Parameters<MemoryStorage['scan']>
    ): ReturnType<MemoryStorage['scan']> => {
      controller.abort(new Error('late abort'));
      return originalScan(...args);
    };
    await expect(mailbox.claim({ signal: controller.signal })).rejects.toThrow('late abort');
    mailbox.dispose();
  });
});

describe('fifteenth-round hardening', () => {
  it('bounds a due-work wait even while its read is stalled', async () => {
    useFakeTimers();
    const storage = new MemoryStorage();
    const { mailbox, clock } = createMailboxFixture({ storage });
    await admitOne(mailbox);
    let stalled = false;
    const originalGet = storage.get.bind(storage);
    storage.get = (key: string): Promise<Uint8Array | null> => {
      if (!stalled && key.startsWith('appcmd:')) {
        stalled = true;
        return new Promise<Uint8Array | null>(() => {});
      }
      return originalGet(key);
    };
    const waiting = mailbox.waitForAvailable({ timeoutMs: 1_000 });
    let settled: boolean | undefined;
    void waiting.then((value) => {
      settled = value;
    });
    await flushMicrotasks(16);
    expect(settled).toBeUndefined();
    clock.advance(1_000);
    await advanceTimersByTime(1_000);
    await flushMicrotasks();
    expect(settled).toBe(false);
    mailbox.dispose();
  });

  it('bounds a cleanup wait whose later read stalls, returning the last observation', async () => {
    useFakeTimers();
    const storage = new MemoryStorage();
    const { mailbox, clock } = createMailboxFixture({ storage });
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    await mailbox.requestCancellation({ commandId });
    let reads = 0;
    const originalGet = storage.get.bind(storage);
    storage.get = (key: string): Promise<Uint8Array | null> => {
      if (key.startsWith('appcmd:')) {
        reads += 1;
        if (reads >= 2) return new Promise<Uint8Array | null>(() => {});
      }
      return originalGet(key);
    };
    const waiting = mailbox.awaitCleanup({ commandId, timeoutMs: 500, pollIntervalMs: 100 });
    let result: ApplicationCommandCleanupResult | undefined;
    void waiting.then((value) => {
      result = value;
    });
    await flushMicrotasks(16);
    clock.advance(100);
    await advanceTimersByTime(100);
    await flushMicrotasks();
    expect(result).toBeUndefined();
    clock.advance(500);
    await advanceTimersByTime(500);
    await flushMicrotasks();
    expect(result?.status).toBe('pending');
    expect(claim.signal.aborted).toBe(true);
    mailbox.dispose();
  });

  it('rejects a cleanup wait whose first read outlives the budget', async () => {
    useFakeTimers();
    const storage = new MemoryStorage();
    const { mailbox, clock } = createMailboxFixture({ storage });
    const commandId = await admitOne(mailbox);
    const originalGet = storage.get.bind(storage);
    storage.get = (key: string): Promise<Uint8Array | null> =>
      key.startsWith('appcmd:') ? new Promise<Uint8Array | null>(() => {}) : originalGet(key);
    const waiting = mailbox.awaitCleanup({ commandId, timeoutMs: 200 });
    let failure: unknown;
    waiting.catch((error: unknown) => {
      failure = error;
    });
    await flushMicrotasks(16);
    clock.advance(200);
    await advanceTimersByTime(200);
    await flushMicrotasks();
    expect(failure).toBeInstanceOf(WaitBudgetElapsedError);
    mailbox.dispose();
  });

  it('releases a local attempt when a cleanup read finds its lease reclaimed elsewhere', async () => {
    const storage = new MemoryStorage();
    const clock = createMailboxClock();
    const local = createMailboxFixture({
      storage,
      clock,
      visibilityTimeoutMs: 500,
      generateId: createIdSource('l'),
    }).mailbox;
    const remote = new ApplicationMailbox({
      storage: remoteView(storage),
      namespace: 'bureau',
      resourceId: 'agent-7',
      now: clock.now,
      generateId: createIdSource('r'),
      visibilityTimeoutMs: 500,
    });
    const commandId = await admitOne(local);
    const claim = await claimOne(local);
    clock.advance(501);
    await remote.runMaintenance();
    expect(claim.signal.aborted).toBe(false);

    const cleanup = await local.cleanupState(commandId);
    expect(cleanup.status).toBe('pending');
    expect(claim.signal.aborted).toBe(true);
    expect(attemptControllerRegistry(storage, 'bureau', 'agent-7').has(claim.attemptToken)).toBe(
      false,
    );
    remote.dispose();
    local.dispose();
  });

  it('fails closed on a leased record whose expiry disagrees with its lease', async () => {
    const { mailbox, storage } = createMailboxFixture({ visibilityTimeoutMs: 1_000 });
    const commandId = await admitOne(mailbox);
    await claimOne(mailbox);
    const key = KEYS.applicationCommand('bureau', 'agent-7', commandId);
    const record = decode((await storage.get(key)) as Uint8Array) as Record<string, unknown>;
    await storage.put(key, encode({ ...record, visibilityExpiresAt: 1 }));
    await expect(mailbox.receipt(commandId)).rejects.toThrow(PersistedDataCorruptError);
    await storage.put(
      key,
      encode({ ...record, visibilityExpiresAt: (record['visibilityExpiresAt'] as number) + 1 }),
    );
    await expect(mailbox.receipt(commandId)).rejects.toThrow(PersistedDataCorruptError);
    mailbox.dispose();
  });
});

describe('sixteenth-round hardening', () => {
  it('does not start another read once a positive wait budget is spent', async () => {
    useFakeTimers();
    const storage = new MemoryStorage();
    const { mailbox, clock } = createMailboxFixture({ storage });
    await admitOne(mailbox, { availableAfterMs: 60_000 });
    let recordReads = 0;
    const originalGet = storage.get.bind(storage);
    storage.get = (key: string): Promise<Uint8Array | null> => {
      if (key.startsWith('appcmd:')) recordReads += 1;
      return originalGet(key);
    };
    // The poll interval consumes the whole budget in one sleep.
    const waiting = mailbox.waitForAvailable({ timeoutMs: 100, pollIntervalMs: 100 });
    let settled: boolean | undefined;
    void waiting.then((value) => {
      settled = value;
    });
    await flushMicrotasks(16);
    expect(recordReads).toBe(1);
    clock.advance(100);
    await advanceTimersByTime(100);
    await flushMicrotasks(16);
    expect(settled).toBe(false);
    expect(recordReads).toBe(1);
    mailbox.dispose();
  });

  it('does not start another cleanup read once the budget is spent', async () => {
    useFakeTimers();
    const storage = new MemoryStorage();
    const { mailbox, clock } = createMailboxFixture({ storage });
    const commandId = await admitOne(mailbox);
    await claimOne(mailbox);
    await mailbox.requestCancellation({ commandId });
    let recordReads = 0;
    const originalGet = storage.get.bind(storage);
    storage.get = (key: string): Promise<Uint8Array | null> => {
      if (key.startsWith('appcmd:')) recordReads += 1;
      return originalGet(key);
    };
    const waiting = mailbox.awaitCleanup({ commandId, timeoutMs: 100, pollIntervalMs: 100 });
    let result: ApplicationCommandCleanupResult | undefined;
    void waiting.then((value) => {
      result = value;
    });
    await flushMicrotasks(16);
    expect(recordReads).toBe(1);
    clock.advance(100);
    await advanceTimersByTime(100);
    await flushMicrotasks(16);
    expect(result?.status).toBe('pending');
    expect(recordReads).toBe(1);
    mailbox.dispose();
  });

  it('releases a local attempt when maintenance finds the lease reclaimed elsewhere', async () => {
    const storage = new MemoryStorage();
    const clock = createMailboxClock();
    const local = createMailboxFixture({
      storage,
      clock,
      visibilityTimeoutMs: 500,
      generateId: createIdSource('l'),
    }).mailbox;
    const remote = new ApplicationMailbox({
      storage: remoteView(storage),
      namespace: 'bureau',
      resourceId: 'agent-7',
      now: clock.now,
      generateId: createIdSource('r'),
      visibilityTimeoutMs: 500,
    });
    await admitOne(local);
    const claim = await claimOne(local);
    clock.advance(501);
    // The other process wins the reclaim; this process's pass then finds a
    // record that is no longer due and must still let go of its stale attempt.
    await remote.runMaintenance();
    expect(claim.signal.aborted).toBe(false);
    await local.runMaintenance();
    expect(claim.signal.aborted).toBe(true);
    expect(attemptControllerRegistry(storage, 'bureau', 'agent-7').has(claim.attemptToken)).toBe(
      false,
    );
    remote.dispose();
    local.dispose();
  });
});

describe('maintenance races between the scan and the advance', () => {
  it('releases a local attempt when the reclaim loses its race to another process', async () => {
    const storage = new MemoryStorage();
    const clock = createMailboxClock();
    const local = createMailboxFixture({
      storage,
      clock,
      visibilityTimeoutMs: 500,
      generateId: createIdSource('l'),
    }).mailbox;
    const remote = new ApplicationMailbox({
      storage: remoteView(storage),
      namespace: 'bureau',
      resourceId: 'agent-7',
      now: clock.now,
      generateId: createIdSource('r'),
      visibilityTimeoutMs: 500,
    });
    await admitOne(local);
    const claim = await claimOne(local);
    clock.advance(501);
    // The other process reclaims between this pass's load and its commit, so
    // the commit loses and the reload finds a record that is no longer due.
    const original = storage.conditionalBatch.bind(storage);
    let raced = false;
    storage.conditionalBatch = async (
      ...args: Parameters<MemoryStorage['conditionalBatch']>
    ): Promise<boolean> => {
      if (!raced) {
        raced = true;
        await remote.runMaintenance();
      }
      return original(...args);
    };
    await local.runMaintenance();
    expect(raced).toBe(true);
    expect(claim.signal.aborted).toBe(true);
    expect(attemptControllerRegistry(storage, 'bureau', 'agent-7').has(claim.attemptToken)).toBe(
      false,
    );
    remote.dispose();
    local.dispose();
  });

  it('keeps a lease that was renewed between the scan and the advance', async () => {
    const storage = new MemoryStorage();
    const { mailbox, clock } = createMailboxFixture({ storage, visibilityTimeoutMs: 500 });
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    clock.advance(501);
    // The scan sees an expired lease; the claimant renews before the advance
    // reloads it, so the recovery transition is refused as not due.
    const originalGet = storage.get.bind(storage);
    let renewing = false;
    let renewed = false;
    storage.get = async (key: string): Promise<Uint8Array | null> => {
      if (!renewed && !renewing && key.startsWith('appcmd:')) {
        renewing = true;
        const renewal = await mailbox.renew({ commandId, attemptToken: claim.attemptToken });
        expect(renewal.status).toBe('renewed');
        renewed = true;
      }
      return originalGet(key);
    };
    const report = await mailbox.runMaintenance();
    expect(renewed).toBe(true);
    expect(report.reclaimed).toBe(0);
    expect(claim.signal.aborted).toBe(false);
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('claimed');
    mailbox.dispose();
  });

  it('releases a local attempt when the record vanishes between the scan and the advance', async () => {
    const storage = new MemoryStorage();
    const { mailbox, clock } = createMailboxFixture({ storage, visibilityTimeoutMs: 500 });
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    clock.advance(501);
    const key = KEYS.applicationCommand('bureau', 'agent-7', commandId);
    const originalGet = storage.get.bind(storage);
    let vanished = false;
    storage.get = async (readKey: string): Promise<Uint8Array | null> => {
      if (!vanished && readKey === key) {
        vanished = true;
        await storage.delete(key);
      }
      return originalGet(readKey);
    };
    await mailbox.runMaintenance();
    expect(vanished).toBe(true);
    expect(claim.signal.aborted).toBe(true);
    mailbox.dispose();
  });
});

describe('seventeenth-round hardening', () => {
  it('does not abort a claim that committed after the maintenance scan read its record', async () => {
    const storage = new MemoryStorage();
    const { mailbox } = createMailboxFixture({ storage });
    await admitOne(mailbox);
    // The scan reads the record while it is still waiting; a local claim then
    // registers and commits before the pass reconciles. The stale snapshot must
    // not take that new lease's registration down.
    const originalScan = storage.scan.bind(storage);
    let raced = false;
    let claim: Awaited<ReturnType<typeof claimOne>> | undefined;
    storage.scan = (
      ...args: Parameters<MemoryStorage['scan']>
    ): ReturnType<MemoryStorage['scan']> => {
      const inner = originalScan(...args);
      return (async function* interleaved(): AsyncGenerator<[string, Uint8Array]> {
        for await (const entry of inner) {
          if (!raced && entry[0].startsWith('appcmd:')) {
            raced = true;
            claim = await claimOne(mailbox);
          }
          yield entry;
        }
      })();
    };
    await mailbox.runMaintenance();
    expect(raced).toBe(true);
    expect(claim?.signal.aborted).toBe(false);
    expect(
      attemptControllerRegistry(storage, 'bureau', 'agent-7').has(claim?.attemptToken ?? ''),
    ).toBe(true);
    const receipt = await mailbox.receipt(claim?.commandId ?? '');
    expect(receipt?.state).toBe('claimed');
    mailbox.dispose();
  });

  it('rejects a wait budget beyond the timer range', async () => {
    const { mailbox } = createMailboxFixture();
    await expect(mailbox.waitForAvailable({ timeoutMs: 2_147_483_648 })).rejects.toThrow(
      /largest delay a timer can schedule/,
    );
    mailbox.dispose();
  });

  it('clears a long run of expired heads without reporting contention', async () => {
    const { mailbox, clock } = createMailboxFixture({
      commandTimeoutMs: 100,
      generateId: createIdSource('c'),
    });
    for (let index = 0; index < 30; index += 1) {
      await admitOne(mailbox, { idempotencyKey: `k-${index}` });
    }
    clock.advance(200);
    const claim = await mailbox.claim();
    expect(claim.status).toBe('empty');
    const listed = await mailbox.list({ limit: 100, states: ['dead-lettered'] });
    expect(listed).toHaveLength(30);
    mailbox.dispose();
  });

  it('keeps the maintenance cursor when a pass fails part-way', async () => {
    const storage = new MemoryStorage();
    const { mailbox, clock } = createMailboxFixture({
      storage,
      maintenanceBatchSize: 1,
      visibilityTimeoutMs: 500,
      generateId: createIdSource('c'),
    });
    // More records than the page cap, so the pass has a cursor to store.
    const first = await admitOne(mailbox, { idempotencyKey: 'k-0' });
    for (let index = 1; index <= 201; index += 1) {
      await admitOne(mailbox, { idempotencyKey: `k-${index}` });
    }
    const claim = await claimOne(mailbox);
    expect(claim.commandId).toBe(first);
    clock.advance(501);
    // The reclaim's commit fails transiently on the first pass.
    const original = storage.conditionalBatch.bind(storage);
    let failed = false;
    storage.conditionalBatch = async (
      ...args: Parameters<MemoryStorage['conditionalBatch']>
    ): Promise<boolean> => {
      if (!failed) {
        failed = true;
        throw new Error('transient');
      }
      return original(...args);
    };
    await expect(mailbox.runMaintenance()).rejects.toThrow('transient');
    // The retry must revisit the command it failed on rather than resume past it.
    const report = await mailbox.runMaintenance();
    expect(report.reclaimed).toBe(1);
    const receipt = await mailbox.receipt(first);
    expect(receipt?.state).toBe('accepted');
    mailbox.dispose();
  });

  it('discards a terminal entry with a noncanonical timestamp instead of stalling retention', async () => {
    const { mailbox, storage, clock } = createMailboxFixture({ terminalRetentionMs: 1_000 });
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    clock.advance(100);
    await mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken });
    // Over-padded: sorts before the canonical expired entry, parses as a far
    // future instant, and would stop the sweep on every pass.
    const prefix = KEYS.applicationCommandTerminalPrefix('bureau', 'agent-7');
    const noncanonical = `${prefix}0000000000000099999:nope`;
    await storage.put(noncanonical, encodeApplicationReadyEntry('nope'));
    clock.advance(5_000);
    const report = await mailbox.runMaintenance();
    expect(report.retired).toBe(1);
    expect(await storage.get(noncanonical)).toBeNull();
    expect(await mailbox.receipt(commandId)).toBeNull();
    mailbox.dispose();
  });
});

describe('eighteenth-round hardening', () => {
  it('reports due work behind a head that another consumer claimed between the reads', async () => {
    const storage = new MemoryStorage();
    const { mailbox } = createMailboxFixture({ storage, generateId: createIdSource('w') });
    const other = createMailboxFixture({ storage, generateId: createIdSource('o') }).mailbox;
    await admitOne(mailbox, { idempotencyKey: 'a' });
    await admitOne(mailbox, { idempotencyKey: 'b' });
    // The first entry's record is claimed between the index read and the
    // record read; the second command is the claimable head the whole time.
    const originalGet = storage.get.bind(storage);
    let raced = false;
    storage.get = async (key: string): Promise<Uint8Array | null> => {
      if (!raced && key.startsWith('appcmd:')) {
        raced = true;
        await other.claim();
      }
      return originalGet(key);
    };
    expect(await mailbox.waitForAvailable({ timeoutMs: 0 })).toBe(true);
    expect(raced).toBe(true);
    other.dispose();
    mailbox.dispose();
  });

  it('reports held, not due, when the first genuine head is not yet available', async () => {
    const { mailbox } = createMailboxFixture({ generateId: createIdSource('c') });
    await admitOne(mailbox, { idempotencyKey: 'a', availableAfterMs: 60_000 });
    await admitOne(mailbox, { idempotencyKey: 'b' });
    // Strict FIFO never skips a held head to a later due command.
    expect(await mailbox.waitForAvailable({ timeoutMs: 0 })).toBe(false);
    mailbox.dispose();
  });

  it('fails closed on terminal cleanup fields no transition writes', async () => {
    const { mailbox, storage } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    await mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken });
    const key = KEYS.applicationCommand('bureau', 'agent-7', commandId);
    const applied = decode((await storage.get(key)) as Uint8Array) as Record<string, unknown>;
    // An abandoned attempt without the cleanup flag, on a disposition that
    // cannot abandon one.
    await storage.put(key, encode({ ...applied, abandonedAttemptToken: 't' }));
    await expect(mailbox.receipt(commandId)).rejects.toThrow(PersistedDataCorruptError);
    // The flag without the attempt it would name.
    await storage.put(
      key,
      encode({
        ...applied,
        state: 'dead-lettered',
        failure: { reason: 'deadline-exceeded' },
        cleanupPending: true,
      }),
    );
    await expect(mailbox.receipt(commandId)).rejects.toThrow(PersistedDataCorruptError);
    // Both, on a disposition that abandons a lease: legal.
    await storage.put(
      key,
      encode({
        ...applied,
        state: 'dead-lettered',
        failure: { reason: 'deadline-exceeded' },
        cleanupPending: true,
        abandonedAttemptToken: 't',
      }),
    );
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.cleanupPending).toBe(true);
    mailbox.dispose();
  });

  it('exposes the wait budget error as a public coded error', () => {
    const error = new WaitBudgetElapsedError();
    expect(error.code).toBe('WaitBudgetElapsedError');
    expect(error).toBeInstanceOf(Error);
  });

  it('counts lost housekeeping compare-and-swaps as contention', async () => {
    const storage = new MemoryStorage();
    const { mailbox } = createMailboxFixture({ storage });
    // An orphaned delivery-index entry whose record does not exist.
    await storage.put(
      KEYS.applicationCommandReady('bureau', 'agent-7', 0),
      encodeApplicationReadyEntry('ghost'),
    );
    // Every attempt to discard it loses its compare-and-swap.
    const original = storage.conditionalBatch.bind(storage);
    let losses = 0;
    storage.conditionalBatch = async (
      ...args: Parameters<MemoryStorage['conditionalBatch']>
    ): Promise<boolean> => {
      const [, operations] = args;
      if (operations.length === 1 && operations[0]?.type === 'delete') {
        losses += 1;
        return false;
      }
      return original(...args);
    };
    await expect(mailbox.claim()).rejects.toThrow(ApplicationMailboxContentionError);
    expect(losses).toBe(25);
    mailbox.dispose();
  });
});

describe('attempt registry index', () => {
  it('indexes registrations by command and keeps the index in step with the map', () => {
    const registry = new AttemptRegistry();
    const registration = (commandId: string): AttemptRegistration => ({
      controller: new AbortController(),
      release: () => {},
      commandId,
      committedSerial: null,
    });
    registry.set('a1', registration('a'));
    registry.set('a2', registration('a'));
    registry.set('b1', registration('b'));
    expect(registry.tokensFor('a').sort()).toEqual(['a1', 'a2']);
    expect(registry.tokensFor('b')).toEqual(['b1']);
    expect(registry.tokensFor('c')).toEqual([]);
    expect(registry.delete('a1')).toBe(true);
    expect(registry.delete('a1')).toBe(false);
    expect(registry.tokensFor('a')).toEqual(['a2']);
    registry.delete('a2');
    expect(registry.tokensFor('a')).toEqual([]);
    registry.clear();
    expect(registry.size).toBe(0);
    expect(registry.tokensFor('b')).toEqual([]);
  });
});

describe('eighteenth-round hardening, continued', () => {
  it('releases local attempts when cancellation finds the command terminalized elsewhere', async () => {
    const storage = new MemoryStorage();
    const clock = createMailboxClock();
    const local = createMailboxFixture({
      storage,
      clock,
      visibilityTimeoutMs: 500,
      retryBackoffMs: 1,
      generateId: createIdSource('l'),
    }).mailbox;
    const remote = new ApplicationMailbox({
      storage: remoteView(storage),
      namespace: 'bureau',
      resourceId: 'agent-7',
      now: clock.now,
      generateId: createIdSource('r'),
      visibilityTimeoutMs: 500,
      retryBackoffMs: 1,
    });
    const commandId = await admitOne(local);
    const claim = await claimOne(local);
    clock.advance(501);
    await remote.runMaintenance();
    clock.advance(10);
    const reclaimed = await remote.claim();
    expect(reclaimed.status).toBe('claimed');
    if (reclaimed.status !== 'claimed') return;
    await remote.acknowledge({ commandId, attemptToken: reclaimed.claim.attemptToken });
    expect(claim.signal.aborted).toBe(false);

    const cancelled = await local.requestCancellation({ commandId });
    expect(cancelled.status).toBe('already-terminal');
    expect(claim.signal.aborted).toBe(true);
    expect(attemptControllerRegistry(storage, 'bureau', 'agent-7').has(claim.attemptToken)).toBe(
      false,
    );
    remote.dispose();
    local.dispose();
  });

  it('releases local attempts when retention retires a command the scan cursor skipped', async () => {
    const storage = new MemoryStorage();
    const clock = createMailboxClock();
    const local = createMailboxFixture({
      storage,
      clock,
      maintenanceBatchSize: 1,
      visibilityTimeoutMs: 500,
      retryBackoffMs: 1,
      terminalRetentionMs: 1_000,
      generateId: createIdSource('c'),
    }).mailbox;
    const remote = new ApplicationMailbox({
      storage: remoteView(storage),
      namespace: 'bureau',
      resourceId: 'agent-7',
      now: clock.now,
      generateId: createIdSource('r'),
      visibilityTimeoutMs: 500,
      retryBackoffMs: 1,
      terminalRetentionMs: 1_000,
    });
    // More records than the page cap, so the local pass leaves a cursor past
    // the first command.
    const first = await admitOne(local, { idempotencyKey: 'k-0' });
    for (let index = 1; index <= 201; index += 1) {
      await admitOne(local, { idempotencyKey: `k-${index}` });
    }
    const claim = await claimOne(local);
    expect(claim.commandId).toBe(first);
    await local.runMaintenance();
    // Another process reclaims, re-delivers, and settles the first command.
    clock.advance(501);
    await remote.runMaintenance();
    clock.advance(10);
    const reclaimed = await remote.claim();
    expect(reclaimed.status === 'claimed' && reclaimed.claim.receipt.commandId).toBe(first);
    if (reclaimed.status !== 'claimed') return;
    await remote.acknowledge({ commandId: first, attemptToken: reclaimed.claim.attemptToken });
    clock.advance(5_000);
    expect(claim.signal.aborted).toBe(false);
    // The local scan resumes past the first command; retention still retires it.
    const report = await local.runMaintenance();
    expect(report.retired).toBe(1);
    expect(claim.signal.aborted).toBe(true);
    remote.dispose();
    local.dispose();
  });
});
