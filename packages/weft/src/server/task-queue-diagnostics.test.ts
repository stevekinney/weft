/**
 * COR-205 ("Canonical Provenance Types") — the diagnostics-facing
 * acceptance criteria that don't fit naturally into the dispatch/retry or
 * dead-letter/retention suites:
 *
 *   - criterion 3: a queued record's declared routing requirement survives
 *     a claim distinctly from the worker that actually executed it.
 *   - criterion 10: raw attempt tokens are absent from `weft.tasks.get` and
 *     `weft.workers.diagnostics` — general operator-facing surfaces.
 *   - criterion 13: deployment/worker reachability (drain health) is driven
 *     by the live in-flight count, never by retained attempt-record
 *     diagnostic history.
 *   - criterion 14: the SAME `WorkerExecutionIdentity` shape flows from
 *     claim time through to the `weft.tasks.get` projection — no second,
 *     independently drifting provenance type.
 *   - criterion 15: nothing this issue added attaches a label/attribute to
 *     a metric — every metrics call stays a bare `(name, value)`.
 */

import { describe, expect, it, spyOn } from 'bun:test';

import { buildClaimAttemptRecordWrite } from '../core/task-ledger/task-attempt-runtime.ts';
import { decodeTaskAttemptRecord } from '../core/task-ledger/task-attempt.ts';
import { claimQueued, createQueued } from '../core/task-ledger/task-ledger-transitions.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { buildWorkerExecutionIdentity } from '../worker/manifest/execution-identity.ts';
import {
  manifestForActivities,
  TEST_ACCEPTED_MANIFEST_DIGEST,
} from '../worker/registry-fixtures.test-support.ts';
import { createEngine, runGetTaskDetail } from './operations/get-task-detail.test-support.ts';
import { createGetWorkerDiagnosticsOperation } from './operations/get-worker-diagnostics.ts';
import {
  minimalServeOptions,
  minimalServerContext,
} from './runtime/server-context.test-support.ts';
import { dispatchTaskImpl } from './runtime/task-dispatch.ts';
import { commitTaskLedgerCompletion } from './runtime/task-ledger-completion.ts';
import { handleTaskHeartbeatRequest } from './runtime/task-polling.ts';

import type { ServerContext } from './runtime/context.ts';

