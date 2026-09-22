/**
 * RemoteWorker WebSocket protocol durability tests.
 *
 * Four scenarios cover: visibility-timeout takeover (scanner path),
 * idempotent rejection of stale completions from displaced workers (covered
 * for the different-`workerId` takeover case only; same-`workerId`
 * reselection on a later attempt is documented as out-of-scope in
 * `onTaskResultMessage`'s ownership-guard comment), transient reconnect
 * continuity, and server-restart-while-leased recovery. The fault-injecting helper at
 * `../testing/worker-fault-injection.test-support.ts` gives tests byte-level control of the
 * WebSocket so partition and abrupt-close behaviors are reproducible.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Engine } from '../core/engine.ts';
import {
  decodeRemoteTaskRecord,
  isRemoteTaskTerminalResolved,
  taskLedgerKey,
} from '../core/task-ledger/task-ledger.ts';
import { serve, type ServeOptions, type WeftServer } from '../server/index.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { sleepForTesting, waitForCondition } from '../testing/fake-timers.test-support.ts';
import {
  killAndReboot,
  spawnServerSubprocess,
  type SubprocessServerHandle,
} from '../testing/subprocess-engine.ts';
import {
  connectFaultInjectingWorker,
  type FaultInjectingWorker,
} from '../testing/worker-fault-injection.test-support.ts';
import { RemoteWorker } from './index.ts';
import { sha256Hex } from './manifest/content-digest.ts';
import type { WorkerManifest, WorkerWorkflowContract } from './manifest/index.ts';
import { WORKER_MANIFEST_VERSION } from './manifest/index.ts';
import type { ServerToWorkerMessage, TaskMessage } from './protocol.ts';
import { REMOTE_WORKER_PROTOCOL_VERSION } from './protocol.ts';

/**
 * Build a minimal manifest advertising exactly the given activity names. Each
 * name may be `${workflowType}.${activityName}` (matching real dispatch
 * routing in tests that assert on a specific qualified name) or a bare name,
 * which is grouped under a synthetic `test` workflow.
 */
function manifestForActivities(
  activities: readonly string[],
  overrides: Partial<WorkerManifest> = {},
): WorkerManifest {
  const activityNamesByWorkflow: Record<string, Set<string>> = {};
  for (const qualifiedName of activities) {
    const dotIndex = qualifiedName.indexOf('.');
    const workflowType = dotIndex === -1 ? 'test' : qualifiedName.slice(0, dotIndex);
    const activityName = dotIndex === -1 ? qualifiedName : qualifiedName.slice(dotIndex + 1);
    (activityNamesByWorkflow[workflowType] ??= new Set()).add(activityName);
  }

  const workflows: Record<string, WorkerWorkflowContract> = {};
  for (const [workflowType, activityNames] of Object.entries(activityNamesByWorkflow)) {
    const workflowActivities: Record<string, WorkerWorkflowContract['activities'][string]> = {};
    for (const activityName of activityNames) {
      workflowActivities[activityName] = { contractHash: 'hash', implementationRevision: 'rev' };
    }
    workflows[workflowType] = {
      workflowVersion: '0.0.0',
      workflowRevision: 'rev',
      contractHash: 'hash',
      activities: workflowActivities,
    };
  }

  return {
    manifestVersion: WORKER_MANIFEST_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    sdkVersion: '0.18.0',
    runtime: { name: 'bun', version: '1.3.14' },
    deployment: { name: 'test-deployment', buildId: 'test-build', artifactDigest: 'sha256:test' },
    workflows,
    capabilities: {},
    ...overrides,
  };
}

type Setup = {
  engine: Engine;
  server: WeftServer;
  workerUrl: string;
};

const sockets: FaultInjectingWorker[] = [];
let activeSetup: Setup | null = null;

afterEach(async () => {
  for (const worker of sockets.splice(0)) {
    try {
      await worker.hardClose();
    } catch {
      // Ignore.
    }
  }
  if (activeSetup !== null) {
    try {
      await activeSetup.server.stop?.();
    } catch {
      // Ignore.
    }
    try {
      activeSetup.engine[Symbol.dispose]();
    } catch {
      // Ignore.
    }
    activeSetup = null;
  }
});

function createSetup(overrides: Partial<Omit<ServeOptions, 'engine'>> = {}): Setup {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  const server = serve({
    engine,
    port: 0,
    routingPolicy: 'round-robin',
    visibilityPollIntervalMs: 20,
    workerReconnectGracePeriodMs: 50,
    ...overrides,
  });
  const workerUrl = `${server.url.replace(/^http/, 'ws').replace(/\/?$/, '/')}v1/tasks/default/stream`;
  const setup: Setup = { engine, server, workerUrl };
  activeSetup = setup;
  return setup;
}

async function connectAndRegisterWorker(
  setup: Setup,
  workerId: string,
  options: {
    activities?: string[];
    concurrency?: number;
    manifestOverrides?: Partial<WorkerManifest>;
  } = {},
): Promise<FaultInjectingWorker> {
  const worker = await connectFaultInjectingWorker({ url: setup.workerUrl, workerId });
  sockets.push(worker);
  worker.send({
    type: 'register',
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    workerId,
    manifest: manifestForActivities(options.activities ?? ['echo'], options.manifestOverrides),
    concurrency: options.concurrency ?? 1,
  });
  // Registration now awaits a real async manifest digest server-side (protocol
  // v3), so this margin is wider than the old fully-synchronous handshake needed.
  await worker.nextServerMessage((m) => m.type === 'registerAck', { timeoutMs: 3_000 });
  return worker;
}

