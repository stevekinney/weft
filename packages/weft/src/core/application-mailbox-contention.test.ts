/**
 * Sustained-contention and event-sink classification for the durable
 * application command mailbox (WFT-84).
 *
 * Every mutation retries a bounded number of times against fresh durable state
 * and then gives up loudly. Surfacing that as a typed error beats spinning: it
 * tells the operator that contention on one mailbox is real, and it keeps a
 * pathological loop from looking like a hang.
 *
 * The event-sink half proves how a failed append is classified — a lost
 * compare-and-swap must be retried, while a genuine sink failure must
 * propagate rather than be swallowed as a race.
 */

import { describe, expect, it } from 'bun:test';

import type { BatchOperation, ConditionalBatchCondition } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { ApplicationMailboxContentionError } from './application-mailbox-internals.ts';
import { ApplicationCommandValidationError } from './application-mailbox-validation.ts';
import {
  admitOne,
  claimOne,
  commandInput,
  createMailboxFixture,
  RecordingEventSink,
} from './application-mailbox.test-support.ts';

/**
 * A backend whose conditional batch stops committing after `after` successful
 * calls, standing in for a mailbox another writer is hammering.
 */
class ContendedStorage extends MemoryStorage {
  #remaining: number;

  constructor(after: number) {
    super();
    this.#remaining = after;
  }

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    if (this.#remaining <= 0) return false;
    this.#remaining -= 1;
    return super.conditionalBatch(conditions, operations);
  }
}

describe('ApplicationMailbox sustained contention', () => {
  it('gives up loudly on admission rather than spinning', async () => {
    const { mailbox } = createMailboxFixture({ storage: new ContendedStorage(0) });
    await expect(mailbox.admit(commandInput())).rejects.toThrow(ApplicationMailboxContentionError);
    await expect(mailbox.admit(commandInput())).rejects.toThrow(/after 25 attempts/);
    mailbox.dispose();
  });

  it('gives up loudly on a claim', async () => {
    const storage = new ContendedStorage(1);
    const { mailbox } = createMailboxFixture({ storage });
    await admitOne(mailbox);
    await expect(mailbox.claim()).rejects.toThrow(ApplicationMailboxContentionError);
    mailbox.dispose();
  });

  it.each([
    [
      'renew',
      (mailbox: ReturnType<typeof createMailboxFixture>['mailbox'], id: string, token: string) =>
        mailbox.renew({ commandId: id, attemptToken: token }),
    ],
    [
      'acknowledge',
      (mailbox: ReturnType<typeof createMailboxFixture>['mailbox'], id: string, token: string) =>
        mailbox.acknowledge({ commandId: id, attemptToken: token }),
    ],
    [
      'reject',
      (mailbox: ReturnType<typeof createMailboxFixture>['mailbox'], id: string, token: string) =>
        mailbox.reject({ commandId: id, attemptToken: token, failure: { reason: 'application' } }),
    ],
    [
      'cancel',
      (mailbox: ReturnType<typeof createMailboxFixture>['mailbox'], id: string) =>
        mailbox.requestCancellation({ commandId: id }),
    ],
  ])('gives up loudly on %s, naming the command', async (operation, run) => {
    const storage = new ContendedStorage(2);
    const { mailbox } = createMailboxFixture({ storage });
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);

    const failure = run(mailbox, commandId, claim.attemptToken);
    await expect(failure).rejects.toThrow(ApplicationMailboxContentionError);
    await expect(run(mailbox, commandId, claim.attemptToken)).rejects.toThrow(
      new RegExp(`${operation} for command "${commandId}"`),
    );
    mailbox.dispose();
  });

  it('gives up loudly during maintenance', async () => {
    const storage = new ContendedStorage(2);
    const { mailbox, clock } = createMailboxFixture({ storage, visibilityTimeoutMs: 100 });
    const commandId = await admitOne(mailbox);
    await claimOne(mailbox);

    clock.advance(101);
    await expect(mailbox.runMaintenance()).rejects.toThrow(ApplicationMailboxContentionError);
    await expect(mailbox.runMaintenance()).rejects.toThrow(
      new RegExp(`maintenance for command "${commandId}"`),
    );
    mailbox.dispose();
  });

  it('carries the operation and command as structured fields', () => {
    const withCommand = new ApplicationMailboxContentionError('claim', 'c-1');
    expect(withCommand.code).toBe('ApplicationMailboxContentionError');
    expect(withCommand.operation).toBe('claim');
    expect(withCommand.commandId).toBe('c-1');
    expect(withCommand.message).toContain('for command "c-1"');

    const mailboxWide = new ApplicationMailboxContentionError('admit', null);
    expect(mailboxWide.commandId).toBeNull();
    expect(mailboxWide.message).not.toContain('for command');
  });
});

