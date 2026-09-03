/**
 * Core contract for the durable application command mailbox (WFT-84):
 * admission, idempotency, receipts, bounded listing, backlog policy, payload
 * identity, and fail-closed diagnostics.
 *
 * Concurrency, recovery, liveness, and shutdown each have their own file.
 */

import { describe, expect, it } from 'bun:test';

import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { ApplicationCommandValidationError } from './application-mailbox-validation.ts';
import {
  admitOne,
  claimOne,
  commandInput,
  createMailboxFixture,
  RecordingEventSink,
} from './application-mailbox.test-support.ts';
import { ApplicationMailbox } from './application-mailbox.ts';
import { decode, encode } from './codec.ts';
import { PersistedDataCorruptError } from './persisted-data-incompatible-error.ts';

describe('ApplicationMailbox construction', () => {
  it('rejects storage without conditional batch support', () => {
    const storage = new MemoryStorage();
    // Subclass rather than spread: spreading an instance drops its prototype,
    // and the mailbox has to reject the adapter for its reported capability,
    // not for being structurally broken.
    class WithoutConditionalBatch extends MemoryStorage {
      override capabilities(): ReturnType<MemoryStorage['capabilities']> {
        return { ...super.capabilities(), conditionalBatch: false };
      }
    }
    void storage;
    expect(
      () =>
        new ApplicationMailbox({
          storage: new WithoutConditionalBatch(),
          namespace: 'n',
          resourceId: 'r',
        }),
    ).toThrow(ApplicationCommandValidationError);
  });

  it('exposes the scope it was built for', () => {
    const { mailbox } = createMailboxFixture();
    expect(mailbox.namespace).toBe('bureau');
    expect(mailbox.resourceId).toBe('agent-7');
    expect(mailbox.storage).toBeInstanceOf(MemoryStorage);
    mailbox.dispose();
  });

  it.each([
    ['namespace', { namespace: '' }],
    ['resourceId', { resourceId: '' }],
    ['maxBacklog', { maxBacklog: 0 }],
    ['visibilityTimeoutMs', { visibilityTimeoutMs: -1 }],
    ['commandTimeoutMs', { commandTimeoutMs: 0 }],
    ['maxAttempts', { maxAttempts: 1_000 }],
    ['retryBackoffMs', { retryBackoffMs: 0 }],
    ['maxRetryBackoffMs', { maxRetryBackoffMs: 0 }],
    ['terminalRetentionMs', { terminalRetentionMs: 0 }],
    ['maxInlinePayloadBytes', { maxInlinePayloadBytes: 0 }],
  ])('rejects an out-of-range %s', (_name, override) => {
    expect(() => createMailboxFixture(override)).toThrow(ApplicationCommandValidationError);
  });

  it('rejects an oversized identity component', () => {
    expect(() => createMailboxFixture({ namespace: 'n'.repeat(257) })).toThrow(/at most 256 bytes/);
  });
});

describe('ApplicationMailbox admission', () => {
  it('returns a durable receipt that survives a new instance over the same storage', async () => {
    const { mailbox, storage, clock } = createMailboxFixture();
    const commandId = await admitOne(mailbox, { idempotencyKey: 'steer-1' });
    mailbox.dispose();

    const restarted = createMailboxFixture({ storage, clock }).mailbox;
    const receipt = await restarted.receipt(commandId);
    expect(receipt?.commandId).toBe(commandId);
    expect(receipt?.state).toBe('available');
    expect(receipt?.sequence).toBe(0);
    expect(receipt?.idempotencyKey).toBe('steer-1');
    restarted.dispose();
  });

  it('admits an undelayed command straight to available and a delayed one to accepted', async () => {
    const { mailbox, clock } = createMailboxFixture();
    const immediate = await mailbox.admit(commandInput({ idempotencyKey: 'a' }));
    const delayed = await mailbox.admit(
      commandInput({ idempotencyKey: 'b', availableAfterMs: 5_000 }),
    );
    expect(immediate.status === 'admitted' && immediate.receipt.state).toBe('available');
    expect(delayed.status === 'admitted' && delayed.receipt.state).toBe('accepted');
    expect(delayed.status === 'admitted' && delayed.receipt.availableAt).toBe(clock.now() + 5_000);
    mailbox.dispose();
  });

  it('assigns FIFO sequences in admission order', async () => {
    const { mailbox } = createMailboxFixture();
    const first = await mailbox.admit(commandInput({ idempotencyKey: '1' }));
    const second = await mailbox.admit(commandInput({ idempotencyKey: '2' }));
    const third = await mailbox.admit(commandInput({ idempotencyKey: '3' }));
    expect(
      [first, second, third].map((a) => a.status === 'admitted' && a.receipt.sequence),
    ).toEqual([0, 1, 2]);
    mailbox.dispose();
  });

  it('mints its own command id rather than accepting one', async () => {
    const { mailbox } = createMailboxFixture();
    const admission = await mailbox.admit(
      // A stray `commandId` is not part of the input contract and must be ignored.
      { ...commandInput(), commandId: 'caller-supplied' } as never,
    );
    expect(admission.status === 'admitted' && admission.receipt.commandId).not.toBe(
      'caller-supplied',
    );
    mailbox.dispose();
  });

  it('sets an absolute deadline that renewal can never move', async () => {
    const { mailbox, clock } = createMailboxFixture({ commandTimeoutMs: 60_000 });
    const admission = await mailbox.admit(commandInput());
    expect(admission.status === 'admitted' && admission.receipt.absoluteDeadlineAt).toBe(
      clock.now() + 60_000,
    );
    mailbox.dispose();
  });
});