function isTask(message: ServerToWorkerMessage): message is TaskMessage {
  return message.type === 'task';
}

/** Reads the durable ledger's terminal-resolved record, or `null` if the operation hasn't resolved yet. */
async function readResolvedRecord(engine: Engine, operationId: string): Promise<unknown> {
  const record = decodeRemoteTaskRecord(await engine.storage.get(taskLedgerKey(operationId)));
  return isRemoteTaskTerminalResolved(record) ? record : null;
}

/**
 * Wait until the ledger record for `operationId` has left the actively-held
 * `leased`/`completing` states — either it reached `terminal` (the usual
 * case, always checked via `readResolvedRecord` immediately before this at
 * every call site in this file) or was requeued back to `queued` after a
 * disconnect. Post-cutover (WFT-22) there is no separate "inflight record"
 * to clear — the single ledger record's `state` field is the whole story.
 */
async function waitForInflightCleared(
  engine: Engine,
  operationId: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 2_000);
  let record: ReturnType<typeof decodeRemoteTaskRecord> = null;
  while (Date.now() < deadline) {
    record = decodeRemoteTaskRecord(await engine.storage.get(taskLedgerKey(operationId)));
    if (record === null || (record.state !== 'leased' && record.state !== 'completing')) return;
    await sleepForTesting(5);
  }
  throw new Error(
    `Timed out waiting for the ledger record of "${operationId}" to leave the leased/completing state; last state=${record?.state ?? 'absent'}`,
  );
}

describe('RemoteWorker durability — scanner-driven takeover', () => {
  it("redispatches a partitioned worker's task to a peer when the visibility deadline expires", async () => {
    const setup = createSetup();

    const workerA = await connectAndRegisterWorker(setup, 'worker-a');
    const workerB = await connectAndRegisterWorker(setup, 'worker-b');

    const operationId = 'scenario-1-op';
    void setup.server.dispatchTask({
      operationId,
      activityName: 'test.echo',
      workflowType: 'test',
      input: { value: 'v' },
      // The visibilityTimeout governs BOTH worker-a's expiry (drives the
      // takeover) and worker-b's expiry (after takeover B has this long to
      // respond before another requeue). 250ms is short enough that the
      // initial takeover happens within the test budget but borderline for
      // B's response window under load. After we observe B's takeover
      // dispatch, we set the engine's effective deadline-tracker entry to
      // a long value below by sending a heartbeat from B before responding,
      // so the test's resolved-state polling cannot race the scanner.
      visibilityTimeout: 250,
    });

    const dispatchToA = await workerA.nextServerMessage(isTask, { timeoutMs: 2_000 });
    if (!isTask(dispatchToA)) throw new Error('expected task');
    expect(dispatchToA.operationId).toBe(operationId);
    expect(dispatchToA.attempt ?? 1).toBe(1);

    workerA.partition();

    const dispatchToB = await workerB.nextServerMessage(isTask, { timeoutMs: 5_000 });
    if (!isTask(dispatchToB)) throw new Error('expected task on B');
    expect(dispatchToB.operationId).toBe(operationId);
    expect(dispatchToB.attempt ?? 1).toBe(2);

    // Stay-connected assertion: worker-a's WS is still open at the moment B
    // receives the takeover. This pins that the path exercised is the scanner,
    // not a close-handler-triggered requeue.
    expect(workerA.closedState).toBe('open');

    // Watch for any inbound message on B to spot a possible protocolError.
    const allBMessages: ServerToWorkerMessage[] = [];
    workerB.onServerMessage((m) => allBMessages.push(m));

    // Send a heartbeat to extend B's deadline — the test's wall-clock should
    // not race the scanner.
    workerB.send({ type: 'heartbeat', workerId: 'worker-b' });

    workerB.send({
      type: 'taskResult',
      operationId,
      status: 'completed',
      value: 'v',
      attemptToken: dispatchToB.attemptToken,
    });

    // The resolved record appears once the server processes the completion.
    let resolved: unknown;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      resolved = await readResolvedRecord(setup.engine, operationId);
      if (resolved !== undefined) break;
      await sleepForTesting(10);
    }
    expect(resolved).not.toBeUndefined();
    await waitForInflightCleared(setup.engine, operationId);
    expect(allBMessages.every((m) => m.type !== 'protocolError')).toBe(true);
  });
});

