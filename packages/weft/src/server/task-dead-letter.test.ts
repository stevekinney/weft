/**
 * COR-205 ("Canonical Provenance Types") — dead-lettering, hostile decode,
 * and bounded retention/purge of {@link TaskAttemptRecord}.
 *
 * Required fixtures covered here: recoverable completed-result dead letter,
 * malformed stored identity, purge, retention. (`task-dispatch-provenance.test.ts`
 * covers the other ten: same-worker retry, same-worker new session
 * generation, different-worker retry, different-build retry, conditional
 * claim loss, heartbeat, cancellation, disconnect, restart, terminal result.)
 */

import { describe, expect, it } from 'bun:test';

import { encode } from '../core/codec.ts';
import {
  decodeTaskAttemptRecord,
  taskAttemptKey,
  taskAttemptPrefix,
} from '../core/task-ledger/task-attempt.ts';
import { markWorkflowResultAdopted } from '../core/task-ledger/task-ledger-transitions.ts';
import {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskRecord,
  type RemoteTaskTerminal,
} from '../core/task-ledger/task-ledger.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { sha256HexSync } from '../worker/manifest/content-digest.ts';
import {
  manifestForActivities,
  TEST_ACCEPTED_MANIFEST_DIGEST,
} from '../worker/registry-fixtures.test-support.ts';
import { clearTaskDeadLetterOperation } from './operations/clear-task-dead-letter.ts';
import { createEngine, runGetTaskDetail } from './operations/get-task-detail.test-support.ts';
import {
  FailingTerminalCommitStorage,
  minimalServeOptions,
  minimalServerContext,
} from './runtime/server-context.test-support.ts';
import { dispatchTaskImpl } from './runtime/task-dispatch.ts';
import { reconcileOrphanedRecords } from './runtime/task-reconciliation.ts';
import { applyWorkerTaskResult } from './runtime/task-result-application.ts';

import type { ServeOptions } from './index.ts';
import type { ServerContext } from './runtime/context.ts';

const NOOP_CLEANUP = (_operationId: string) => {};

function registerWorker(context: ServerContext, workerId: string): void {
  context.registry.register({
    manifest: manifestForActivities(['test.charge']),
    acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
    id: workerId,
    queue: 'default',
    activities: ['test.charge'],
    concurrency: 5,
  });
}

function attachSocket(context: ServerContext, workerId: string): string[] {
  const sent: string[] = [];
  context.workerSockets.set(workerId, { send: (msg: string) => sent.push(msg) } as never);
  return sent;
}

function extractAttemptToken(sentMessages: readonly string[]): string {
  const last = sentMessages.at(-1);
  if (last === undefined) throw new Error('Expected at least one sent message');
  return (JSON.parse(last) as { attemptToken: string }).attemptToken;
}

async function readAttempt(options: ServeOptions, operationId: string, attemptToken: string) {
  const digest = sha256HexSync(attemptToken);
  return decodeTaskAttemptRecord(
    await options.engine.storage.get(taskAttemptKey(operationId, digest)),
  );
}

async function listAttemptKeys(options: ServeOptions, operationId: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const [key] of options.engine.storage.scan(taskAttemptPrefix(operationId))) {
    keys.push(key);
  }
  return keys;
}

