/**
 * COR-205 ("Canonical Provenance Types") — durable per-attempt provenance
 * (`TaskAttemptRecord`) proved end to end through the real dispatch, retry,
 * disconnect, restart, heartbeat, cancellation, and completion paths.
 *
 * Complements the pure transition tests in `task-ledger-transitions.test.ts`
 * (which never touch `TaskAttemptRecord`) and the schema/codec tests in
 * `task-ledger.test.ts`: this file proves the RUNTIME wiring —
 * `commitTaskLedgerTransition`'s `buildAdditionalWrites` — actually produces,
 * updates, and retains the right attempt records at the right call sites.
 *
 * Required fixtures covered here: same-worker retry, same-worker new session
 * generation, different-worker retry, different-build retry, conditional
 * claim loss, heartbeat, cancellation, disconnect, restart, terminal result.
 * (`task-dead-letter.test.ts` covers the remaining four: recoverable
 * completed-result dead letter, malformed stored identity, purge, retention.)
 */

import { describe, expect, it } from 'bun:test';

import {
  decodeTaskAttemptRecord,
  taskAttemptKey,
  taskAttemptPrefix,
} from '../core/task-ledger/task-attempt.ts';
import {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskLeased,
} from '../core/task-ledger/task-ledger.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { sha256HexSync } from '../worker/manifest/content-digest.ts';
import {
  manifestForActivities,
  TEST_ACCEPTED_MANIFEST_DIGEST,
} from '../worker/registry-fixtures.test-support.ts';
import { createEngine, runGetTaskDetail } from './operations/get-task-detail.test-support.ts';
import {
  minimalServeOptions,
  minimalServerContext,
} from './runtime/server-context.test-support.ts';
import { cancelTask, dispatchTaskImpl } from './runtime/task-dispatch.ts';
import { commitTaskLedgerCompletion } from './runtime/task-ledger-completion.ts';
import { runTaskLedgerRecovery } from './runtime/task-ledger-recovery.ts';
import { handleTaskHeartbeatRequest } from './runtime/task-polling.ts';
import {
  reassignOrExpireTask,
  taskDispatchFromLedgerRecord,
} from './runtime/task-reconciliation.ts';
import { runWorkerDisconnectRequeue } from './runtime/worker-disconnect-requeue.ts';

import type { ServeOptions } from './index.ts';
import type { ServerContext } from './runtime/context.ts';

const NOOP_CLEANUP = (_operationId: string) => {};

/** Read one attempt record by its raw (never-persisted) attempt token. */
async function readAttempt(options: ServeOptions, operationId: string, attemptToken: string) {
  const digest = sha256HexSync(attemptToken);
  const bytes = await options.engine.storage.get(taskAttemptKey(operationId, digest));
  return decodeTaskAttemptRecord(bytes);
}

/** Every attempt record currently stored for one operation, for existence/count assertions. */
async function listAttemptKeys(options: ServeOptions, operationId: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const [key] of options.engine.storage.scan(taskAttemptPrefix(operationId))) {
    keys.push(key);
  }
  return keys;
}