describe('RemoteWorker durability — idempotent duplicate completion (different-worker takeover)', () => {
  // Scope note: this scenario covers the case where takeover moves the task to a
  // different `workerId`, which the `(operationId, workerId)` ownership guard
  // alone rejects. The same-`workerId` reselection case (a single-worker
  // deployment whose only worker times out and is then re-selected for the next
  // attempt) is now defended by the per-dispatch attempt token — see the
  // dedicated test below and the attempt guard in `onTaskResultMessage`.
  it('rejects a stale completion from a displaced worker before and after final resolution', async () => {
    const setup = createSetup();
    const workerA = await connectAndRegisterWorker(setup, 'worker-a');
    const workerB = await connectAndRegisterWorker(setup, 'worker-b');

    const operationId = 'scenario-2-op';
    void setup.server.dispatchTask({
      operationId,
      activityName: 'test.echo',
      workflowType: 'test',
      input: { value: 'real' },
      visibilityTimeout: 30_000, // long — we drive takeover via hardClose
    });

    const dispatchToA = await workerA.nextServerMessage(isTask, { timeoutMs: 2_000 });
    if (!isTask(dispatchToA)) throw new Error('expected task');
    expect(dispatchToA.operationId).toBe(operationId);

    await workerA.hardClose();

    const dispatchToB = await workerB.nextServerMessage(isTask, { timeoutMs: 5_000 });
    if (!isTask(dispatchToB)) throw new Error('expected task on B');
    expect(dispatchToB.operationId).toBe(operationId);

    // Phase 2a: worker-a reconnects (new socket, same id) and sends a stale
    // completion BEFORE worker-b has resolved its attempt.
    const workerAPrime = await connectAndRegisterWorker(setup, 'worker-a');
    const protocolErrorPromise = workerAPrime.nextServerMessage((m) => m.type === 'protocolError', {
      timeoutMs: 2_000,
    });
    workerAPrime.send({
      type: 'taskResult',
      operationId,
      status: 'completed',
      value: 'stale-from-a',
      attemptToken: 'stale-token',
    });
    const protocolError = await protocolErrorPromise;
    if (protocolError.type !== 'protocolError') throw new Error('expected protocolError');
    expect(protocolError.code).toBe('invalid_message');
    expect(protocolError.message).toContain(operationId);

    // Workflow attempt is still in flight on B at this point — no resolved record.
    const recordDuring2a = decodeRemoteTaskRecord(
      await setup.engine.storage.get(taskLedgerKey(operationId)),
    );
    expect(recordDuring2a?.state).toBe('leased');

    // Worker-b completes the real attempt.
    workerB.send({
      type: 'taskResult',
      operationId,
      status: 'completed',
      value: 'real',
      attemptToken: dispatchToB.attemptToken,
    });

    let resolved: unknown;
    const phase2aDeadline = Date.now() + 2_000;
    while (Date.now() < phase2aDeadline) {
      resolved = await readResolvedRecord(setup.engine, operationId);
      if (resolved !== undefined && resolved !== null) break;
      await sleepForTesting(10);
    }
    expect(resolved !== undefined && resolved !== null).toBe(true);

    // Phase 2b: after completion, worker-a' sends the same stale completion again.
    const secondErrorPromise = workerAPrime.nextServerMessage((m) => m.type === 'protocolError', {
      timeoutMs: 2_000,
    });
    workerAPrime.send({
      type: 'taskResult',
      operationId,
      status: 'completed',
      value: 'stale-from-a-again',
      attemptToken: 'stale-token',
    });
    const secondError = await secondErrorPromise;
    if (secondError.type !== 'protocolError') throw new Error('expected protocolError');
    expect(secondError.code).toBe('invalid_message');
    expect(secondError.message).toContain(operationId);

    const stillResolved = await readResolvedRecord(setup.engine, operationId);
    expect(stillResolved !== undefined && stillResolved !== null).toBe(true);
    await waitForInflightCleared(setup.engine, operationId);
  });
});

describe('RemoteWorker durability — same-worker stale attempt (attempt token)', () => {
  it('rejects a stale completion from an earlier attempt reselected on the same worker', async () => {
    // The case the (operationId, workerId) guard alone cannot catch: a SINGLE
    // worker whose attempt times out is re-selected for the next attempt, so the
    // workerId still matches. The per-dispatch attempt token is the only field
    // that distinguishes attempt 1 from attempt 2. We use exactly one worker so
    // re-dispatch deterministically reselects it.
    const setup = createSetup();
    const workerA = await connectAndRegisterWorker(setup, 'worker-a');

    const operationId = 'same-worker-stale-op';
    void setup.server.dispatchTask({
      operationId,
      activityName: 'test.echo',
      workflowType: 'test',
      input: { value: 'v' },
      // Short enough that attempt 1 expires and the scanner (20ms poll) re-
      // dispatches to the only worker as attempt 2, but long enough that the
      // attempt-2 window — which the heartbeat below extends by this same
      // visibilityTimeout — comfortably outlasts the stale/fresh completion
      // exchange. At 150ms a slow CI runner could let attempt 2 expire and
      // re-dispatch as attempt 3 before the fresh completion lands, turning the
      // fresh token stale and flaking the test; 500ms gives ample slack without
      // changing the behavior under test.
      visibilityTimeout: 500,
    });

    const dispatch1 = await workerA.nextServerMessage(isTask, { timeoutMs: 2_000 });
    if (!isTask(dispatch1)) throw new Error('expected first dispatch');
    expect(dispatch1.operationId).toBe(operationId);
    expect(dispatch1.attempt ?? 1).toBe(1);
    expect(dispatch1.attemptToken).toBeString();

    // Do NOT complete attempt 1. Wait for the visibility timeout to re-dispatch
    // the SAME operation to the SAME worker as attempt 2 with a fresh token.
    const dispatch2 = await workerA.nextServerMessage(isTask, { timeoutMs: 5_000 });
    if (!isTask(dispatch2)) throw new Error('expected re-dispatch');
    expect(dispatch2.operationId).toBe(operationId);
    expect(dispatch2.attempt ?? 1).toBe(2);
    expect(dispatch2.attemptToken).toBeString();
    // The token rotated even though the worker id did not.
    expect(dispatch2.attemptToken).not.toBe(dispatch1.attemptToken);

    // Extend the deadline so the scanner cannot re-dispatch again mid-test.
    workerA.send({ type: 'heartbeat', workerId: 'worker-a' });

    // Stale completion: worker-a echoes attempt 1's token. Same workerId, so the
    // ownership guard passes — the attempt guard must reject it.
    const staleError = workerA.nextServerMessage((m) => m.type === 'protocolError', {
      timeoutMs: 2_000,
    });
    workerA.send({
      type: 'taskResult',
      operationId,
      status: 'completed',
      value: 'stale-attempt-1',
      attemptToken: dispatch1.attemptToken,
    });
    const rejected = await staleError;
    if (rejected.type !== 'protocolError') throw new Error('expected protocolError');
    expect(rejected.code).toBe('invalid_message');
    expect(rejected.message).toContain(operationId);

    // The stale completion was a no-op: still in flight, not resolved.
    const resolvedAfterStale = await readResolvedRecord(setup.engine, operationId);
    expect(resolvedAfterStale === undefined || resolvedAfterStale === null).toBe(true);

    // Fresh completion: worker-a echoes attempt 2's token — accepted.
    workerA.send({
      type: 'taskResult',
      operationId,
      status: 'completed',
      value: 'fresh-attempt-2',
      attemptToken: dispatch2.attemptToken,
    });

    let resolved: unknown;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      resolved = await readResolvedRecord(setup.engine, operationId);
      if (resolved !== undefined && resolved !== null) break;
      await sleepForTesting(10);
    }
    expect(resolved !== undefined && resolved !== null).toBe(true);
    // The fresh attempt's value won; the rejected stale completion never wrote.
    // Terminal ledger records don't persist the value itself (see
    // readTerminalRecord's doc comment in state-worker-harness.parity.test.ts)
    // — prove it durably via the content digest instead.
    const resolvedRecord = resolved as { resultDigest?: string };
    expect(resolvedRecord.resultDigest).toBe(
      await sha256Hex(
        JSON.stringify({ status: 'completed', value: 'fresh-attempt-2', error: null }),
      ),
    );
    await waitForInflightCleared(setup.engine, operationId);
  });
});