describe('ApplicationMailbox idempotency', () => {
  it('returns the original receipt for an exact retry, creating no second command', async () => {
    const { mailbox } = createMailboxFixture();
    const first = await mailbox.admit(commandInput({ idempotencyKey: 'steer-1' }));
    const retry = await mailbox.admit(commandInput({ idempotencyKey: 'steer-1' }));
    expect(retry.status).toBe('duplicate');
    expect(retry.status === 'duplicate' && retry.receipt.commandId).toBe(
      first.status === 'admitted' ? first.receipt.commandId : '',
    );
    const listed = await mailbox.list();
    expect(listed.length).toBe(1);
    const capacity = await mailbox.capacity();
    expect(capacity.admitted).toBe(1);
    mailbox.dispose();
  });

  it('treats a payload whose keys were built in a different order as the same identity', async () => {
    const { mailbox } = createMailboxFixture();
    await mailbox.admit(
      commandInput({
        idempotencyKey: 'k',
        payload: { form: 'inline', value: { a: 1, b: 2, c: [3, 4] } },
      }),
    );
    const retry = await mailbox.admit(
      commandInput({
        idempotencyKey: 'k',
        payload: { form: 'inline', value: { c: [3, 4], b: 2, a: 1 } },
      }),
    );
    expect(retry.status).toBe('duplicate');
    mailbox.dispose();
  });

  it.each([
    ['caller', { caller: 'user:99' }],
    ['target', { target: 'agent:9' }],
    ['kind', { kind: 'halt' }],
    ['payload', { payload: { form: 'inline' as const, value: { text: 'go' } } }],
  ])(
    'reports a stable conflict when the %s differs, leaving the original intact',
    async (_name, override) => {
      const { mailbox } = createMailboxFixture();
      const original = await mailbox.admit(commandInput({ idempotencyKey: 'k' }));
      const originalId = original.status === 'admitted' ? original.receipt.commandId : '';
      const before = await mailbox.receipt(originalId);

      const conflict = await mailbox.admit(commandInput({ idempotencyKey: 'k', ...override }));
      expect(conflict.status).toBe('conflict');
      expect(conflict.status === 'conflict' && conflict.reason).toBe(
        'idempotency-identity-mismatch',
      );
      expect(conflict.status === 'conflict' && conflict.receipt.commandId).toBe(originalId);
      expect(await mailbox.receipt(originalId)).toEqual(before);
      const listed = await mailbox.list();
      expect(listed.length).toBe(1);
      mailbox.dispose();
    },
  );

  it('admits a distinct command for every offer when no idempotency key is given', async () => {
    const { mailbox } = createMailboxFixture();
    await mailbox.admit(commandInput());
    await mailbox.admit(commandInput());
    const listed = await mailbox.list();
    expect(listed.length).toBe(2);
    mailbox.dispose();
  });

  it('resolves a duplicate against a terminal command without reviving it', async () => {
    const { mailbox } = createMailboxFixture();
    const commandId = await admitOne(mailbox, { idempotencyKey: 'k' });
    const claim = await claimOne(mailbox);
    await mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken });

    const retry = await mailbox.admit(commandInput({ idempotencyKey: 'k' }));
    expect(retry.status).toBe('duplicate');
    expect(retry.status === 'duplicate' && retry.receipt.state).toBe('applied');
    mailbox.dispose();
  });
});

