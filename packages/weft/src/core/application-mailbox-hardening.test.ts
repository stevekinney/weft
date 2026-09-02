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
  flushMicrotasks,
  restoreRealTimers,
  useFakeTimers,
} from '../testing/fake-timers.test-support.ts';
import { encodeApplicationReadyEntry } from './application-mailbox-codec.ts';
import {
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
          failure: { reason },
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