function registerWorker(
  context: ServerContext,
  workerId: string,
  activity: string,
  overrides: Parameters<typeof manifestForActivities>[1] = {},
): void {
  context.registry.register({
    manifest: manifestForActivities([activity], overrides),
    acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
    id: workerId,
    queue: 'default',
    activities: [activity],
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
  const parsed = JSON.parse(last) as { attemptToken: string };
  return parsed.attemptToken;
}

describe('COR-205 durable attempt provenance', () => {
  it('criterion 1: a successful claim writes a complete durable attempt record before the task frame is sent', async () => {
    const storage = new MemoryStorage();
    const options = minimalServeOptions(storage);
    const context = minimalServerContext();
    registerWorker(context, 'w-1', 'test.charge', {
      deployment: { name: 'checkout', buildId: 'b1', artifactDigest: 'sha256:b1' },
    });
    const sent = attachSocket(context, 'w-1');

    const dispatched = await dispatchTaskImpl(context, options, {
      operationId: 'op-claim',
      workflowType: 'test',
      activityName: 'test.charge',
      queue: 'default',
      input: { amount: 1 },
    });
    expect(dispatched).toBe(true);
    expect(sent).toHaveLength(1);

    const attemptToken = extractAttemptToken(sent);
    const attempt = await readAttempt(options, 'op-claim', attemptToken);
    if (attempt === null) throw new Error('Expected a durable attempt record');
    expect(attempt.operationId).toBe('op-claim');
    expect(attempt.attempt).toBe(1);
    expect(attempt.workerSessionId).toBe('w-1');
    expect(attempt.disposition).toBe('leased');
    expect(attempt.sessionGeneration).toBe(1);
    expect(attempt.executionIdentity?.buildId).toBe('b1');
    // Never the raw token — only its digest, and the digest matches
    // `sha256HexSync(attemptToken)` exactly (criteria 8 and 10).
    expect(attempt.attemptTokenDigest).toBe(sha256HexSync(attemptToken));
    expect(JSON.stringify(attempt)).not.toContain(attemptToken);
  });

  it('criterion 2: a claim that loses its conditional write produces no attempt record and releases capacity', async () => {
    const storage = new MemoryStorage();
    const options = minimalServeOptions(storage);
    const context = minimalServerContext();
    registerWorker(context, 'w-1', 'test.charge');
    attachSocket(context, 'w-1');

    // Another actor already owns this operationId durably (already leased) —
    // `dispatchTaskImpl` has no in-memory record of it, so it reaches the
    // durable claim attempt and loses.
    const alreadyLeased: RemoteTaskLeased = {
      recordVersion: 1,
      operationId: 'op-race',
      workflowType: 'test',
      activityName: 'test.charge',
      queue: 'default',
      input: null,
      headers: {},
      visibilityTimeoutMilliseconds: 30_000,
      createdAt: Date.now(),
      generation: 1,
      state: 'leased',
      attemptToken: 'other-actor-token',
      workerSessionId: 'someone-else',
      attempt: 1,
      leaseDeadline: Date.now() + 30_000,
      firstQueuedAt: Date.now(),
      lastQueuedAt: Date.now(),
      startedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      retryCount: 0,
      requeueCount: 0,
    };
    await storage.put(taskLedgerKey('op-race'), encodeRemoteTaskRecord(alreadyLeased));

    const dispatched = await dispatchTaskImpl(context, options, {
      operationId: 'op-race',
      workflowType: 'test',
      activityName: 'test.charge',
      queue: 'default',
      input: null,
    });

    expect(dispatched).toBe(false);
    expect(context.registry.isAssigned('op-race')).toBe(false);
    expect(await listAttemptKeys(options, 'op-race')).toHaveLength(0);
  });

  it('criteria 4 and 5: same-worker retry retains the prior attempt and keys the new one by its own digest', async () => {
    const storage = new MemoryStorage();
    const options = minimalServeOptions(storage);
    const context = minimalServerContext();
    registerWorker(context, 'w-1', 'test.charge');
    const sent = attachSocket(context, 'w-1');

    await dispatchTaskImpl(context, options, {
      operationId: 'op-retry-same-worker',
      workflowType: 'test',
      activityName: 'test.charge',
      queue: 'default',
      input: null,
    });
    const firstAttemptToken = extractAttemptToken(sent);
    const claimedLeased = decodeRemoteTaskRecord(
      await storage.get(taskLedgerKey('op-retry-same-worker')),
    );
    if (claimedLeased?.state !== 'leased') throw new Error('Expected a leased record');
    // `reassignOrExpireTask`'s visibility-timeout origin requires the lease
    // deadline to have genuinely passed — force it into the past rather than
    // waiting on a real clock.
    const firstLeased: typeof claimedLeased = {
      ...claimedLeased,
      leaseDeadline: Date.now() - 1_000,
    };
    await storage.put(taskLedgerKey('op-retry-same-worker'), encodeRemoteTaskRecord(firstLeased));

    // Expire it (visibility-timeout origin) and let the same worker re-claim.
    await reassignOrExpireTask(
      context,
      options,
      'op-retry-same-worker',
      firstLeased,
      'visibility-timeout',
    );
    const requeued = decodeRemoteTaskRecord(
      await storage.get(taskLedgerKey('op-retry-same-worker')),
    );
    if (requeued?.state !== 'queued') throw new Error('Expected a requeued record');
    expect(requeued.attempt).toBe(2);

    context.registry.releaseReservation('op-retry-same-worker');
    await dispatchTaskImpl(context, options, taskDispatchFromLedgerRecord(requeued), {
      redispatch: true,
    });
    const secondAttemptToken = extractAttemptToken(sent);
    expect(secondAttemptToken).not.toBe(firstAttemptToken);

    const priorAttempt = await readAttempt(options, 'op-retry-same-worker', firstAttemptToken);
    if (priorAttempt === null) throw new Error('Expected the prior attempt to survive');
    expect(priorAttempt.disposition).toBe('requeued');
    expect(priorAttempt.dispositionReason).toBe('visibility-timeout');
    expect(priorAttempt.attempt).toBe(1);
    expect(priorAttempt.workerSessionId).toBe('w-1');

    const newAttempt = await readAttempt(options, 'op-retry-same-worker', secondAttemptToken);
    if (newAttempt === null) throw new Error('Expected the new attempt to be recorded');
    expect(newAttempt.disposition).toBe('leased');
    expect(newAttempt.attempt).toBe(2);
    expect(newAttempt.workerSessionId).toBe('w-1');

    // Provenance rides on the ledger's own attempt counter, never a parallel
    // counter (criterion 4).
    expect(newAttempt.attempt).toBe(requeued.attempt);
  });

  it('criterion 7: same-worker reconnect under a new session generation is recorded as provenance, not a fence', async () => {
    const storage = new MemoryStorage();
    const options = minimalServeOptions(storage);
    const context = minimalServerContext();
    registerWorker(context, 'w-1', 'test.charge');
    const sent = attachSocket(context, 'w-1');

    await dispatchTaskImpl(context, options, {
      operationId: 'op-session-gen',
      workflowType: 'test',
      activityName: 'test.charge',
      queue: 'default',
      input: null,
    });
    const firstAttemptToken = extractAttemptToken(sent);
    const firstAttempt = await readAttempt(options, 'op-session-gen', firstAttemptToken);
    expect(firstAttempt?.sessionGeneration).toBe(1);

    const leased = decodeRemoteTaskRecord(await storage.get(taskLedgerKey('op-session-gen')));
    if (leased?.state !== 'leased') throw new Error('Expected a leased record');
    await reassignOrExpireTask(context, options, 'op-session-gen', leased, 'worker-disconnect');
    const requeued = decodeRemoteTaskRecord(await storage.get(taskLedgerKey('op-session-gen')));
    if (requeued?.state !== 'queued') throw new Error('Expected a requeued record');

    // An unproven reconnect (no resumingSessionGeneration echoed) bumps the
    // registry's session generation to 2, same workerId.
    registerWorker(context, 'w-1', 'test.charge');
    context.registry.releaseReservation('op-session-gen');
    await dispatchTaskImpl(context, options, taskDispatchFromLedgerRecord(requeued), {
      redispatch: true,
    });
    const secondAttemptToken = extractAttemptToken(sent);
    const secondAttempt = await readAttempt(options, 'op-session-gen', secondAttemptToken);
    if (secondAttempt === null) throw new Error('Expected the second attempt to be recorded');
    expect(secondAttempt.sessionGeneration).toBe(2);
    expect(secondAttempt.workerSessionId).toBe('w-1');
  });

  it("criterion 3/9: different-worker, different-build retry preserves both attempts' distinct identities, visible via weft.tasks.get", async () => {
    const storage = new MemoryStorage();
    const options = minimalServeOptions(storage);
    const context = minimalServerContext();
    const engine = createEngine(storage);

    registerWorker(context, 'w-1', 'test.charge', {
      deployment: { name: 'checkout', buildId: 'b1', artifactDigest: 'sha256:b1' },
    });
    const sentToW1 = attachSocket(context, 'w-1');

    await dispatchTaskImpl(context, options, {
      operationId: 'op-different-build',
      workflowType: 'test',
      activityName: 'test.charge',
      queue: 'default',
      input: null,
    });
    const firstAttemptToken = extractAttemptToken(sentToW1);

    const leased = decodeRemoteTaskRecord(await storage.get(taskLedgerKey('op-different-build')));
    if (leased?.state !== 'leased') throw new Error('Expected a leased record');
    await reassignOrExpireTask(context, options, 'op-different-build', leased, 'worker-disconnect');
    const requeued = decodeRemoteTaskRecord(await storage.get(taskLedgerKey('op-different-build')));
    if (requeued?.state !== 'queued') throw new Error('Expected a requeued record');

    // A different worker, running a NEWER build, claims the retry.
    context.registry.unregister('w-1');
    context.workerSockets.delete('w-1');
    registerWorker(context, 'w-2', 'test.charge', {
      deployment: { name: 'checkout', buildId: 'b2', artifactDigest: 'sha256:b2' },
    });
    const sentToW2 = attachSocket(context, 'w-2');
    context.registry.releaseReservation('op-different-build');
    await dispatchTaskImpl(context, options, taskDispatchFromLedgerRecord(requeued), {
      redispatch: true,
    });
    const secondAttemptToken = extractAttemptToken(sentToW2);

    const result = await runGetTaskDetail(engine, 'op-different-build');
    if (!result.ok) throw new Error('Expected weft.tasks.get to succeed');
    expect(result.value.attempts).toHaveLength(2);
    const [attempt1, attempt2] = result.value.attempts;
    expect(attempt1?.executionIdentity?.buildId).toBe('b1');
    expect(attempt1?.attemptTokenDigest).toBe(sha256HexSync(firstAttemptToken));
    expect(attempt2?.executionIdentity?.buildId).toBe('b2');
    expect(attempt2?.attemptTokenDigest).toBe(sha256HexSync(secondAttemptToken));

    // Criterion 10: the raw tokens never appear anywhere in the response.
    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain(firstAttemptToken);
    expect(serialized).not.toContain(secondAttemptToken);
  });

  it('disconnect: worker-disconnect requeue marks the forfeited attempt requeued and releases capacity', async () => {
    const storage = new MemoryStorage();
    const options = minimalServeOptions(storage);
    const context = minimalServerContext();
    registerWorker(context, 'w-1', 'test.charge');
    const sent = attachSocket(context, 'w-1');

    await dispatchTaskImpl(context, options, {
      operationId: 'op-disconnect',
      workflowType: 'test',
      activityName: 'test.charge',
      queue: 'default',
      input: null,
    });
    const attemptToken = extractAttemptToken(sent);

    await runWorkerDisconnectRequeue(context, options, 'w-1', NOOP_CLEANUP);

    const attempt = await readAttempt(options, 'op-disconnect', attemptToken);
    if (attempt === null) throw new Error('Expected the forfeited attempt to remain durable');
    expect(attempt.disposition).toBe('requeued');
    expect(attempt.dispositionReason).toBe('worker-disconnect');
    expect(context.registry.isAssigned('op-disconnect')).toBe(false);

    const record = decodeRemoteTaskRecord(await storage.get(taskLedgerKey('op-disconnect')));
    expect(record?.state).toBe('queued');
  });

  it('restart: a still-valid lease stays attributable to its original attempt after recovery; an expired one is requeued with the old attempt intact', async () => {
    const storage = new MemoryStorage();
    const options = minimalServeOptions(storage);
    const context = minimalServerContext();
    registerWorker(context, 'w-1', 'test.charge');
    const sent = attachSocket(context, 'w-1');

    await dispatchTaskImpl(context, options, {
      operationId: 'op-restart-valid',
      workflowType: 'test',
      activityName: 'test.charge',
      queue: 'default',
      input: null,
    });
    const validAttemptToken = extractAttemptToken(sent);

    // Simulate a second operation whose lease already expired before restart.
    registerWorker(context, 'w-2', 'test.charge');
    const sentToW2 = attachSocket(context, 'w-2');
    await dispatchTaskImpl(context, options, {
      operationId: 'op-restart-expired',
      workflowType: 'test',
      activityName: 'test.charge',
      queue: 'default',
      input: null,
    });
    const expiredAttemptToken = extractAttemptToken(sentToW2);
    const expiredLeased = decodeRemoteTaskRecord(
      await storage.get(taskLedgerKey('op-restart-expired')),
    );
    if (expiredLeased?.state !== 'leased') throw new Error('Expected a leased record');
    await storage.put(
      taskLedgerKey('op-restart-expired'),
      encodeRemoteTaskRecord({
        ...expiredLeased,
        leaseDeadline: Date.now() - 1_000,
      }),
    );

    // Fresh process: a fresh context with no in-memory registry state.
    const freshContext = minimalServerContext();
    await runTaskLedgerRecovery(freshContext, options);

    const stillLive = await readAttempt(options, 'op-restart-valid', validAttemptToken);
    if (stillLive === null) throw new Error('Expected the still-valid attempt to remain durable');
    expect(stillLive.disposition).toBe('leased');

    const expiredAttempt = await readAttempt(options, 'op-restart-expired', expiredAttemptToken);
    if (expiredAttempt === null) throw new Error('Expected the expired attempt to remain durable');
    expect(expiredAttempt.disposition).toBe('requeued');

    const requeuedRecord = decodeRemoteTaskRecord(
      await storage.get(taskLedgerKey('op-restart-expired')),
    );
    expect(requeuedRecord?.state).toBe('queued');
  });

  it('heartbeat: a current-attempt heartbeat renews the lease and records evidence; a stale one touches neither', async () => {
    const storage = new MemoryStorage();
    const options = minimalServeOptions(storage);
    const context = minimalServerContext();
    registerWorker(context, 'w-1', 'test.charge');
    const sent = attachSocket(context, 'w-1');

    await dispatchTaskImpl(context, options, {
      operationId: 'op-heartbeat',
      workflowType: 'test',
      activityName: 'test.charge',
      queue: 'default',
      input: null,
    });
    const attemptToken = extractAttemptToken(sent);

    const heartbeatRequest = (body: Record<string, unknown>) => {
      const request = new Request('http://localhost/v1/tasks/default/heartbeat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { request, url: new URL(request.url) };
    };

    // A stale/unknown attempt token is rejected and leaves the record and
    // any attempt history untouched (criterion 7).
    const { request: staleRequest, url: staleUrl } = heartbeatRequest({
      operationId: 'op-heartbeat',
      workerId: 'w-1',
      attemptToken: 'not-the-real-token',
    });
    const staleResponse = await handleTaskHeartbeatRequest(
      context,
      options,
      staleRequest,
      staleUrl,
    );
    expect(staleResponse?.status).toBe(403);
    const beforeAttempt = await readAttempt(options, 'op-heartbeat', attemptToken);
    expect(beforeAttempt?.lastHeartbeatAt).toBeUndefined();

    const { request, url } = heartbeatRequest({
      operationId: 'op-heartbeat',
      workerId: 'w-1',
      attemptToken,
    });
    const response = await handleTaskHeartbeatRequest(context, options, request, url);
    expect(response?.status).toBe(200);

    const afterAttempt = await readAttempt(options, 'op-heartbeat', attemptToken);
    expect(typeof afterAttempt?.lastHeartbeatAt).toBe('number');
    expect(afterAttempt?.disposition).toBe('leased');
  });

  it('cancellation: a leased-origin cancellation records the attempt as cancelled; a queued-origin one never creates an attempt at all', async () => {
    const storage = new MemoryStorage();
    const options = minimalServeOptions(storage);
    const context = minimalServerContext();
    registerWorker(context, 'w-1', 'test.charge');
    const sent = attachSocket(context, 'w-1');

    await dispatchTaskImpl(context, options, {
      operationId: 'op-cancel-leased',
      workflowType: 'test',
      activityName: 'test.charge',
      queue: 'default',
      input: null,
    });
    const attemptToken = extractAttemptToken(sent);

    const cancelled = await cancelTask(context, options, 'op-cancel-leased', 'operator requested');
    expect(cancelled).toBe(true);

    // The worker cooperates.
    const committed = await commitTaskLedgerCompletion(storage, {
      operationId: 'op-cancel-leased',
      attemptToken,
      status: 'cancelled',
    });
    expect(committed.ok).toBe(true);

    const attempt = await readAttempt(options, 'op-cancel-leased', attemptToken);
    if (attempt === null) throw new Error('Expected the cancelled attempt to remain durable');
    expect(attempt.disposition).toBe('cancelled');

    // Queued-origin: never claimed, so no attempt ever existed to update.
    const enqueued = await dispatchTaskImpl(context, options, {
      operationId: 'op-cancel-queued',
      workflowType: 'test',
      activityName: 'test.unclaimed-activity',
      queue: 'default',
      input: null,
    });
    expect(enqueued).toBe(true);
    const cancelledQueued = await cancelTask(context, options, 'op-cancel-queued', 'never started');
    expect(cancelledQueued).toBe(true);
    expect(await listAttemptKeys(options, 'op-cancel-queued')).toHaveLength(0);
  });

  it('terminal result: a resolved completion marks its attempt resolved, remaining attributable independent of the registry', async () => {
    const storage = new MemoryStorage();
    const options = minimalServeOptions(storage);
    const context = minimalServerContext();
    registerWorker(context, 'w-1', 'test.charge');
    const sent = attachSocket(context, 'w-1');

    await dispatchTaskImpl(context, options, {
      operationId: 'op-terminal',
      workflowType: 'test',
      activityName: 'test.charge',
      queue: 'default',
      input: null,
    });
    const attemptToken = extractAttemptToken(sent);

    const committed = await commitTaskLedgerCompletion(storage, {
      operationId: 'op-terminal',
      attemptToken,
      status: 'completed',
      value: { ok: true },
    });
    expect(committed.ok).toBe(true);

    // Remove the operation from the registry entirely — the attempt record
    // is durable and independent of any in-memory bookkeeping.
    context.registry.completeTask('op-terminal');

    const attempt = await readAttempt(options, 'op-terminal', attemptToken);
    if (attempt === null) throw new Error('Expected the resolved attempt to remain durable');
    expect(attempt.disposition).toBe('resolved');
    expect(JSON.stringify(attempt)).not.toContain(attemptToken);
  });
});