describe('ApplicationMailbox backlog policy', () => {
  it('rejects admission before persisting anything once the backlog is full', async () => {
    const { mailbox, storage } = createMailboxFixture({ maxBacklog: 2 });
    await admitOne(mailbox);
    await admitOne(mailbox);

    const rejected = await mailbox.admit(commandInput());
    expect(rejected.status).toBe('rejected');
    expect(rejected.status === 'rejected' && rejected.reason).toBe('backlog-full');
    expect(rejected.status === 'rejected' && rejected.capacity).toEqual({
      open: 2,
      limit: 2,
      remaining: 0,
      admitted: 2,
    });

    let persisted = 0;
    for await (const _entry of storage.scan(KEYS.applicationCommandPrefix('bureau', 'agent-7'))) {
      persisted += 1;
    }
    expect(persisted).toBe(2);
    mailbox.dispose();
  });

  it('frees capacity when a command reaches a terminal disposition', async () => {
    const { mailbox } = createMailboxFixture({ maxBacklog: 1 });
    const commandId = await admitOne(mailbox);
    const admission = await mailbox.admit(commandInput());
    expect(admission.status).toBe('rejected');

    const claim = await claimOne(mailbox);
    await mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken });

    expect(await mailbox.capacity()).toEqual({ open: 0, limit: 1, remaining: 1, admitted: 1 });
    const admission2 = await mailbox.admit(commandInput());
    expect(admission2.status).toBe('admitted');
    mailbox.dispose();
  });

  it('reports capacity without exposing per-command detail', async () => {
    const { mailbox } = createMailboxFixture({ maxBacklog: 10 });
    await admitOne(mailbox);
    const capacity = await mailbox.capacity();
    expect(Object.keys(capacity).toSorted()).toEqual(['admitted', 'limit', 'open', 'remaining']);
    mailbox.dispose();
  });
});

describe('ApplicationMailbox payload identity', () => {
  it('round-trips binary payload values without coercing them to text', async () => {
    const { mailbox } = createMailboxFixture();
    const attachment = new Uint8Array([0, 1, 250, 255]);
    await mailbox.admit(
      commandInput({ payload: { form: 'inline', value: { asset: attachment, kind: 'image' } } }),
    );

    const result = await mailbox.claim();
    expect(result.status).toBe('claimed');
    if (result.status !== 'claimed' || result.claim.payload.form !== 'inline') return;
    const value = result.claim.payload.value as { asset: Uint8Array; kind: string };
    expect(value.asset).toBeInstanceOf(Uint8Array);
    expect([...value.asset]).toEqual([0, 1, 250, 255]);
    expect(result.claim.payload.verified).toBe(true);
    mailbox.dispose();
  });

  it('hands back a reference payload unverified, because Weft never dereferences it', async () => {
    const { mailbox } = createMailboxFixture();
    await mailbox.admit(
      commandInput({
        payload: {
          form: 'reference',
          reference: 's3://assets/9f2c',
          digest: 'a'.repeat(64),
          byteLength: 2048,
        },
      }),
    );

    const result = await mailbox.claim();
    expect(result.status).toBe('claimed');
    if (result.status !== 'claimed' || result.claim.payload.form !== 'reference') return;
    expect(result.claim.payload).toEqual({
      form: 'reference',
      reference: 's3://assets/9f2c',
      digest: 'a'.repeat(64),
      byteLength: 2048,
      verified: false,
    });
    mailbox.dispose();
  });

  it('fails closed when a stored inline payload no longer matches its digest', async () => {
    const { mailbox, storage } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const key = KEYS.applicationCommand('bureau', 'agent-7', commandId);
    const stored = await storage.get(key);
    const record = decode(stored!) as Record<string, unknown>;
    await storage.put(key, encode({ ...record, payload: { form: 'inline', value: 'tampered' } }));

    await expect(mailbox.claim()).rejects.toThrow(PersistedDataCorruptError);
    mailbox.dispose();
  });

  it.each([
    ['a missing form', { payload: {} as never }],
    ['an unknown form', { payload: { form: 'blob' } as never }],
    ['a non-object payload', { payload: 'inline' as never }],
    ['a reference with no digest', { payload: { form: 'reference', reference: 'x' } as never }],
    [
      'a reference with a malformed digest',
      { payload: { form: 'reference', reference: 'x', digest: 'nope' } as never },
    ],
    [
      'a reference with an empty locator',
      { payload: { form: 'reference', reference: '' } as never },
    ],
  ])('rejects %s at the boundary', async (_name, override) => {
    const { mailbox } = createMailboxFixture();
    await expect(mailbox.admit(commandInput(override))).rejects.toThrow(
      ApplicationCommandValidationError,
    );
    mailbox.dispose();
  });

  it('rejects an inline payload over the configured ceiling', async () => {
    const { mailbox } = createMailboxFixture({ maxInlinePayloadBytes: 64 });
    await expect(
      mailbox.admit(commandInput({ payload: { form: 'inline', value: 'x'.repeat(512) } })),
    ).rejects.toThrow(/inline ceiling/);
    mailbox.dispose();
  });

  it('rejects a cyclic payload at the encoder, before any digest is attempted', async () => {
    const { mailbox } = createMailboxFixture();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    await expect(
      mailbox.admit(commandInput({ payload: { form: 'inline', value: cyclic } })),
    ).rejects.toThrow(/not encodable by the structured-clone codec/);
    mailbox.dispose();
  });

  it('rejects a payload the canonical digest cannot order', async () => {
    const { mailbox } = createMailboxFixture();
    // Encodes fine, but nests past the canonical digest's depth ceiling.
    let deep: unknown = 'leaf';
    for (let level = 0; level < 70; level += 1) deep = { deep };
    await expect(
      mailbox.admit(commandInput({ payload: { form: 'inline', value: deep } })),
    ).rejects.toThrow(/cannot be digested/);
    mailbox.dispose();
  });
});