describe('ApplicationMailbox event-sink failure classification', () => {
  it('propagates a sink failure when the caller conditions still hold', async () => {
    const storage = new MemoryStorage();
    const events = new RecordingEventSink(storage);
    const { mailbox } = createMailboxFixture({ storage, events });
    // Admit one command first so the header condition carries real bytes rather
    // than the absent-key sentinel, exercising the byte comparison itself.
    await admitOne(mailbox);

    events.failure = new Error('the feed is unreachable');
    await expect(mailbox.admit(commandInput())).rejects.toThrow('the feed is unreachable');

    // Nothing new was written, so this really was the sink's failure, not a race.
    let persisted = 0;
    for await (const _entry of storage.scan(KEYS.applicationCommandPrefix('bureau', 'agent-7'))) {
      persisted += 1;
    }
    expect(persisted).toBe(1);
    mailbox.dispose();
  });

  it('retries when a caller condition changed to different bytes of the same length', async () => {
    const storage = new MemoryStorage();
    const events = new RecordingEventSink(storage);
    const { mailbox } = createMailboxFixture({ storage, events });
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);

    const key = KEYS.applicationCommand('bureau', 'agent-7', commandId);
    const originalAppend = events.append.bind(events);
    let firstCall = true;
    events.append = async (event, options): Promise<unknown> => {
      if (firstCall) {
        firstCall = false;
        // Same byte length, different content: the classifier has to walk the
        // bytes rather than shortcut on length.
        const stored = (await storage.get(key)) ?? new Uint8Array();
        const mutated = new Uint8Array(stored);
        mutated[0] = (mutated[0] ?? 0) ^ 0xff;
        await storage.put(key, mutated);
        throw new Error('append lost its precondition');
      }
      return originalAppend(event, options);
    };

    await expect(
      mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken }),
    ).rejects.toThrow(/corrupt/);
    mailbox.dispose();
  });

  it('retries rather than propagating when a condition moved underneath the append', async () => {
    const storage = new MemoryStorage();
    const events = new RecordingEventSink(storage);
    const { mailbox } = createMailboxFixture({ storage, events });
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);

    // Fail the append once and move the record in the same window, so the
    // mailbox must re-read and re-decide rather than surface the sink error.
    const key = KEYS.applicationCommand('bureau', 'agent-7', commandId);
    const originalAppend = events.append.bind(events);
    let firstCall = true;
    events.append = async (event, options): Promise<unknown> => {
      if (firstCall) {
        firstCall = false;
        // Another writer settles the command first.
        const stored = await storage.get(key);
        await storage.put(key, new Uint8Array([...(stored ?? []), 0]));
        throw new Error('append lost its precondition');
      }
      return originalAppend(event, options);
    };

    // The record is now unreadable garbage, so the retry surfaces corruption —
    // proving the mailbox re-read durable state instead of reporting the sink
    // error it was handed.
    await expect(
      mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken }),
    ).rejects.toThrow(/corrupt/);
    mailbox.dispose();
  });
});

describe('ApplicationMailbox digest failures', () => {
  it('propagates a platform digest failure instead of relabelling it as invalid input', async () => {
    const { mailbox } = createMailboxFixture();
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const failure = new Error('subtle crypto unavailable');
    Object.defineProperty(crypto.subtle, 'digest', {
      configurable: true,
      value: () => Promise.reject(failure),
    });
    try {
      // The payload is perfectly valid; blaming the caller here would send an
      // operator hunting for a bug in their command.
      await expect(mailbox.admit(commandInput())).rejects.toThrow(failure);
      await expect(mailbox.admit(commandInput())).rejects.not.toThrow(
        ApplicationCommandValidationError,
      );
    } finally {
      Object.defineProperty(crypto.subtle, 'digest', {
        configurable: true,
        value: originalDigest,
      });
    }
    mailbox.dispose();
  });
});