/**
 * Read the raw ledger record for `operationId` in whatever state it
 * currently holds — unlike {@link readResolvedRecord}, this does not filter
 * to terminal-resolved records, since the fixtures below need to inspect a
 * still-`leased` record's exact lease fields.
 */
async function readLedgerRecord(engine: Engine, operationId: string) {
  return decodeRemoteTaskRecord(await engine.storage.get(taskLedgerKey(operationId)));
}

/**
 * Reconnect `workerId` with a fresh `register`, optionally echoing
 * `resumeSessionGeneration` (protocol v6, COR-220) to prove a resume of a
 * still-pending disconnected session. Returns both the socket and the
 * `registerAck` it received, so callers can assert on `sessionGeneration`
 * without a second round trip.
 */
async function reconnectWorker(
  setup: Setup,
  workerId: string,
  options: { resumeSessionGeneration?: number } = {},
): Promise<{ worker: FaultInjectingWorker; sessionGeneration: number }> {
  const worker = await connectFaultInjectingWorker({ url: setup.workerUrl, workerId });
  sockets.push(worker);
  worker.send({
    type: 'register',
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    workerId,
    manifest: manifestForActivities(['echo']),
    concurrency: 1,
    ...(options.resumeSessionGeneration !== undefined
      ? { resumeSessionGeneration: options.resumeSessionGeneration }
      : {}),
  });
  const ack = await worker.nextServerMessage((m) => m.type === 'registerAck', { timeoutMs: 3_000 });
  if (ack.type !== 'registerAck') throw new Error('expected registerAck');
  return { worker, sessionGeneration: ack.sessionGeneration };
}