describe('ApplicationMailbox input validation', () => {
  it.each([
    ['caller', { caller: '' }],
    ['target', { target: '' }],
    ['kind', { kind: '' }],
    ['idempotencyKey', { idempotencyKey: 'k'.repeat(257) }],
    ['payloadMediaType', { payloadMediaType: 'm'.repeat(257) }],
    ['payloadSchema', { payloadSchema: 's'.repeat(257) }],
    ['availableAfterMs', { availableAfterMs: -1 }],
    ['maxAttempts', { maxAttempts: 0 }],
    ['visibilityTimeoutMs', { visibilityTimeoutMs: 0 }],
    ['commandTimeoutMs', { commandTimeoutMs: -5 }],
    ['causation', { causation: 'trace' as never }],
    ['causation.correlationId', { causation: { correlationId: 'c'.repeat(257) } }],
  ])('rejects an invalid %s', async (_name, override) => {
    const { mailbox } = createMailboxFixture();
    await expect(mailbox.admit(commandInput(override))).rejects.toThrow(
      ApplicationCommandValidationError,
    );
    mailbox.dispose();
  });

  it('rejects a non-object command', async () => {
    const { mailbox } = createMailboxFixture();
    await expect(mailbox.admit(null as never)).rejects.toThrow(ApplicationCommandValidationError);
    mailbox.dispose();
  });

  it('keeps bounded causal metadata and drops an entirely empty causation object', async () => {
    const { mailbox } = createMailboxFixture();
    const withCausation = await mailbox.admit(
      commandInput({ causation: { correlationId: 'conv-7', traceparent: '00-abc-def-01' } }),
    );
    const withoutCausation = await mailbox.admit(commandInput({ causation: {} }));
    expect(withCausation.status === 'admitted' && withCausation.receipt.causation).toEqual({
      correlationId: 'conv-7',
      causationId: undefined,
      traceparent: '00-abc-def-01',
    });
    expect(
      withoutCausation.status === 'admitted' && withoutCausation.receipt.causation,
    ).toBeUndefined();
    mailbox.dispose();
  });
});