function registerWorker(context: ServerContext, workerId: string, buildId: string): void {
  context.registry.register({
    manifest: manifestForActivities(['test.charge'], {
      deployment: { name: 'checkout', buildId, artifactDigest: `sha256:${buildId}` },
    }),
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

describe('COR-205 diagnostics-facing criteria', () => {
  it('criterion 3: the declared execution requirement survives a claim distinctly from the actual execution identity', () => {
    const created = createQueued(
      null,
      {
        recordVersion: 1,
        operationId: 'op-requirement',
        workflowType: 'test',
        activityName: 'charge',
        queue: 'default',
        input: null,
        headers: {},
        visibilityTimeoutMilliseconds: 30_000,
        createdAt: Date.now(),
        executionRequirement: { deploymentName: 'checkout', buildId: 'required-build' },
      },
      Date.now(),
    );
    if (!created.ok) throw new Error(`Expected createQueued to succeed: ${created.reason}`);

    const actualIdentity = buildWorkerExecutionIdentity({
      manifest: manifestForActivities(['charge'], {
        deployment: { name: 'checkout', buildId: 'actual-build', artifactDigest: 'sha256:x' },
      }),
      manifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
      workerId: 'w-1',
      workflowType: 'test',
      activityName: 'charge',
    });
    if (actualIdentity === undefined) throw new Error('Expected a resolvable execution identity');

    const claimed = claimQueued(
      created.nextRecord,
      {
        expectedGeneration: created.nextRecord.generation,
        attemptToken: 'attempt-1',
        workerSessionId: 'w-1',
        executionIdentity: actualIdentity,
        leaseDurationMilliseconds: 30_000,
      },
      Date.now(),
    );
    if (!claimed.ok) throw new Error(`Expected claimQueued to succeed: ${claimed.reason}`);

    // The ledger record carries both, distinctly.
    expect(claimed.nextRecord.executionRequirement?.buildId).toBe('required-build');
    expect(claimed.nextRecord.executionIdentity?.buildId).toBe('actual-build');

    // The attempt record preserves the same distinction — the DECLARED
    // requirement is not overwritten by, or conflated with, the worker that
    // ACTUALLY executed it (criterion 3), and rides on the ledger's own
    // attempt counter, not a parallel one (criterion 4).
    const write = buildClaimAttemptRecordWrite({
      operationId: claimed.nextRecord.operationId,
      attempt: claimed.nextRecord.attempt,
      attemptTokenDigest: 'sha256:placeholder',
      workerSessionId: claimed.nextRecord.workerSessionId,
      ...(claimed.nextRecord.executionIdentity !== undefined
        ? { executionIdentity: claimed.nextRecord.executionIdentity }
        : {}),
      ...(claimed.nextRecord.executionRequirement !== undefined
        ? { executionRequirement: claimed.nextRecord.executionRequirement }
        : {}),
      claimedAt: Date.now(),
    });
    const attemptRecord = decodeTaskAttemptRecord(write.type === 'put' ? write.value : null);
    if (attemptRecord === null) throw new Error('Expected a valid attempt record');
    expect(attemptRecord.executionRequirement?.buildId).toBe('required-build');
    expect(attemptRecord.executionIdentity?.buildId).toBe('actual-build');
    expect(attemptRecord.attempt).toBe(claimed.nextRecord.attempt);
  });

  it('criterion 10: raw attempt tokens never appear in weft.tasks.get or weft.workers.diagnostics', async () => {
    const storage = new MemoryStorage();
    const options = minimalServeOptions(storage);
    const context = minimalServerContext();
    const engine = createEngine(storage);
    registerWorker(context, 'w-1', 'b1');
    const sent = attachSocket(context, 'w-1');

    await dispatchTaskImpl(context, options, {
      operationId: 'op-diagnostics',
      workflowType: 'test',
      activityName: 'test.charge',
      queue: 'default',
      input: null,
    });
    const attemptToken = (JSON.parse(sent.at(-1)!) as { attemptToken: string }).attemptToken;

    const taskDetail = await runGetTaskDetail(engine, 'op-diagnostics');
    if (!taskDetail.ok) throw new Error('Expected weft.tasks.get to succeed');
    expect(JSON.stringify(taskDetail.value)).not.toContain(attemptToken);

    const diagnosticsOperation = createGetWorkerDiagnosticsOperation({
      workerRegistry: context.registry,
    });
    const diagnostics = await diagnosticsOperation.invoke({
      input: { workerId: 'w-1' },
    } as never);
    expect(JSON.stringify(diagnostics)).not.toContain(attemptToken);
  });

  it('criterion 13: worker drain health tracks the live in-flight count, not retained attempt-record history', async () => {
    const storage = new MemoryStorage();
    const options = minimalServeOptions(storage);
    const context = minimalServerContext();
    registerWorker(context, 'w-1', 'b1');
    const sent = attachSocket(context, 'w-1');

    await dispatchTaskImpl(context, options, {
      operationId: 'op-drain',
      workflowType: 'test',
      activityName: 'test.charge',
      queue: 'default',
      input: null,
    });
    const attemptToken = (JSON.parse(sent.at(-1)!) as { attemptToken: string }).attemptToken;

    context.registry.markWorkerDraining('w-1');
    const whileInFlight = context.registry
      .getWorkerSummaries(Date.now())
      .find((w) => w.id === 'w-1');
    expect(whileInFlight?.health).toBe('draining');

    const committed = await commitTaskLedgerCompletion(storage, {
      operationId: 'op-drain',
      attemptToken,
      status: 'completed',
      value: 'ok',
    });
    expect(committed.ok).toBe(true);
    // The durable attempt record is retained (disposition 'resolved'), but
    // the registry has no idea it exists — only `completeTask` (driven by
    // the real transport handlers, simulated here directly) changes
    // `inFlight`, which is what drives reachability.
    context.registry.completeTask('op-drain');

    const afterCompletion = context.registry
      .getWorkerSummaries(Date.now())
      .find((w) => w.id === 'w-1');
    expect(afterCompletion?.health).toBe('drained');
    expect(afterCompletion?.inFlight).toBe(0);
  });

  it('criterion 14: the execution identity projected by weft.tasks.get is the exact WorkerExecutionIdentity built at claim time', async () => {
    const storage = new MemoryStorage();
    const options = minimalServeOptions(storage);
    const context = minimalServerContext();
    const engine = createEngine(storage);
    registerWorker(context, 'w-1', 'b1');
    attachSocket(context, 'w-1');

    await dispatchTaskImpl(context, options, {
      operationId: 'op-shared-type',
      workflowType: 'test',
      activityName: 'test.charge',
      queue: 'default',
      input: null,
    });

    const expectedIdentity = buildWorkerExecutionIdentity({
      manifest: context.registry.getWorker('w-1')!.manifest,
      manifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
      workerId: 'w-1',
      workflowType: 'test',
      activityName: 'charge',
    });

    const result = await runGetTaskDetail(engine, 'op-shared-type');
    if (!result.ok) throw new Error('Expected weft.tasks.get to succeed');
    const [attempt] = result.value.attempts;
    expect(attempt?.executionIdentity).toEqual(expectedIdentity);
  });

  it('criterion 15: dispatch, heartbeat, and completion never attach a label/attribute to a metric', async () => {
    const storage = new MemoryStorage();
    const context = minimalServerContext();
    const metricsCollector = context.metricsCollector;
    if (metricsCollector === undefined) throw new Error('Expected a default metrics collector');
    const options = minimalServeOptions(storage);
    registerWorker(context, 'w-1', 'b1');
    const sent = attachSocket(context, 'w-1');

    const incrementSpy = spyOn(metricsCollector, 'increment');
    const recordSpy = spyOn(metricsCollector, 'record');
    const gaugeSpy = spyOn(metricsCollector, 'gauge');

    await dispatchTaskImpl(context, options, {
      operationId: 'op-metrics',
      workflowType: 'test',
      activityName: 'test.charge',
      queue: 'default',
      input: null,
    });
    const attemptToken = (JSON.parse(sent.at(-1)!) as { attemptToken: string }).attemptToken;

    const heartbeatRequest = new Request('http://localhost/v1/tasks/default/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationId: 'op-metrics', workerId: 'w-1', attemptToken }),
    });
    await handleTaskHeartbeatRequest(
      context,
      options,
      heartbeatRequest,
      new URL(heartbeatRequest.url),
    );

    await commitTaskLedgerCompletion(storage, {
      operationId: 'op-metrics',
      attemptToken,
      status: 'completed',
      value: 'ok',
    });

    const allCalls = [...incrementSpy.mock.calls, ...recordSpy.mock.calls, ...gaugeSpy.mock.calls];
    expect(allCalls.length).toBeGreaterThan(0);
    for (const call of allCalls) {
      // Exactly `(name, value)` — no third labels/attributes argument, and
      // no high-cardinality identity folded into the name itself.
      expect(call).toHaveLength(2);
      expect(typeof call[0]).toBe('string');
      expect(call[0]).not.toContain('op-metrics');
      expect(call[0]).not.toContain(attemptToken);
    }
  });
});