describe('RemoteWorker durability — transient reconnect continuity (COR-220)', () => {
  it('a PROVEN resume (matching resumeSessionGeneration) keeps sessionGeneration, the attempt token, and the exact lease deadlines unchanged', async () => {
    // A moderate grace period — large enough that the deferred-requeue timer
    // cannot fire during this test's near-instantaneous steps (every step
    // below is gated on a real event: registerAck, task, taskResultAck —
    // never on elapsed wall-clock time), but small enough that a socket this
    // test closes in `afterEach` without an explicit reconnect (`workerAPrime`,
    // still connected when the test body ends) cannot arm a grace timer that
    // outlives the test itself. `MAX_WORKER_RECONNECT_GRACE_PERIOD_MS` is
    // 5_000 (`serve-internals.ts`) — using a value anywhere near that ceiling
    // here would race Bun's own 5_000ms per-test default budget for no
    // reason, since nothing in this test needs more than a few milliseconds
    // of headroom.
    const setup = createSetup({ workerReconnectGracePeriodMs: 1_000 });
    const workerA = await connectAndRegisterWorker(setup, 'worker-a');

    const operationId = 'proven-resume-op';
    void setup.server.dispatchTask({
      operationId,
      activityName: 'test.echo',
      workflowType: 'test',
      input: { value: 'v' },
      visibilityTimeout: 30_000,
    });

    const dispatch = await workerA.nextServerMessage(isTask, { timeoutMs: 2_000 });
    if (!isTask(dispatch)) throw new Error('expected task');
    expect(dispatch.operationId).toBe(operationId);

    const beforeDisconnect = await readLedgerRecord(setup.engine, operationId);
    if (beforeDisconnect?.state !== 'leased') throw new Error('expected a leased record');
    expect(beforeDisconnect.attemptToken).toBe(dispatch.attemptToken);

    await workerA.hardClose();

    // The very first registration of a fresh workerId is always generation
    // 1 — echo it back to prove this reconnect resumes that exact session.
    const { worker: workerAPrime, sessionGeneration } = await reconnectWorker(setup, 'worker-a', {
      resumeSessionGeneration: 1,
    });
    expect(sessionGeneration).toBe(1);

    // Proven: the attempt is untouched — same token, byte-identical lease
    // fields — read immediately once the ack confirms the resume, no wait.
    const afterReconnect = await readLedgerRecord(setup.engine, operationId);
    if (afterReconnect?.state !== 'leased')
      throw new Error('expected the record to still be leased');
    expect(afterReconnect.attemptToken).toBe(beforeDisconnect.attemptToken);
    expect(afterReconnect.leaseDeadline).toBe(beforeDisconnect.leaseDeadline);
    expect(afterReconnect.attemptDeadline).toBe(beforeDisconnect.attemptDeadline);
    expect(afterReconnect.generation).toBe(beforeDisconnect.generation);

    workerAPrime.send({
      type: 'taskResult',
      operationId,
      status: 'completed',
      value: 'v',
      attemptToken: dispatch.attemptToken,
    });
    await workerAPrime.nextServerMessage((m) => m.type === 'taskResultAck', { timeoutMs: 2_000 });

    const resolved = await readResolvedRecord(setup.engine, operationId);
    expect(resolved).not.toBeUndefined();
    expect(resolved).not.toBeNull();
    await waitForInflightCleared(setup.engine, operationId);
  });

  it('an UNPROVEN reconnect (no resumeSessionGeneration echo) forfeits the attempt before acknowledging — the old token is rejected even though routing reselects the same workerId (COR-220, criterion 3)', async () => {
    // Single worker: once its own in-flight work is forfeited and requeued,
    // it is the only eligible target, so routing MUST reselect it for the
    // redispatch — the sharp case the issue asks to prove explicitly. See
    // the PROVEN test above for why this grace value is moderate, not near
    // `MAX_WORKER_RECONNECT_GRACE_PERIOD_MS`.
    const setup = createSetup({ workerReconnectGracePeriodMs: 1_000 });
    const workerA = await connectAndRegisterWorker(setup, 'worker-a');

    const operationId = 'unproven-reconnect-op';
    void setup.server.dispatchTask({
      operationId,
      activityName: 'test.echo',
      workflowType: 'test',
      input: { value: 'v' },
      visibilityTimeout: 30_000,
    });

    const dispatch = await workerA.nextServerMessage(isTask, { timeoutMs: 2_000 });
    if (!isTask(dispatch)) throw new Error('expected task');
    const staleAttemptToken = dispatch.attemptToken;

    await workerA.hardClose();

    // No resumeSessionGeneration echo — this reconnect proves nothing.
    const { worker: workerAPrime, sessionGeneration } = await reconnectWorker(setup, 'worker-a');
    // The forfeit fully unregisters the old session (exactly like a natural
    // grace-lapse requeue would), so the next registration starts a BRAND
    // NEW session back at generation 1 — generation is a discriminator among
    // sessions the server currently remembers, not a lifetime counter (see
    // `registerAck.sessionGeneration`'s doc comment in
    // `remote-worker-protocol.md`). What actually proves this is a NEW
    // session, distinct from the one that held the stale attempt, is that
    // the forfeit ran and rotated the attempt away — asserted below by
    // reading the ledger and by the stale token's rejection, not by the raw
    // generation number.
    expect(sessionGeneration).toBe(1);

    // The registerAck is only sent once the forfeit's durable requeue has
    // been awaited to completion (see `registerWorker`'s doc comment) — by
    // construction, the record can no longer be `leased` under the stale
    // token the instant the ack arrives. No polling, no timer.
    const afterReconnect = await readLedgerRecord(setup.engine, operationId);
    const stillHoldsStaleAttempt =
      afterReconnect?.state === 'leased' && afterReconnect.attemptToken === staleAttemptToken;
    expect(stillHoldsStaleAttempt).toBe(false);

    // The late frame: worker-a' echoes the FORFEITED attempt's token. Same
    // workerId, brand new session — the old attempt is still stale.
    const staleRejection = workerAPrime.nextServerMessage((m) => m.type === 'protocolError', {
      timeoutMs: 2_000,
    });
    workerAPrime.send({
      type: 'taskResult',
      operationId,
      status: 'completed',
      value: 'stale',
      attemptToken: staleAttemptToken,
    });
    const rejected = await staleRejection;
    if (rejected.type !== 'protocolError') throw new Error('expected protocolError');
    expect(rejected.code).toBe('invalid_message');
    expect(rejected.message).toContain(operationId);

    // Routing reselects worker-a — it is the only worker — for the
    // redispatch, with a rotated attempt token.
    const redispatch = await workerAPrime.nextServerMessage(isTask, { timeoutMs: 5_000 });
    if (!isTask(redispatch)) throw new Error('expected redispatch');
    expect(redispatch.operationId).toBe(operationId);
    expect(redispatch.attemptToken).not.toBe(staleAttemptToken);

    workerAPrime.send({
      type: 'taskResult',
      operationId,
      status: 'completed',
      value: 'fresh',
      attemptToken: redispatch.attemptToken,
    });

    let resolved: unknown;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      resolved = await readResolvedRecord(setup.engine, operationId);
      if (resolved !== undefined && resolved !== null) break;
      await sleepForTesting(10);
    }
    expect(resolved !== undefined && resolved !== null).toBe(true);
    const resolvedRecord = resolved as { resultDigest?: string };
    expect(resolvedRecord.resultDigest).toBe(
      await sha256Hex(JSON.stringify({ status: 'completed', value: 'fresh', error: null })),
    );
    await waitForInflightCleared(setup.engine, operationId);
  });
});