describe('ApplicationMailbox observation', () => {
  it('returns null for an unknown command rather than inventing a receipt', async () => {
    const { mailbox } = createMailboxFixture();
    expect(await mailbox.receipt('nope')).toBeNull();
    mailbox.dispose();
  });

  it('never exposes the attempt token on a receipt', async () => {
    const { mailbox } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('claimed');
    expect(Object.hasOwn(receipt!, 'attemptToken')).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain(claim.attemptToken);
    mailbox.dispose();
  });

  it('gives every observer its own frozen receipt', async () => {
    const { mailbox } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const [left, right] = await Promise.all([
      mailbox.receipt(commandId),
      mailbox.receipt(commandId),
    ]);
    expect(Object.isFrozen(left)).toBe(true);
    expect(left).not.toBe(right);
    expect(left).toEqual(right);
    mailbox.dispose();
  });

  it('reading a receipt never claims or advances work', async () => {
    const { mailbox } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    await mailbox.receipt(commandId);
    await mailbox.list();
    await mailbox.capacity();
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('available');
    const claimResult = await mailbox.claim();
    expect(claimResult.status).toBe('claimed');
    mailbox.dispose();
  });

  it('lists in FIFO order and bounds the result before slicing', async () => {
    const { mailbox } = createMailboxFixture();
    for (let index = 0; index < 5; index += 1) await admitOne(mailbox);
    const all = await mailbox.list();
    expect(all.map((receipt) => receipt.sequence)).toEqual([0, 1, 2, 3, 4]);
    const bounded = await mailbox.list({ limit: 3 });
    expect(bounded.map((receipt) => receipt.sequence)).toEqual([0, 1, 2]);
    mailbox.dispose();
  });

  it('filters a listing by state', async () => {
    const { mailbox } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    await mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken });

    const listed = await mailbox.list({ states: ['applied'] });
    expect(listed.map((r) => r.state)).toEqual(['applied']);
    const listed2 = await mailbox.list({ states: ['available'] });
    expect(listed2.length).toBe(1);
    const listed3 = await mailbox.list({ states: ['claimed'] });
    expect(listed3.length).toBe(0);
    mailbox.dispose();
  });

  it('clamps an oversized listing limit and rejects a nonsensical one', async () => {
    const { mailbox } = createMailboxFixture();
    await admitOne(mailbox);
    const listed = await mailbox.list({ limit: 50_000 });
    expect(listed.length).toBe(1);
    await expect(mailbox.list({ limit: 0 })).rejects.toThrow(ApplicationCommandValidationError);
    await expect(mailbox.list({ limit: 1.5 })).rejects.toThrow(ApplicationCommandValidationError);
    mailbox.dispose();
  });
});

describe('ApplicationMailbox fleet events', () => {
  it('publishes one bounded event per state transition', async () => {
    const storage = new MemoryStorage();
    const events = new RecordingEventSink(storage);
    const { mailbox } = createMailboxFixture({ storage, events });

    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    await mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken });

    expect(events.events.map((event) => event.kind)).toEqual([
      'mailbox:command-available',
      'mailbox:command-claimed',
      'mailbox:command-applied',
    ]);
    expect(events.events[0]?.payload).toEqual({
      namespace: 'bureau',
      resourceId: 'agent-7',
      commandId,
      sequence: 0,
      state: 'available',
      commandKind: 'steer',
      target: 'agent:7',
      attempt: 0,
      retryCount: 0,
      generation: 0,
      previousState: null,
    });
    mailbox.dispose();
  });

  it('publishes no event for a lease renewal, which changes no disposition', async () => {
    const storage = new MemoryStorage();
    const events = new RecordingEventSink(storage);
    const { mailbox, clock } = createMailboxFixture({ storage, events });

    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    const beforeRenewal = events.events.length;
    clock.advance(100);
    await mailbox.renew({ commandId, attemptToken: claim.attemptToken });
    expect(events.events.length).toBe(beforeRenewal);
    mailbox.dispose();
  });

  it('distinguishes a scheduled retry from an initial admission', async () => {
    const storage = new MemoryStorage();
    const events = new RecordingEventSink(storage);
    const { mailbox } = createMailboxFixture({ storage, events, maxAttempts: 3 });

    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    await mailbox.reject({
      commandId,
      attemptToken: claim.attemptToken,
      failure: { reason: 'application' },
      retry: true,
    });

    expect(events.events.at(-1)?.kind).toBe('mailbox:command-retry-scheduled');
    mailbox.dispose();
  });
});