describe('ApplicationMailbox persisted causation', () => {
  it('restores bounded causal metadata from storage', async () => {
    const { mailbox } = createMailboxFixture();
    const commandId = await admitOne(mailbox, {
      causation: { correlationId: 'conv-7', causationId: 'msg-3', traceparent: '00-a-b-01' },
    });
    // Reading the receipt back decodes the persisted record rather than reusing
    // the in-memory one the admission returned.
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.causation).toEqual({
      correlationId: 'conv-7',
      causationId: 'msg-3',
      traceparent: '00-a-b-01',
    });
    mailbox.dispose();
  });

  it('fails closed on a malformed persisted causation block', async () => {
    const { mailbox, storage } = createMailboxFixture();
    const commandId = await admitOne(mailbox, { causation: { correlationId: 'conv-7' } });
    const key = KEYS.applicationCommand('bureau', 'agent-7', commandId);
    const { decode, encode } = await import('./codec.ts');
    const record = decode((await storage.get(key))!) as Record<string, unknown>;

    await storage.put(key, encode({ ...record, causation: 'conv-7' }));
    await expect(mailbox.receipt(commandId)).rejects.toThrow(/corrupt/);

    await storage.put(key, encode({ ...record, causation: { correlationId: 42 } }));
    await expect(mailbox.receipt(commandId)).rejects.toThrow(/corrupt/);
    mailbox.dispose();
  });
});

describe('ApplicationMailbox reference payload without a declared size', () => {
  it('admits and delivers a reference payload that omits byteLength', async () => {
    const { mailbox } = createMailboxFixture();
    await mailbox.admit(
      commandInput({
        payload: { form: 'reference', reference: 's3://assets/1', digest: 'c'.repeat(64) },
      }),
    );
    const result = await mailbox.claim();
    expect(result.status).toBe('claimed');
    if (result.status !== 'claimed' || result.claim.payload.form !== 'reference') return;
    expect(result.claim.payload.byteLength).toBeUndefined();
    expect(result.claim.payload.digest).toBe('c'.repeat(64));
    mailbox.dispose();
  });

  it('rejects a negative declared size', async () => {
    const { mailbox } = createMailboxFixture();
    await expect(
      mailbox.admit(
        commandInput({
          payload: {
            form: 'reference',
            reference: 's3://assets/1',
            digest: 'c'.repeat(64),
            byteLength: -1,
          },
        }),
      ),
    ).rejects.toThrow(/byteLength/);
    mailbox.dispose();
  });
});

describe('ApplicationMailbox retention edge cases', () => {
  it('retires a terminal index entry whose command record is already gone', async () => {
    const { mailbox, storage, clock } = createMailboxFixture({ terminalRetentionMs: 1_000 });
    const commandId = await admitOne(mailbox);
    const claim = await claimOne(mailbox);
    await mailbox.acknowledge({ commandId, attemptToken: claim.attemptToken });

    await storage.delete(KEYS.applicationCommand('bureau', 'agent-7', commandId));
    clock.advance(1_001);
    const report = await mailbox.runMaintenance();
    expect(report.retired).toBe(1);

    let remaining = 0;
    for await (const _entry of storage.scan(
      KEYS.applicationCommandTerminalPrefix('bureau', 'agent-7'),
    )) {
      remaining += 1;
    }
    expect(remaining).toBe(0);
    mailbox.dispose();
  });

  it('ignores a terminal index entry whose key cannot be parsed', async () => {
    const { mailbox, storage, clock } = createMailboxFixture({ terminalRetentionMs: 1_000 });
    const prefix = KEYS.applicationCommandTerminalPrefix('bureau', 'agent-7');
    const { encode } = await import('./codec.ts');
    // A malformed suffix and an undecodable command component: neither may crash
    // the sweep, neither may be counted as retired, and neither may stay behind
    // to stall every later pass at the front of the index.
    await storage.put(`${prefix}not-a-timestamp`, encode('x'));
    await storage.put(`${prefix}${'0'.repeat(16)}:%zz`, encode('x'));

    clock.advance(2_000);
    const report = await mailbox.runMaintenance();
    expect(report.retired).toBe(0);
    expect(await storage.get(`${prefix}not-a-timestamp`)).toBeNull();
    expect(await storage.get(`${prefix}${'0'.repeat(16)}:%zz`)).toBeNull();
    mailbox.dispose();
  });

  it('does nothing when the clock has not yet reached the retention window', async () => {
    const { mailbox } = createMailboxFixture({ terminalRetentionMs: 1_000 });
    // `now` is far below the retention window, so the horizon is negative and
    // the sweep must not treat every record as expired.
    const report = await mailbox.runMaintenance(500);
    expect(report.retired).toBe(0);
    mailbox.dispose();
  });
});