describe('RemoteWorker durability — stale-session exclusion from routing during the grace window (COR-220, criterion 4)', () => {
  it('a fresh dispatch during the grace window is never sent to the disconnected socket — it falls through to the long-poll fallback path instead', async () => {
    // Single worker: any dispatch routed to it at all during the grace
    // window would have to go to the dead socket, since no peer exists.
    // `excludeWorkerIds` must make `findWorker` see zero eligible workers,
    // forcing the dispatch through the long-poll fallback path instead of
    // failing outright or writing to the closed connection. The fallback
    // path parks the task for an actual long-poll claim — a WebSocket
    // reconnect alone does not pull it back out (`redispatchAvailableQueuedRecord`
    // skips any operation `TaskQueue` still tracks as a long-poll waiter
    // match, by design, to avoid double-dispatching) — so this proves
    // exclusion by claiming it exactly the way a real long-poll worker would.
    // `workerShutdownTimeoutMs` is small deliberately: this test leaves
    // worker-a's FIRST task (never completed — the worker was disconnected
    // mid-attempt on purpose) in flight, so `afterEach`'s `server.stop()`
    // would otherwise block for the default 30s waiting for that worker to
    // drain or disconnect, which it never will (its socket is already dead).
    const setup = createSetup({
      workerReconnectGracePeriodMs: 1_000,
      workerShutdownTimeoutMs: 50,
    });
    const workerA = await connectAndRegisterWorker(setup, 'worker-a');

    const firstOperationId = 'grace-exclusion-first-op';
    void setup.server.dispatchTask({
      operationId: firstOperationId,
      activityName: 'test.echo',
      workflowType: 'test',
      input: { value: 'first' },
      visibilityTimeout: 30_000,
    });
    const firstDispatch = await workerA.nextServerMessage(isTask, { timeoutMs: 2_000 });
    if (!isTask(firstDispatch)) throw new Error('expected first task');

    await workerA.hardClose();

    // Dispatched while worker-a's socket is closed but its grace window has
    // not lapsed — worker-a is still in the registry (excluded from routing,
    // not yet forfeited).
    const excludedOperationId = 'grace-exclusion-second-op';
    const dispatched = await setup.server.dispatchTask({
      operationId: excludedOperationId,
      activityName: 'test.echo',
      workflowType: 'test',
      input: { value: 'excluded' },
      visibilityTimeout: 30_000,
    });
    expect(dispatched).toBe(true);

    // Never claimed by anyone — the record must still be `queued`, proving
    // no attempt was ever leased against the excluded (dead) socket.
    const recordWhileExcluded = await readLedgerRecord(setup.engine, excludedOperationId);
    expect(recordWhileExcluded?.state).toBe('queued');
    // `queued` alone is also the state after a failed claim releases its
    // reservation, so it does not by itself prove no attempt was ever
    // reserved against worker-a. This is the direct "never reserved" signal:
    // `findWorker` excluded worker-a and returned `false` before
    // `selectAndReserveWorker` ever called `registry.assignTask()`.
    expect(setup.server.registry.isAssigned(excludedOperationId)).toBe(false);

    // A real long-poll claim, exactly the fallback path a `LongPollWorker`
    // would use, proves the task is genuinely available — not lost, not
    // wedged waiting on the dead WebSocket connection.
    // `Connection: close` on both requests — otherwise Bun's fetch keeps the
    // underlying socket pooled and alive, which can leave `server.stop()` in
    // `afterEach` waiting on it (an unrelated Bun HTTP keep-alive quirk, not
    // anything about this test's own assertions).
    const pollResponse = await fetch(
      `${setup.server.url}/v1/tasks/default?activity=${encodeURIComponent('test.echo')}&timeout=2000`,
      { headers: { connection: 'close' } },
    );
    expect(pollResponse.status).toBe(200);
    const claimed = (await pollResponse.json()) as {
      operationId: string;
      workerId: string;
      attemptToken: string;
    };
    expect(claimed.operationId).toBe(excludedOperationId);

    const resultResponse = await fetch(`${setup.server.url}/v1/tasks/default/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({
        operationId: excludedOperationId,
        workerId: claimed.workerId,
        attemptToken: claimed.attemptToken,
        status: 'completed',
        value: 'excluded',
      }),
    });
    expect(resultResponse.status).toBe(200);

    const resolved = await readResolvedRecord(setup.engine, excludedOperationId);
    expect(resolved).not.toBeUndefined();
    expect(resolved).not.toBeNull();
    await waitForInflightCleared(setup.engine, excludedOperationId);
  });
});

describe('RemoteWorker durability — backpressure decline is redelivered', () => {
  it('redelivers a task that a buffer-full RemoteWorker declines without executing', async () => {
    // Disable reconnect grace so the decline (which fails the SDK worker's
    // socket) requeues inline. The behavior under test is the backpressure
    // decline plus redelivery, not real-time grace timer scheduling.
    const setup = createSetup({ workerReconnectGracePeriodMs: 0 });

    // worker-A is the real RemoteWorker SDK with a zero-capacity result buffer:
    // isOutboxFull(0, 0) is true, so it declines every task without executing
    // it and without emitting a result frame — the backpressure decline branch.
    let activityRan = false;
    using workerA = new RemoteWorker({
      serverUrl: setup.workerUrl,
      workerId: 'sdk-worker-a',
      deploymentName: 'test-deployment',
      buildId: 'test-build',
      maxBufferedResults: 0,
      workflows: {
        orders: {
          name: 'orders',
          activities: {
            echo: async (input: unknown) => {
              activityRan = true;
              return input;
            },
          },
        },
      },
    });
    await workerA.connect();

    // Worker B is registered before dispatch so the no-grace requeue has a
    // live WebSocket target. Round-robin preserves the first attempt for A
    // because A registered first. B gets its own deployment identity: it is a
    // different worker build than the SDK-based worker A, and sharing A's
    // (deploymentName, buildId) with a different declared shape would trip
    // the deployment-consistency guard's conflict detection.
    const workerB = await connectAndRegisterWorker(setup, 'worker-b', {
      activities: ['orders.echo'],
      manifestOverrides: {
        deployment: {
          name: 'test-deployment-b',
          buildId: 'test-build-b',
          artifactDigest: 'sha256:test-b',
        },
      },
    });
    const taskForB = workerB.nextServerMessage(isTask, { timeoutMs: 5_000 });

    // Dispatch with A first in the round-robin order, so the first attempt
    // lands on A, which declines it (buffer full) and fails its socket.
    const operationId = 'backpressure-redelivery-op';
    void setup.server.dispatchTask({
      operationId,
      // The SDK worker advertises the qualified `orders.echo` name; the raw
      // worker-B below registers the same name so the redelivery routes to it.
      activityName: 'orders.echo',
      workflowType: 'orders',
      input: { value: 'v' },
      visibilityTimeout: 5_000,
    });

    // worker-A's socket fails as a result of the decline.
    await waitForCondition(() => !workerA.connected, {
      timeoutMs: 3_000,
      label: 'worker-A socket failed after backpressure decline',
    });
    expect(workerA.connected).toBe(false);
    // worker-A's activity must never have executed — it declined the task.
    expect(activityRan).toBe(false);

    // worker-B receives the inline redelivery.
    const dispatchToB = await taskForB;
    if (!isTask(dispatchToB)) throw new Error('expected task on B');
    expect(dispatchToB.operationId).toBe(operationId);

    workerB.send({ type: 'heartbeat', workerId: 'worker-b' });
    workerB.send({
      type: 'taskResult',
      operationId,
      status: 'completed',
      value: 'v',
      attemptToken: dispatchToB.attemptToken,
    });

    await waitForCondition(
      async () => {
        const resolved = await readResolvedRecord(setup.engine, operationId);
        return resolved !== undefined && resolved !== null;
      },
      {
        timeoutMs: 2_000,
        label: 'backpressure redelivery task resolution',
      },
    );
    await waitForInflightCleared(setup.engine, operationId);
  });
});

describe('RemoteWorker durability — server restart while task is in flight', () => {
  const createdFixtures: string[] = [];
  const handles: SubprocessServerHandle[] = [];

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.stop()));
    for (const fixture of createdFixtures.splice(0)) {
      rmSync(fixture, { force: true, recursive: true });
      rmSync(`${fixture}-wal`, { force: true });
      rmSync(`${fixture}-shm`, { force: true });
    }
  });

  async function waitForTestDispatchUrl(handle: SubprocessServerHandle): Promise<string> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const match = handle.stdout.match(/WEFT_TEST_DISPATCH_URL\s+(\S+)/);
      if (match !== null && match[1] !== undefined) return match[1];
      await sleepForTesting(20);
    }
    throw new Error('Subprocess did not print WEFT_TEST_DISPATCH_URL within 3s');
  }

  function fixtureDir(name: string): string {
    const directory = join(tmpdir(), `weft-rwr-${name}-${crypto.randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    createdFixtures.push(directory);
    return directory;
  }

  async function writeEntrypoint(name: string, source: string): Promise<string> {
    const directory = fixtureDir(name);
    const path = join(directory, 'entrypoint.ts');
    await Bun.write(path, source);
    return path;
  }

  function entrypointSource(): string {
    const repoRoot = new URL('../..', import.meta.url);
    const indexUrl = new URL('src/index.ts', repoRoot).href;
    const serverUrl = new URL('src/server/index.ts', repoRoot).href;
    const sqliteUrl = new URL('src/storage/bun-sql.ts', repoRoot).href;
    const taskLedgerUrl = new URL('src/core/task-ledger/task-ledger.ts', repoRoot).href;
    return `
import { Engine, activity } from ${JSON.stringify(indexUrl)};
import { serve } from ${JSON.stringify(serverUrl)};
import { BunSQLiteStorage } from ${JSON.stringify(sqliteUrl)};
import { decodeRemoteTaskRecord, isRemoteTaskTerminalResolved, taskLedgerKey } from ${JSON.stringify(taskLedgerUrl)};

function readArgument(name, fallback) {
  const index = Bun.argv.indexOf(name);
  if (index === -1) return fallback;
  return Bun.argv[index + 1] ?? fallback;
}

const port = Number(readArgument('--port', '0'));
const databasePath = readArgument('--database', ':memory:');
const echo = activity({ name: 'echo', execute: async (input) => input.value });
const storage = new BunSQLiteStorage(databasePath);
const engine = new Engine({ storage });
engine.register(echo);
await engine.recoverAll();
const server = serve({
  engine,
  port,
  hostname: '127.0.0.1',
  routingPolicy: 'round-robin',
  visibilityPollIntervalMs: 50,
  workerReconnectGracePeriodMs: 50,
});

// Test control surface. The test posts to /__test__/dispatch after a WS
// worker is registered, so the dispatch can immediately land on the
// connected worker.
async function readResolvedKey(operationId) {
  const record = decodeRemoteTaskRecord(await engine.storage.get(taskLedgerKey(operationId)));
  return isRemoteTaskTerminalResolved(record) ? { present: true } : null;
}

const testServer = Bun.serve({
  port: Number(readArgument('--test-port', '0')),
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/__test__/dispatch') {
      const body = (await request.json());
      const ok = await server.dispatchTask({
        operationId: body.operationId,
        activityName: 'test.echo',
        workflowType: 'test',
        input: { value: body.value },
        visibilityTimeout: body.visibilityTimeout,
      });
      return new Response(JSON.stringify({ dispatched: ok }), { status: 200 });
    }
    if (url.pathname.startsWith('/__test__/resolved/')) {
      const operationId = decodeURIComponent(url.pathname.slice('/__test__/resolved/'.length));
      const result = await readResolvedKey(operationId);
      return new Response(JSON.stringify({ resolved: result !== null }), { status: 200 });
    }
    return new Response(null, { status: 404 });
  },
});

console.log('WEFT_SUBPROCESS_READY ' + server.url);
console.log('WEFT_TEST_DISPATCH_URL ' + testServer.url);

async function stop(exitCode) {
  await server.stop();
  storage[Symbol.dispose]();
  process.exit(exitCode);
}
process.on('SIGTERM', () => void stop(0));
process.on('SIGINT', () => void stop(0));
`;
  }

  it('recovers an in-flight task across SIGKILL and re-dispatches to a fresh worker', async () => {
    const entrypoint = await writeEntrypoint('scenario-4', entrypointSource());
    const databasePath = join(fixtureDir('scenario-4-db'), 'weft.db');

    const operationId = 'scenario-4-op';
    let handle = await spawnServerSubprocess({
      entrypoint,
      databasePath,
    });
    handles.push(handle);

    const workerUrl = `${handle.url.replace(/^http/, 'ws').replace(/\/?$/, '/')}v1/tasks/default/stream`;
    const workerA = await connectFaultInjectingWorker({ url: workerUrl, workerId: 'worker-a' });
    sockets.push(workerA);
    workerA.send({
      type: 'register',
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      workerId: 'worker-a',
      manifest: manifestForActivities(['echo']),
      concurrency: 1,
    });
    await workerA.nextServerMessage((m) => m.type === 'registerAck', { timeoutMs: 2_000 });

    // Trigger the dispatch via the subprocess's test-control HTTP server.
    const testDispatchUrl = await waitForTestDispatchUrl(handle);
    const dispatchResponse = await fetch(`${testDispatchUrl}/__test__/dispatch`, {
      method: 'POST',
      // visibilityTimeout has to comfortably exceed the subprocess restart
      // wall-clock window. Startup task-ledger recovery (`runTaskLedgerRecovery`)
      // requeues a `leased` record whose deadline has already elapsed while
      // the server was down rather than restoring it as still-owned; a tight
      // timeout here would let that requeue race the reboot instead of
      // exercising the "still within its lease" restore path this scenario
      // means to test. 5_000ms gives Bun.spawn + serve + recovery the time it
      // needs even on a slow runner.
      body: JSON.stringify({ operationId, value: 'restart-value', visibilityTimeout: 5_000 }),
      headers: { 'content-type': 'application/json' },
    });
    expect(dispatchResponse.ok).toBe(true);

    const dispatchToA = await workerA.nextServerMessage(isTask, { timeoutMs: 5_000 });
    if (!isTask(dispatchToA)) throw new Error('expected task');
    expect(dispatchToA.operationId).toBe(operationId);

    const rebooted = await killAndReboot(handle);
    handles.length = 0;
    handles.push(rebooted);

    const newWorkerUrl = `${rebooted.url.replace(/^http/, 'ws').replace(/\/?$/, '/')}v1/tasks/default/stream`;
    const workerB = await connectFaultInjectingWorker({ url: newWorkerUrl, workerId: 'worker-b' });
    sockets.push(workerB);
    workerB.send({
      type: 'register',
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      workerId: 'worker-b',
      manifest: manifestForActivities(['echo']),
      concurrency: 1,
    });
    await workerB.nextServerMessage((m) => m.type === 'registerAck', { timeoutMs: 2_000 });

    // worker-A's task carries the original visibilityTimeout (5_000ms). After
    // reboot, startup task-ledger recovery rehydrates the still-`leased`
    // record's registry ownership and deadline tracking until that deadline
    // elapses, at which point the visibility scanner re-dispatches to
    // worker-B. Wait window must comfortably exceed the remaining deadline
    // budget (post-reboot elapsed time + grace) — 15_000ms is conservative.
    const dispatchToB = await workerB.nextServerMessage(isTask, { timeoutMs: 15_000 });
    if (!isTask(dispatchToB)) throw new Error('expected task on B');
    expect(dispatchToB.operationId).toBe(operationId);
    expect((dispatchToB.attempt ?? 1) >= 2).toBe(true);
    // Recovery re-dispatch stamps a fresh token; fail clearly here if it did not.
    expect(dispatchToB.attemptToken).toBeString();

    workerB.send({
      type: 'taskResult',
      operationId,
      status: 'completed',
      value: 'restart-value',
      // Re-dispatch after recovery routes through selectAndReserveWorker, which
      // rotates the attempt token; echo the token from B's fresh dispatch.
      attemptToken: dispatchToB.attemptToken,
    });

    // Poll the rebooted subprocess's test-control endpoint for resolution.
    const newTestDispatchUrl = await waitForTestDispatchUrl(rebooted);
    const deadline = Date.now() + 5_000;
    let resolvedFlag = false;
    while (Date.now() < deadline) {
      const response = await fetch(
        `${newTestDispatchUrl}/__test__/resolved/${encodeURIComponent(operationId)}`,
      );
      if (response.ok) {
        const body = (await response.json()) as { resolved: boolean };
        if (body.resolved) {
          resolvedFlag = true;
          break;
        }
      }
      await sleepForTesting(20);
    }
    expect(resolvedFlag).toBe(true);
  }, 45_000);
});