describe('ApplicationMailbox hostile persisted records', () => {
  it.each([
    ['command', (id: string) => KEYS.applicationCommand('bureau', 'agent-7', id)],
    ['mailbox header', () => KEYS.applicationMailbox('bureau', 'agent-7')],
  ])('fails closed on a corrupt %s record', async (_name, keyFor) => {
    const { mailbox, storage } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const key = keyFor(commandId);
    await storage.put(key, new Uint8Array([0xc1, 0xc1, 0xc1]));

    await expect(
      _name === 'command' ? mailbox.receipt(commandId) : mailbox.capacity(),
    ).rejects.toThrow(PersistedDataCorruptError);
    mailbox.dispose();
  });

  it('fails closed on a corrupt idempotency binding', async () => {
    const { mailbox, storage } = createMailboxFixture();
    await admitOne(mailbox, { idempotencyKey: 'k' });
    await storage.put(
      KEYS.applicationCommandIdempotency('bureau', 'agent-7', 'k'),
      encode({ recordVersion: 1, commandId: 42 }),
    );
    await expect(mailbox.admit(commandInput({ idempotencyKey: 'k' }))).rejects.toThrow(
      PersistedDataCorruptError,
    );
    mailbox.dispose();
  });

  it('fails closed on a corrupt delivery-index entry', async () => {
    const { mailbox, storage } = createMailboxFixture();
    await admitOne(mailbox);
    await storage.put(KEYS.applicationCommandReady('bureau', 'agent-7', 0), encode(42));
    await expect(mailbox.claim()).rejects.toThrow(PersistedDataCorruptError);
    mailbox.dispose();
  });

  it('rejects a record written by a future schema version', async () => {
    const { mailbox, storage } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const key = KEYS.applicationCommand('bureau', 'agent-7', commandId);
    const stored = await storage.get(key);
    const decoded = decode(stored!) as Record<string, unknown>;
    await storage.put(key, encode({ ...decoded, recordVersion: 2 }));
    await expect(mailbox.receipt(commandId)).rejects.toThrow(PersistedDataCorruptError);
    mailbox.dispose();
  });

  it('rejects a record carrying an unknown state', async () => {
    const { mailbox, storage } = createMailboxFixture();
    const commandId = await admitOne(mailbox);
    const key = KEYS.applicationCommand('bureau', 'agent-7', commandId);
    const stored = await storage.get(key);
    const decoded = decode(stored!) as Record<string, unknown>;
    await storage.put(key, encode({ ...decoded, state: 'levitating' }));
    await expect(mailbox.receipt(commandId)).rejects.toThrow(PersistedDataCorruptError);
    mailbox.dispose();
  });

  it('drops a delivery-index entry whose command record vanished', async () => {
    const { mailbox, storage } = createMailboxFixture();
    const first = await admitOne(mailbox);
    await admitOne(mailbox);
    await storage.delete(KEYS.applicationCommand('bureau', 'agent-7', first));

    const claimed = await mailbox.claim();
    expect(claimed.status).toBe('claimed');
    expect(claimed.status === 'claimed' && claimed.claim.receipt.sequence).toBe(1);
    expect(await storage.get(KEYS.applicationCommandReady('bureau', 'agent-7', 0))).toBeNull();
    mailbox.dispose();
  });
});

describe('ApplicationMailbox disposal', () => {
  it('refuses every operation after disposal', async () => {
    const { mailbox } = createMailboxFixture();
    mailbox.dispose();
    mailbox.dispose(); // idempotent

    await expect(mailbox.admit(commandInput())).rejects.toThrow(/disposed/);
    await expect(mailbox.receipt('x')).rejects.toThrow(/disposed/);
    await expect(mailbox.list()).rejects.toThrow(/disposed/);
    await expect(mailbox.capacity()).rejects.toThrow(/disposed/);
    await expect(mailbox.claim()).rejects.toThrow(/disposed/);
    await expect(mailbox.runMaintenance()).rejects.toThrow(/disposed/);
    await expect(mailbox.cleanupState('x')).rejects.toThrow(/disposed/);
    await expect(mailbox.waitForAvailable()).rejects.toThrow(/disposed/);
    await expect(mailbox.requestCancellation({ commandId: 'x' })).rejects.toThrow(/disposed/);
  });

  it('supports `using` disposal', async () => {
    const storage = new MemoryStorage();
    {
      using mailbox = new ApplicationMailbox({ storage, namespace: 'n', resourceId: 'r' });
      await mailbox.admit(commandInput());
    }
    // The durable work outlives the disposed handle.
    const reopened = new ApplicationMailbox({ storage, namespace: 'n', resourceId: 'r' });
    const listed = await reopened.list();
    expect(listed.length).toBe(1);
    reopened.dispose();
  });
});