describe('COR-205 dead-letter, hostile decode, purge, and retention', () => {
  it('recoverable completed-result dead letter: the attempt record survives, marked deadLettered', async () => {
    const storage = new FailingTerminalCommitStorage('op-dead-letter');
    const options = minimalServeOptions(storage);
    const context = minimalServerContext();
    registerWorker(context, 'w-1');
    const sent = attachSocket(context, 'w-1');

    await dispatchTaskImpl(context, options, {
      operationId: 'op-dead-letter',
      workflowType: 'test',
      activityName: 'test.charge',
      queue: 'default',
      input: null,
    });
    const attemptToken = extractAttemptToken(sent);

    const applied = await applyWorkerTaskResult(
      options,
      undefined,
      {
        operationId: 'op-dead-letter',
        attemptToken,
        status: 'completed',
        value: { orderId: 'order-1' },
      },
      'w-1',
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error('Expected the result to be dead-lettered, not rejected');
    expect(applied.disposition).toBe('dead-lettered');

    const ledgerRecord = decodeRemoteTaskRecord(await storage.get(taskLedgerKey('op-dead-letter')));
    expect(ledgerRecord?.state).toBe('deadLettered');

    const attempt = await readAttempt(options, 'op-dead-letter', attemptToken);
    if (attempt === null) throw new Error('Expected the dead-lettered attempt to remain durable');
    expect(attempt.disposition).toBe('deadLettered');
    expect(attempt.dispositionReason).toBeDefined();
    // Never the raw token, even in the failure path (criteria 8 and 10).
    expect(JSON.stringify(attempt)).not.toContain(attemptToken);
  });

  it('malformed stored identity: a corrupt attempt record decodes to null and is silently excluded from history', async () => {
    const storage = new MemoryStorage();
    const options = minimalServeOptions(storage);
    const context = minimalServerContext();
    const engine = createEngine(storage);
    registerWorker(context, 'w-1');
    const sent = attachSocket(context, 'w-1');

    await dispatchTaskImpl(context, options, {
      operationId: 'op-malformed-attempt',
      workflowType: 'test',
      activityName: 'test.charge',
      queue: 'default',
      input: null,
    });
    const attemptToken = extractAttemptToken(sent);
    const digest = sha256HexSync(attemptToken);
    const key = taskAttemptKey('op-malformed-attempt', digest);

    // Overwrite the genuine record with a hostile/corrupted one — missing
    // required fields, exactly like `decodeRemoteTaskRecord`'s own
    // malformed-record contract.
    await storage.put(key, encode({ recordVersion: 1, operationId: 'op-malformed-attempt' }));
    expect(decodeTaskAttemptRecord(await storage.get(key))).toBeNull();

    // The read surface must not throw or 500 on a corrupt attempt record —
    // it excludes it from history rather than crashing the whole task-detail
    // read (which serves fields the ledger itself still proves fine).
    const result = await runGetTaskDetail(engine, 'op-malformed-attempt');
    if (!result.ok) throw new Error('Expected weft.tasks.get to still succeed');
    expect(result.value.attempts).toHaveLength(0);
    expect(result.value.state).toBe('leased');
  });

  function terminalFixture(overrides: Partial<RemoteTaskTerminal> = {}): RemoteTaskTerminal {
    const now = Date.now();
    return {
      recordVersion: 1,
      operationId: 'op-terminal',
      workflowType: 'test',
      activityName: 'test.charge',
      queue: 'default',
      input: null,
      headers: {},
      visibilityTimeoutMilliseconds: 30_000,
      createdAt: now,
      generation: 3,
      state: 'terminal',
      disposition: 'resolved',
      attempt: 1,
      attemptToken: 'attempt-token',
      status: 'completed',
      resultDigest: 'digest',
      terminalAt: now,
      adopted: false,
      retentionGeneration: 0,
      ...overrides,
    } as RemoteTaskTerminal;
  }

  async function putTerminalWithAttempt(
    storage: MemoryStorage,
    terminal: RemoteTaskTerminal,
  ): Promise<void> {
    await storage.put(taskLedgerKey(terminal.operationId), encodeRemoteTaskRecord(terminal));
    if (terminal.disposition !== 'resolved') return;
    const digest = sha256HexSync(terminal.attemptToken);
    await storage.put(
      taskAttemptKey(terminal.operationId, digest),
      encode({
        recordVersion: 1,
        operationId: terminal.operationId,
        attempt: terminal.attempt,
        attemptTokenDigest: digest,
        workerSessionId: 'w-1',
        claimedAt: terminal.terminalAt - 1_000,
        disposition: 'resolved',
        dispositionAt: terminal.terminalAt,
      }),
    );
  }

  it('purge: reaping a retained terminal record removes its attempt history in the same bounded operation', async () => {
    const storage = new MemoryStorage();
    const context = minimalServerContext();
    const options = { ...minimalServeOptions(storage), taskRetentionWindowMs: 1_000 };
    const terminal = terminalFixture({
      operationId: 'op-purge',
      adopted: true,
      adoptedAt: Date.now() - 5_000,
    });
    await putTerminalWithAttempt(storage, terminal);
    expect(await listAttemptKeys(options, 'op-purge')).toHaveLength(1);

    await reconcileOrphanedRecords(context, options, NOOP_CLEANUP);

    expect(await storage.get(taskLedgerKey('op-purge'))).toBeNull();
    expect(await listAttemptKeys(options, 'op-purge')).toHaveLength(0);
  });

  it('retention: an adopted terminal record still inside its retention window keeps both the ledger record and its attempt history', async () => {
    const storage = new MemoryStorage();
    const context = minimalServerContext();
    const options = { ...minimalServeOptions(storage), taskRetentionWindowMs: 60_000 };
    const terminal = terminalFixture({
      operationId: 'op-retained',
      adopted: true,
      adoptedAt: Date.now(),
    });
    await putTerminalWithAttempt(storage, terminal);

    await reconcileOrphanedRecords(context, options, NOOP_CLEANUP);

    expect(decodeRemoteTaskRecord(await storage.get(taskLedgerKey('op-retained')))).not.toBeNull();
    expect(await listAttemptKeys(options, 'op-retained')).toHaveLength(1);
  });

  it('clearing a dead-lettered diagnostic also removes its attempt history atomically', async () => {
    const storage = new MemoryStorage();
    const engine = { storage };
    const digest = sha256HexSync('dl-attempt-token');
    const deadLettered: RemoteTaskRecord = {
      recordVersion: 1,
      operationId: 'op-clear-dl',
      workflowType: 'test',
      activityName: 'test.charge',
      queue: 'default',
      input: null,
      headers: {},
      visibilityTimeoutMilliseconds: 30_000,
      createdAt: Date.now(),
      generation: 4,
      state: 'deadLettered',
      attemptToken: 'dl-attempt-token',
      attempt: 1,
      pendingStatus: 'completed',
      pendingResultDigest: 'digest',
      deadLetteredAt: Date.now(),
      persistenceFailureReason: 'storage retries exhausted',
      retryCount: 0,
      requeueCount: 0,
    };
    await storage.put(taskLedgerKey('op-clear-dl'), encodeRemoteTaskRecord(deadLettered));
    await storage.put(
      taskAttemptKey('op-clear-dl', digest),
      encode({
        recordVersion: 1,
        operationId: 'op-clear-dl',
        attempt: 1,
        attemptTokenDigest: digest,
        workerSessionId: 'w-1',
        claimedAt: Date.now() - 1_000,
        disposition: 'deadLettered',
        dispositionAt: Date.now(),
      }),
    );

    const result = await clearTaskDeadLetterOperation.invoke({
      input: { operationId: 'op-clear-dl' },
      engine: engine as never,
    } as never);
    expect(result).toEqual({ ok: true });
    expect(await storage.get(taskLedgerKey('op-clear-dl'))).toBeNull();
    expect(await storage.get(taskAttemptKey('op-clear-dl', digest))).toBeNull();
  });

  it('markWorkflowResultAdopted does not itself touch attempt history — adoption is a ledger-only transition', async () => {
    // Sanity check that criterion 13's boundary holds: adopting a result
    // (moving `adopted: false -> true`) is a pure ledger transition and
    // never reads or writes the `task-attempt:` keyspace.
    const terminal = terminalFixture({ operationId: 'op-adopt', resultDigest: 'digest-1' });
    const adopted = markWorkflowResultAdopted(
      terminal,
      { expectedResultDigest: 'digest-1' },
      Date.now(),
    );
    expect(adopted.ok).toBe(true);
    if (adopted.ok) {
      expect(adopted.nextRecord.adopted).toBe(true);
    }
  });
});
