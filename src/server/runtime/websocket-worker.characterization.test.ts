/**
 * Characterization tests for handleWorkerWebSocketMessage.
 *
 * These tests assert outbound WebSocket messages and registry public-reader
 * state for every message variant (register, taskResult, heartbeat), plus
 * malformed/unknown-type paths. They do NOT assert private call order.
 *
 * `taskResult message` fixtures write real `task-ledger:` records (WFT-22)
 * instead of the retired `markInflight`/`op:inflight:` state — the ledger is
 * the sole authority `commitTaskLedgerCompletion` reads/writes today, and
 * response shapes here were never asserted (this suite checks WebSocket
 * frames and registry state, not HTTP responses), so no behavior changed —
 * only the fixture that seeds the durable ledger.
 */

import { describe, expect, it, spyOn } from 'bun:test';

import type { TaskResultDeadLetteredEvent } from '../../core/events.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { sleepForTesting, waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { REMOTE_WORKER_PROTOCOL_VERSION } from '../../worker/protocol.ts';
import { manifestForActivities } from '../../worker/registry-fixtures.test-support.ts';
import { principalFromApiKey } from '../principal.ts';
import {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  isRemoteTaskTerminalResolved,
  taskLedgerKey,
  type RemoteTaskLeased,
  type RemoteTaskTerminalResolved,
} from '../task-ledger.ts';
import {
  FailingTerminalCommitStorage,
  minimalServeOptions,
  minimalServerContext,
} from './server-context.test-support.ts';
import { handleWorkerWebSocketMessage } from './websocket-worker.ts';

import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';

type FakeWs = {
  data: WebSocketData;
  sentMessages: string[];
  closeCode?: number;
  closeReason?: string;
  /** Mirrors `ServerWebSocket.readyState`; defaults to OPEN (1) like a live connection. */
  readyState: number;
  send(msg: string): void;
  close(code: number, reason: string): void;
  unsubscribe(topic: string): void;
  terminate(): void;
};

function createFakeWs(pathname = '/v1/tasks/default/stream', queue = 'default'): FakeWs {
  const ws: FakeWs = {
    data: {
      pathname,
      connectionType: 'worker',
      queue,
    },
    sentMessages: [],
    readyState: WebSocket.OPEN,
    send(msg) {
      this.sentMessages.push(msg);
    },
    close(code, reason) {
      this.closeCode = code;
      this.closeReason = reason;
    },
    unsubscribe(_topic) {},
    terminate() {},
  };
  return ws;
}

const NOOP_CLEANUP = (_operationId: string) => {};

/** Build the JSON text for a `register` message advertising the given activities. */
function registerMessageJson(
  workerId: string,
  activities: string[],
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: 'register',
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    workerId,
    manifest: manifestForActivities(activities),
    concurrency: 3,
    ...overrides,
  });
}

/**
 * `registerWorker()` awaits `digestCanonicalWorkerManifest()` before sending
 * `registerAck` and updating `ws.data`, so a synchronous assertion right
 * after `handleWorkerWebSocketMessage()` would race a still-pending
 * registration. Poll for that side effect instead of a fixed sleep.
 */
async function waitForRegistrationSideEffect(predicate: () => boolean): Promise<void> {
  await waitForCondition(predicate, { timeoutMs: 1_000, label: 'registration side effect' });
}

function workerPrincipal() {
  return principalFromApiKey({ subject: 'worker-key', scopes: ['workers:write'] });
}

function setPayloadSizeLimit(context: unknown, maxBytes: number): void {
  (context as { payloadSizeMaxBytes: number | null }).payloadSizeMaxBytes = maxBytes;
}

/**
 * Build a `leased` ledger record directly (WFT-22), matching the
 * `leasedFixture()` pattern in `task-ledger.test.ts` / `task-ledger-transitions.test.ts`.
 * These `taskResult` tests are narrow completion-path unit tests — they
 * manually seed `context.registry.assignTask()` rather than driving a real
 * WebSocket dispatch, so a hand-built ledger record (not care how it got
 * into `leased` state) is the matching setup for the durable side.
 */
function leasedLedgerFixture(overrides: Partial<RemoteTaskLeased> = {}): RemoteTaskLeased {
  const now = Date.now();
  return {
    recordVersion: 1,
    operationId: 'op-1',
    workflowType: 'test',
    activityName: 'doWork',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: now,
    generation: 1,
    state: 'leased',
    attemptToken: 'attempt-token',
    workerSessionId: 'worker-1',
    attempt: 1,
    leaseDeadline: now + 30_000,
    firstQueuedAt: now,
    lastQueuedAt: now,
    startedAt: now,
    lastHeartbeatAt: now,
    retryCount: 0,
    requeueCount: 0,
    ...overrides,
  };
}

async function writeLeasedLedgerRecord(
  storage: MemoryStorage,
  overrides: Partial<RemoteTaskLeased> = {},
): Promise<RemoteTaskLeased> {
  const record = leasedLedgerFixture(overrides);
  await storage.put(taskLedgerKey(record.operationId), encodeRemoteTaskRecord(record));
  return record;
}

/**
 * Wait for and read a task's resolved terminal ledger record (WFT-22). No
 * `value` field is asserted anywhere below — the ledger's terminal record
 * never persists the completed payload (see
 * `state-worker-harness.parity.test.ts`'s `readTerminalRecord` doc comment;
 * delivering the value into a workflow continuation is WFT-24 territory).
 */
async function waitForResolvedTerminalRecord(
  storage: MemoryStorage,
  operationId: string,
  label: string,
): Promise<RemoteTaskTerminalResolved> {
  await waitForCondition(
    async () => {
      const record = decodeRemoteTaskRecord(await storage.get(taskLedgerKey(operationId)));
      return record !== null && record.state === 'terminal';
    },
    { timeoutMs: 1000, intervalMs: 10, label },
  );
  const record = decodeRemoteTaskRecord(await storage.get(taskLedgerKey(operationId)));
  if (!isRemoteTaskTerminalResolved(record)) {
    throw new Error(
      `Expected operation "${operationId}" to have a resolved terminal ledger record`,
    );
  }
  return record;
}

describe('handleWorkerWebSocketMessage', () => {
  describe('invalid JSON', () => {
    it('sends protocolError and closes on non-JSON input', () => {
      const context = minimalServerContext();
      const options = minimalServeOptions();
      const ws = createFakeWs();

      handleWorkerWebSocketMessage(context, options, ws as never, 'not valid json', NOOP_CLEANUP);

      expect(ws.sentMessages).toHaveLength(1);
      const msg = JSON.parse(ws.sentMessages[0]!);
      expect(msg.type).toBe('protocolError');
      expect(msg.code).toBe('invalid_json');
      expect(ws.closeCode).toBeDefined();
    });
  });

  describe('register message', () => {
    it('rejects registration when startup task-ledger recovery failed', async () => {
      const rejection = Promise.reject(new Error('recovery scan failed'));
      rejection.catch(() => {});
      const context = { ...minimalServerContext(), taskLedgerRecovery: { ready: rejection } };
      const options = minimalServeOptions();
      const ws = createFakeWs();

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        registerMessageJson('w-recovery-failed', ['doWork']),
        NOOP_CLEANUP,
      );

      await waitForRegistrationSideEffect(() => ws.sentMessages.length > 0);
      expect(ws.sentMessages).toHaveLength(1);
      const message = JSON.parse(ws.sentMessages[0]!);
      expect(message.type).toBe('registerError');
      expect(message.code).toBe('registration_rejected');
      expect(message.message).toContain('task-ledger recovery failed');
      expect(message.message).toContain('recovery scan failed');
      expect(context.registry.getWorker('w-recovery-failed')).toBeUndefined();
      expect(ws.closeCode).toBeDefined();
    });

    it('rejects authenticated worker registration without the worker write scope', async () => {
      const context = minimalServerContext();
      const options = minimalServeOptions();
      const ws = createFakeWs();
      ws.data.principal = principalFromApiKey({
        subject: 'client-key',
        scopes: ['workflows:read'],
      });

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        registerMessageJson('w-no-scope', ['doWork']),
        NOOP_CLEANUP,
      );

      await waitForRegistrationSideEffect(() => ws.sentMessages.length > 0);
      expect(ws.sentMessages).toHaveLength(1);
      const message = JSON.parse(ws.sentMessages[0]!);
      expect(message.type).toBe('registerError');
      expect(message.message).toContain('workers:write');
      expect(context.registry.getWorker('w-no-scope')).toBeUndefined();
      expect(ws.closeCode).toBeDefined();

      const [rejection] = context.registry.getRecentRejections(10);
      expect(rejection).toMatchObject({ code: 'invalid_registration', workerId: 'w-no-scope' });
    });

    it('accepts authenticated worker registration with the worker write scope', async () => {
      const context = minimalServerContext();
      const options = minimalServeOptions();
      const ws = createFakeWs();
      ws.data.principal = workerPrincipal();

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        registerMessageJson('w-worker-scope', ['doWork']),
        NOOP_CLEANUP,
      );

      await waitForRegistrationSideEffect(() => ws.sentMessages.length > 0);
      const ack = JSON.parse(ws.sentMessages[0]!);
      expect(ack.type).toBe('registerAck');
      expect(context.registry.getWorker('w-worker-scope')).toBeDefined();
    });

    it('registers worker and sends registerAck', async () => {
      const context = minimalServerContext();
      const options = minimalServeOptions();
      const ws = createFakeWs();

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        registerMessageJson('w-1', ['doWork']),
        NOOP_CLEANUP,
      );

      await waitForRegistrationSideEffect(() => ws.sentMessages.length > 0);
      const ack = JSON.parse(ws.sentMessages[0]!);
      expect(ack.type).toBe('registerAck');
      expect(ack.workerId).toBe('w-1');
      expect(ack.concurrency).toBe(3);
      expect(ws.data.workerRegistered).toBe(true);
      expect(ws.data.workerId).toBe('w-1');
    });

    it('rejects register with unsupported protocol version', () => {
      const context = minimalServerContext();
      const options = minimalServeOptions();
      const ws = createFakeWs();

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'register',
          protocolVersion: 9999,
          workerId: 'w-bad',
          manifest: {},
          concurrency: 1,
        }),
        NOOP_CLEANUP,
      );

      expect(ws.sentMessages).toHaveLength(1);
      const msg = JSON.parse(ws.sentMessages[0]!);
      expect(msg.type).toBe('registerError');
      expect(ws.closeCode).toBeDefined();

      const [rejection] = context.registry.getRecentRejections(10);
      expect(rejection).toMatchObject({
        code: 'unsupported_protocol_version',
        workerId: 'w-bad',
      });
    });

    it('rejects a v1 worker at handshake with the canonical incompatibility message', () => {
      // Phase 4 regression. A worker advertising the retired bare-name protocol
      // (v1) must be rejected before any task is dispatched. The error message
      // must point at the protocol mismatch, not at a missing activity.
      const context = minimalServerContext();
      const options = minimalServeOptions();
      const ws = createFakeWs();

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'register',
          protocolVersion: 1,
          workerId: 'w-old-protocol',
          manifest: {},
          concurrency: 1,
        }),
        NOOP_CLEANUP,
      );

      expect(ws.sentMessages).toHaveLength(1);
      const msg = JSON.parse(ws.sentMessages[0]!);
      expect(msg.type).toBe('registerError');
      expect(msg.code).toBe('unsupported_protocol_version');
      expect(msg.requestedProtocolVersion).toBe(1);
      expect(msg.message).toContain(`protocol v${String(REMOTE_WORKER_PROTOCOL_VERSION)}`);
      expect(msg.message).toContain('got v1');
      expect(msg.message).toContain('qualified activity names');
      // Old-protocol worker never enters the registry.
      expect(context.registry.getWorker('w-old-protocol')).toBeUndefined();
      expect(ws.closeCode).toBeDefined();

      const [rejection] = context.registry.getRecentRejections(10);
      expect(rejection).toMatchObject({
        code: 'unsupported_protocol_version',
        workerId: 'w-old-protocol',
      });
    });

    it('rejects registration with a manifest that fails validation', async () => {
      // The manifest check runs before the async digest step, but
      // `registerWorker` now awaits the task-ledger recovery gate first
      // (WFT-23), so this still needs to poll for the rejection side effect
      // rather than asserting synchronously.
      const context = minimalServerContext();
      const options = minimalServeOptions();
      const ws = createFakeWs();

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        registerMessageJson('w-bad-manifest', ['doWork'], { manifest: { bogus: true } }),
        NOOP_CLEANUP,
      );

      await waitForRegistrationSideEffect(() => ws.sentMessages.length > 0);
      expect(ws.sentMessages).toHaveLength(1);
      const msg = JSON.parse(ws.sentMessages[0]!);
      expect(msg.type).toBe('registerError');
      expect(msg.code).toBe('invalid_registration');
      expect(context.registry.getWorker('w-bad-manifest')).toBeUndefined();

      const [rejection] = context.registry.getRecentRejections(10);
      expect(rejection).toMatchObject({
        code: 'invalid_registration',
        workerId: 'w-bad-manifest',
      });
    });

    it('rejects registration when the manifest protocolVersion disagrees with the wire protocolVersion', async () => {
      // The wire-level register.protocolVersion and the manifest's own
      // protocolVersion field are independent claims; a worker asserting
      // v3 at the handshake but v2 inside its manifest must not be silently
      // accepted with contradictory stored provenance.
      const context = minimalServerContext();
      const options = minimalServeOptions();
      const ws = createFakeWs();

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        registerMessageJson('w-version-mismatch', ['doWork'], {
          manifest: manifestForActivities(['doWork'], { protocolVersion: 2 }),
        }),
        NOOP_CLEANUP,
      );

      await waitForRegistrationSideEffect(() => ws.sentMessages.length > 0);
      expect(ws.sentMessages).toHaveLength(1);
      const msg = JSON.parse(ws.sentMessages[0]!);
      expect(msg.type).toBe('registerError');
      expect(msg.code).toBe('invalid_registration');
      expect(msg.message).toContain('protocolVersion 2');
      expect(context.registry.getWorker('w-version-mismatch')).toBeUndefined();

      const [rejection] = context.registry.getRecentRejections(10);
      expect(rejection).toMatchObject({
        code: 'invalid_registration',
        workerId: 'w-version-mismatch',
      });
    });

    it('rejects a second worker whose deployment/build pair conflicts with a different artifact digest', async () => {
      const context = minimalServerContext();
      const options = minimalServeOptions();

      const ws1 = createFakeWs();
      handleWorkerWebSocketMessage(
        context,
        options,
        ws1 as never,
        registerMessageJson('w-deploy-a', ['doWork'], {
          manifest: manifestForActivities(['doWork'], {
            deployment: { name: 'shared-deployment', buildId: 'b1', artifactDigest: 'sha256:aaa' },
          }),
        }),
        NOOP_CLEANUP,
      );
      await waitForRegistrationSideEffect(() => ws1.sentMessages.length > 0);
      expect(JSON.parse(ws1.sentMessages[0]!).type).toBe('registerAck');

      // Second worker declares the same (deploymentName, buildId) pair with a
      // different artifact digest — the deployment-consistency check now runs
      // in the final commit block, after the manifest digest await, so this
      // rejection is asynchronous.
      const ws2 = createFakeWs();
      handleWorkerWebSocketMessage(
        context,
        options,
        ws2 as never,
        registerMessageJson('w-deploy-b', ['doWork'], {
          manifest: manifestForActivities(['doWork'], {
            deployment: { name: 'shared-deployment', buildId: 'b1', artifactDigest: 'sha256:bbb' },
          }),
        }),
        NOOP_CLEANUP,
      );

      await waitForRegistrationSideEffect(() => ws2.sentMessages.length > 0);
      expect(ws2.sentMessages).toHaveLength(1);
      const rejection = JSON.parse(ws2.sentMessages[0]!);
      expect(rejection.type).toBe('registerError');
      expect(rejection.code).toBe('deployment_conflict');
      expect(context.registry.getWorker('w-deploy-b')).toBeUndefined();

      const [recorded] = context.registry.getRecentRejections(10);
      expect(recorded).toMatchObject({
        code: 'deployment_conflict',
        workerId: 'w-deploy-b',
        deploymentName: 'shared-deployment',
        buildId: 'b1',
      });
    });

    it('rejects registration when the configured worker admission policy declines it', async () => {
      const context = minimalServerContext();
      const options = {
        ...minimalServeOptions(),
        workerAdmissionPolicy: () => ({
          status: 'rejected' as const,
          reason: 'fleet quota exceeded',
        }),
      };
      const ws = createFakeWs();

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        registerMessageJson('w-denied', ['doWork']),
        NOOP_CLEANUP,
      );

      await waitForRegistrationSideEffect(() => ws.sentMessages.length > 0);
      expect(ws.sentMessages).toHaveLength(1);
      const msg = JSON.parse(ws.sentMessages[0]!);
      expect(msg.type).toBe('registerError');
      expect(msg.code).toBe('registration_rejected');
      expect(msg.message).toBe('fleet quota exceeded');
      expect(context.registry.getWorker('w-denied')).toBeUndefined();

      const [rejection] = context.registry.getRecentRejections(10);
      expect(rejection).toMatchObject({ code: 'registration_rejected', workerId: 'w-denied' });
    });

    it('accepts registration when the configured worker admission policy allows it', async () => {
      const context = minimalServerContext();
      const options = {
        ...minimalServeOptions(),
        workerAdmissionPolicy: () => ({ status: 'accepted' as const }),
      };
      const ws = createFakeWs();

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        registerMessageJson('w-allowed', ['doWork']),
        NOOP_CLEANUP,
      );

      await waitForRegistrationSideEffect(() => ws.sentMessages.length > 0);
      const ack = JSON.parse(ws.sentMessages[0]!);
      expect(ack.type).toBe('registerAck');
      expect(context.registry.getWorker('w-allowed')).toBeDefined();
    });

    it('rejects registration when the configured worker admission policy throws', async () => {
      // A throwing policy must not leave the client hanging with no
      // registerError and no closed socket — the fire-and-forget register
      // handler only logs an unhandled rejection, it never replies.
      const context = minimalServerContext();
      const options = {
        ...minimalServeOptions(),
        workerAdmissionPolicy: () => {
          throw new Error('admission policy exploded');
        },
      };
      const ws = createFakeWs();

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        registerMessageJson('w-policy-throws', ['doWork']),
        NOOP_CLEANUP,
      );

      await waitForRegistrationSideEffect(() => ws.sentMessages.length > 0);
      expect(ws.sentMessages).toHaveLength(1);
      const msg = JSON.parse(ws.sentMessages[0]!);
      expect(msg.type).toBe('registerError');
      expect(msg.code).toBe('registration_rejected');
      expect(msg.message).toContain('admission policy exploded');
      expect(context.registry.getWorker('w-policy-throws')).toBeUndefined();

      const [rejection] = context.registry.getRecentRejections(10);
      expect(rejection).toMatchObject({
        code: 'registration_rejected',
        workerId: 'w-policy-throws',
      });
    });

    it('does not register a worker whose socket already closed while the manifest digest was pending', async () => {
      // ws.data.workerId is unset until commit time, so a peer that
      // disconnects while digestCanonicalWorkerManifest() is still pending
      // gets no cleanup from the close handler (it checks ws.data.workerId
      // and finds nothing). Without a live-socket check here, the commit
      // below would proceed anyway and register a ghost worker on a dead
      // socket — one that can never execute a task and blocks a genuine
      // reconnect under the same workerId.
      const context = minimalServerContext();
      const options = minimalServeOptions();
      const ws = createFakeWs();

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        registerMessageJson('w-closed-mid-digest', ['doWork']),
        NOOP_CLEANUP,
      );

      // Simulate the peer closing before the digest resolves.
      ws.readyState = WebSocket.CLOSED;

      // Give the pending digest time to resolve and the post-await commit
      // logic time to run (or, correctly, not run).
      await sleepForTesting(50);

      expect(ws.sentMessages).toHaveLength(0);
      expect(context.registry.getWorker('w-closed-mid-digest')).toBeUndefined();
      expect(context.workerSockets.get('w-closed-mid-digest') as unknown).toBeUndefined();
    });

    it('does not let a worker rejected by the admission policy poison the deployment-consistency record', async () => {
      // checkDeploymentConsistency now records the accepted digest only in
      // the final commit block, after the admission policy has already
      // accepted the worker. Without that ordering, a rejected worker's
      // untrusted digest would still be recorded (checkAndRecord never
      // evicts), permanently denying every future legitimate worker for the
      // same deployment/build pair.
      const context = minimalServerContext();
      const options = {
        ...minimalServeOptions(),
        workerAdmissionPolicy: (request: { workerId: string }) =>
          request.workerId === 'w-untrusted'
            ? { status: 'rejected' as const, reason: 'not on the allowlist' }
            : { status: 'accepted' as const },
      };

      const rejectedWs = createFakeWs();
      handleWorkerWebSocketMessage(
        context,
        options,
        rejectedWs as never,
        registerMessageJson('w-untrusted', ['doWork'], {
          manifest: manifestForActivities(['doWork'], {
            deployment: { name: 'shared-deployment', buildId: 'b1', artifactDigest: 'sha256:fake' },
          }),
        }),
        NOOP_CLEANUP,
      );

      await waitForRegistrationSideEffect(() => rejectedWs.sentMessages.length > 0);
      expect(rejectedWs.sentMessages).toHaveLength(1);
      expect(JSON.parse(rejectedWs.sentMessages[0]!).code).toBe('registration_rejected');

      const legitimateWs = createFakeWs();
      handleWorkerWebSocketMessage(
        context,
        options,
        legitimateWs as never,
        registerMessageJson('w-legit', ['doWork'], {
          manifest: manifestForActivities(['doWork'], {
            deployment: { name: 'shared-deployment', buildId: 'b1', artifactDigest: 'sha256:real' },
          }),
        }),
        NOOP_CLEANUP,
      );

      await waitForRegistrationSideEffect(() => legitimateWs.sentMessages.length > 0);
      const ack = JSON.parse(legitimateWs.sentMessages[0]!);
      expect(ack.type).toBe('registerAck');
      expect(context.registry.getWorker('w-legit')).toBeDefined();
    });

    it('does not let a worker rejected by the hijack guard poison the deployment-consistency record', async () => {
      // The deployment-consistency digest is recorded only after the hijack
      // guard has also passed, not alongside the earlier read-only check.
      // Without that ordering, an attacker claiming an already-registered
      // workerId with a brand-new (deploymentName, buildId) pair would still
      // poison that slot even though the hijack guard rejects them, denying
      // every future legitimate worker for the same pair.
      const context = minimalServerContext();
      const options = minimalServeOptions();

      const ownerWs = createFakeWs();
      handleWorkerWebSocketMessage(
        context,
        options,
        ownerWs as never,
        registerMessageJson('w-hijack-target', ['doWork']),
        NOOP_CLEANUP,
      );
      await waitForRegistrationSideEffect(() => ownerWs.sentMessages.length > 0);
      expect(JSON.parse(ownerWs.sentMessages[0]!).type).toBe('registerAck');

      // Attacker claims the already-registered workerId, but presents a
      // brand-new deployment/build pair with an untrusted digest.
      const attackerWs = createFakeWs();
      handleWorkerWebSocketMessage(
        context,
        options,
        attackerWs as never,
        registerMessageJson('w-hijack-target', ['doWork'], {
          manifest: manifestForActivities(['doWork'], {
            deployment: {
              name: 'never-seen-deployment',
              buildId: 'b1',
              artifactDigest: 'sha256:fake',
            },
          }),
        }),
        NOOP_CLEANUP,
      );
      await waitForRegistrationSideEffect(() => attackerWs.sentMessages.length > 0);
      expect(JSON.parse(attackerWs.sentMessages[0]!).code).toBe('invalid_registration');

      // A legitimate worker for the SAME deployment/build pair, but a
      // different digest than the attacker claimed, must still succeed.
      const legitimateWs = createFakeWs();
      handleWorkerWebSocketMessage(
        context,
        options,
        legitimateWs as never,
        registerMessageJson('w-not-hijacked', ['doWork'], {
          manifest: manifestForActivities(['doWork'], {
            deployment: {
              name: 'never-seen-deployment',
              buildId: 'b1',
              artifactDigest: 'sha256:real',
            },
          }),
        }),
        NOOP_CLEANUP,
      );

      await waitForRegistrationSideEffect(() => legitimateWs.sentMessages.length > 0);
      const ack = JSON.parse(legitimateWs.sentMessages[0]!);
      expect(ack.type).toBe('registerAck');
      expect(context.registry.getWorker('w-not-hijacked')).toBeDefined();
    });

    it('logs when the register handler rejects asynchronously', async () => {
      // Registration succeeds (registry insert + ack already sent) before the
      // final event-dispatch step throws, so the failure surfaces only
      // through the fire-and-forget `.catch()` in the message handler.
      const context = minimalServerContext();
      const options = {
        engine: {
          storage: new MemoryStorage(),
          dispatchEvent: () => {
            throw new Error('dispatch failed');
          },
        },
        port: 0,
      };
      const ws = createFakeWs();

      using errorSpy = spyOn(console, 'error').mockImplementation(() => {});

      handleWorkerWebSocketMessage(
        context,
        options as never,
        ws as never,
        registerMessageJson('w-dispatch-failure', ['doWork']),
        NOOP_CLEANUP,
      );

      await waitForCondition(() => errorSpy.mock.calls.length > 0, {
        timeoutMs: 1000,
        label: 'register handler rejection to be logged',
      });

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Failed to register worker "w-dispatch-failure":',
        expect.any(Error),
      );
      expect(context.registry.getWorker('w-dispatch-failure')).toBeDefined();
    });

    it('rejects when worker sends non-register first message', () => {
      const context = minimalServerContext();
      const options = minimalServeOptions();
      const ws = createFakeWs();

      // heartbeat without prior registration
      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({ type: 'heartbeat', workerId: 'w-unregistered' }),
        NOOP_CLEANUP,
      );

      expect(ws.sentMessages).toHaveLength(1);
      const msg = JSON.parse(ws.sentMessages[0]!);
      expect(msg.type).toBe('protocolError');
      expect(msg.code).toBe('registration_required');
    });
  });

  describe('taskResult message', () => {
    it('completes task in registry and removes deadline tracker entry', async () => {
      const context = minimalServerContext();
      const storage = new MemoryStorage();
      const options = minimalServeOptions(storage);
      const ws = createFakeWs();

      // Register worker first
      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        registerMessageJson('w-result', ['doWork'], { concurrency: 5 }),
        NOOP_CLEANUP,
      );
      await waitForRegistrationSideEffect(
        () => context.registry.getWorker('w-result') !== undefined,
      );

      // Manually assign a task to the registry and add deadline
      context.registry.assignTask('w-result', 'op-finish', 30_000, undefined, 'attempt-token');
      context.deadlineTracker.add({ operationId: 'op-finish', deadline: Date.now() + 30_000 });
      await writeLeasedLedgerRecord(storage, {
        operationId: 'op-finish',
        workerSessionId: 'w-result',
      });

      expect(context.registry.isAssigned('op-finish')).toBe(true);
      expect(context.deadlineTracker.size).toBe(1);

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'taskResult',
          operationId: 'op-finish',
          attemptToken: 'attempt-token',
          status: 'completed',
          value: 'done',
        }),
        NOOP_CLEANUP,
      );

      expect(context.registry.isAssigned('op-finish')).toBe(false);
      expect(context.deadlineTracker.size).toBe(0);
    });

    it('calls cleanupWorkflowIndex with the operationId', async () => {
      const context = minimalServerContext();
      const storage = new MemoryStorage();
      const options = minimalServeOptions(storage);
      const ws = createFakeWs();

      const cleaned: string[] = [];

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        registerMessageJson('w-cleanup', ['cleanWork'], { concurrency: 5 }),
        NOOP_CLEANUP,
      );
      await waitForRegistrationSideEffect(
        () => context.registry.getWorker('w-cleanup') !== undefined,
      );

      context.registry.assignTask('w-cleanup', 'op-cleanup', 30_000, undefined, 'attempt-token');
      await writeLeasedLedgerRecord(storage, {
        operationId: 'op-cleanup',
        workerSessionId: 'w-cleanup',
        activityName: 'cleanWork',
      });

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'taskResult',
          operationId: 'op-cleanup',
          attemptToken: 'attempt-token',
          status: 'failed',
          error: 'something broke',
        }),
        (opId) => {
          cleaned.push(opId);
        },
      );

      expect(cleaned).toEqual(['op-cleanup']);
    });

    it('rejects oversized completed results and resolves the task as failed', async () => {
      const storage = new MemoryStorage();
      const context = minimalServerContext();
      setPayloadSizeLimit(context, 64);
      const options = minimalServeOptions(storage);
      const ws = createFakeWs();

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        registerMessageJson('w-oversize', ['doWork'], { concurrency: 5 }),
        NOOP_CLEANUP,
      );
      await waitForRegistrationSideEffect(
        () => context.registry.getWorker('w-oversize') !== undefined,
      );

      context.registry.assignTask('w-oversize', 'op-oversize', 30_000, undefined, 'attempt-token');
      context.deadlineTracker.add({ operationId: 'op-oversize', deadline: Date.now() + 30_000 });
      await writeLeasedLedgerRecord(storage, {
        operationId: 'op-oversize',
        workerSessionId: 'w-oversize',
      });

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'taskResult',
          operationId: 'op-oversize',
          attemptToken: 'attempt-token',
          status: 'completed',
          value: { blob: 'x'.repeat(200) },
        }),
        NOOP_CLEANUP,
      );

      const resolved = await waitForResolvedTerminalRecord(
        storage,
        'op-oversize',
        'oversized WebSocket task to resolve failed',
      );

      const protocolError = ws.sentMessages
        .map((message) => JSON.parse(message))
        .find((message: { type?: string }) => message.type === 'protocolError');
      expect(protocolError).toMatchObject({
        type: 'protocolError',
        code: 'invalid_message',
      });
      expect(String(protocolError.message)).toContain('activity result exceeds');
      expect(context.registry.isAssigned('op-oversize')).toBe(false);
      expect(context.deadlineTracker.size).toBe(0);

      expect(resolved.status).toBe('failed');
      expect(resolved.error).toContain('activity result exceeds');
    });

    it('rejects oversized cancelled errors and resolves the task as failed', async () => {
      const storage = new MemoryStorage();
      const context = minimalServerContext();
      setPayloadSizeLimit(context, 64);
      const options = minimalServeOptions(storage);
      const ws = createFakeWs();

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        registerMessageJson('w-cancel-oversize', ['doWork'], { concurrency: 5 }),
        NOOP_CLEANUP,
      );
      await waitForRegistrationSideEffect(
        () => context.registry.getWorker('w-cancel-oversize') !== undefined,
      );

      context.registry.assignTask(
        'w-cancel-oversize',
        'op-cancel-oversize',
        30_000,
        undefined,
        'attempt-token',
      );
      await writeLeasedLedgerRecord(storage, {
        operationId: 'op-cancel-oversize',
        workerSessionId: 'w-cancel-oversize',
      });

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'taskResult',
          operationId: 'op-cancel-oversize',
          attemptToken: 'attempt-token',
          status: 'cancelled',
          cancelled: true,
          error: 'x'.repeat(200),
        }),
        NOOP_CLEANUP,
      );

      const resolved = await waitForResolvedTerminalRecord(
        storage,
        'op-cancel-oversize',
        'oversized WebSocket cancellation to resolve failed',
      );

      const protocolError = ws.sentMessages
        .map((message) => JSON.parse(message))
        .find((message: { type?: string }) => message.type === 'protocolError');
      expect(String(protocolError.message)).toContain('activity result exceeds');

      expect(resolved.status).toBe('failed');
      expect(resolved.error).toContain('activity result exceeds');
      expect(resolved.error).not.toContain('x'.repeat(100));
    });

    it('logs when inflight resolution throws after the task is dequeued', async () => {
      const storage = {
        get: async () => {
          throw new Error('storage read failed');
        },
      } as unknown as MemoryStorage;
      const context = minimalServerContext();
      const options = minimalServeOptions(storage);
      const ws = createFakeWs();

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        registerMessageJson('w-storage-failure', ['doWork'], { concurrency: 5 }),
        NOOP_CLEANUP,
      );
      await waitForRegistrationSideEffect(
        () => context.registry.getWorker('w-storage-failure') !== undefined,
      );

      context.registry.assignTask(
        'w-storage-failure',
        'op-storage-failure',
        30_000,
        undefined,
        'attempt-token',
      );

      using errorSpy = spyOn(console, 'error').mockImplementation(() => {});

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'taskResult',
          operationId: 'op-storage-failure',
          attemptToken: 'attempt-token',
          status: 'completed',
          value: 'done',
        }),
        NOOP_CLEANUP,
      );

      await waitForCondition(async () => errorSpy.mock.calls.length > 0, {
        timeoutMs: 1000,
        intervalMs: 10,
        label: 'taskResult resolution failure to be logged',
      });

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Failed to transition task "op-storage-failure" to resolved — inflight record may leak:',
        expect.any(Error),
      );
    });

    it('logs, dead-letters, and dispatches TaskResultDeadLetteredEvent when the durable completion commit loses its CAS', async () => {
      const storage = new FailingTerminalCommitStorage('op-commit-loses-cas');
      const context = minimalServerContext();
      const options = minimalServeOptions(storage);
      const dispatchEventSpy = spyOn(options.engine, 'dispatchEvent');
      const ws = createFakeWs();

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        registerMessageJson('w-commit-loses-cas', ['doWork'], { concurrency: 5 }),
        NOOP_CLEANUP,
      );
      await waitForRegistrationSideEffect(
        () => context.registry.getWorker('w-commit-loses-cas') !== undefined,
      );

      context.registry.assignTask(
        'w-commit-loses-cas',
        'op-commit-loses-cas',
        30_000,
        undefined,
        'attempt-token',
      );
      await writeLeasedLedgerRecord(storage, {
        operationId: 'op-commit-loses-cas',
        workerSessionId: 'w-commit-loses-cas',
      });

      using errorSpy = spyOn(console, 'error').mockImplementation(() => {});

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'taskResult',
          operationId: 'op-commit-loses-cas',
          attemptToken: 'attempt-token',
          status: 'completed',
          value: 'done',
        }),
        NOOP_CLEANUP,
      );

      await waitForCondition(async () => errorSpy.mock.calls.length > 0, {
        timeoutMs: 1000,
        intervalMs: 10,
        label: 'lost-CAS completion commit to be logged',
      });

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Failed to commit task result for "op-commit-loses-cas" through the durable ledger:',
        expect.any(String),
      );

      // WFT-24: FailingTerminalCommitStorage only blocks writes whose next
      // state is `terminal`, so the best-effort Completing --> DeadLettered
      // escalation (next state `deadLettered`) succeeds.
      const deadLettered = decodeRemoteTaskRecord(
        await storage.get(taskLedgerKey('op-commit-loses-cas')),
      );
      expect(deadLettered?.state).toBe('deadLettered');
      // dispatchEventSpy also observes registration's own event(s), so filter
      // to the dead-letter event specifically rather than asserting a raw count.
      const deadLetterEvents = dispatchEventSpy.mock.calls
        .map((call) => call[0])
        .filter((event) => event.type === 'task:dead-lettered');
      expect(deadLetterEvents).toHaveLength(1);
      const dispatchedEvent = deadLetterEvents[0] as TaskResultDeadLetteredEvent;
      expect(dispatchedEvent.operationId).toBe('op-commit-loses-cas');
    });

    it('logs, dead-letters, and dispatches TaskResultDeadLetteredEvent when the durable oversized-rejection commit loses its CAS', async () => {
      const storage = new FailingTerminalCommitStorage('op-rejection-loses-cas');
      const context = minimalServerContext();
      setPayloadSizeLimit(context, 64);
      const options = minimalServeOptions(storage);
      const dispatchEventSpy = spyOn(options.engine, 'dispatchEvent');
      const ws = createFakeWs();

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        registerMessageJson('w-rejection-loses-cas', ['doWork'], { concurrency: 5 }),
        NOOP_CLEANUP,
      );
      await waitForRegistrationSideEffect(
        () => context.registry.getWorker('w-rejection-loses-cas') !== undefined,
      );

      context.registry.assignTask(
        'w-rejection-loses-cas',
        'op-rejection-loses-cas',
        30_000,
        undefined,
        'attempt-token',
      );
      await writeLeasedLedgerRecord(storage, {
        operationId: 'op-rejection-loses-cas',
        workerSessionId: 'w-rejection-loses-cas',
      });

      using errorSpy = spyOn(console, 'error').mockImplementation(() => {});

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'taskResult',
          operationId: 'op-rejection-loses-cas',
          attemptToken: 'attempt-token',
          status: 'completed',
          value: { blob: 'x'.repeat(200) },
        }),
        NOOP_CLEANUP,
      );

      await waitForCondition(async () => errorSpy.mock.calls.length > 0, {
        timeoutMs: 1000,
        intervalMs: 10,
        label: 'lost-CAS oversized-rejection commit to be logged',
      });

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Failed to persist oversized task result rejection for task "op-rejection-loses-cas":',
        expect.any(String),
      );

      const deadLettered = decodeRemoteTaskRecord(
        await storage.get(taskLedgerKey('op-rejection-loses-cas')),
      );
      expect(deadLettered?.state).toBe('deadLettered');
      // dispatchEventSpy also observes registration's own event(s), so filter
      // to the dead-letter event specifically rather than asserting a raw count.
      const deadLetterEvents = dispatchEventSpy.mock.calls
        .map((call) => call[0])
        .filter((event) => event.type === 'task:dead-lettered');
      expect(deadLetterEvents).toHaveLength(1);
      const dispatchedEvent = deadLetterEvents[0] as TaskResultDeadLetteredEvent;
      expect(dispatchedEvent.operationId).toBe('op-rejection-loses-cas');
    });
  });

  describe('heartbeat message', () => {
    it('updates registry heartbeat for registered worker', async () => {
      const context = minimalServerContext();
      const options = minimalServeOptions();
      const ws = createFakeWs();

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        registerMessageJson('w-hb', ['heartWork'], { concurrency: 5 }),
        NOOP_CLEANUP,
      );
      await waitForRegistrationSideEffect(() => context.registry.getWorker('w-hb') !== undefined);

      const heartbeatBefore = context.registry.getWorker('w-hb')?.lastHeartbeat;

      // Should not throw — heartbeat is a side-effect-only operation
      expect(() => {
        handleWorkerWebSocketMessage(
          context,
          options,
          ws as never,
          JSON.stringify({ type: 'heartbeat', workerId: 'w-hb' }),
          NOOP_CLEANUP,
        );
      }).not.toThrow();

      expect(context.registry.getWorker('w-hb')?.lastHeartbeat).toBeGreaterThanOrEqual(
        heartbeatBefore!,
      );
    });
  });

  describe('non-worker connection', () => {
    it('returns immediately without processing for non-worker pathname', () => {
      const context = minimalServerContext();
      const options = minimalServeOptions();
      // Not a worker stream path
      const ws = createFakeWs('/v1/workflows/wf-1/stream', undefined as unknown as string);
      ws.data.connectionType = 'stream';

      handleWorkerWebSocketMessage(context, options, ws as never, 'not json', NOOP_CLEANUP);

      // No messages sent because early return on non-worker path
      expect(ws.sentMessages).toHaveLength(0);
    });
  });

  describe('duplicate workerId registration', () => {
    it('rejects a second register message for a workerId already mapped to a live socket', async () => {
      // Security regression: an unauthenticated or malicious client that knows an
      // active workerId must not be able to displace the legitimate socket.
      const context = minimalServerContext();
      const options = minimalServeOptions();

      // First socket — the legitimate worker.
      const ws1 = createFakeWs();
      handleWorkerWebSocketMessage(
        context,
        options,
        ws1 as never,
        registerMessageJson('w-live', ['doWork'], { concurrency: 2 }),
        NOOP_CLEANUP,
      );
      await waitForRegistrationSideEffect(() => ws1.sentMessages.length > 0);
      expect(ws1.sentMessages).toHaveLength(1);
      expect(JSON.parse(ws1.sentMessages[0]!).type).toBe('registerAck');
      // `workerSockets` is typed against the real `ServerWebSocket`; the stored
      // value is our `FakeWs` (passed in as `never`), so widen to `unknown` to
      // assert reference identity without a `ServerWebSocket` overlap mismatch.
      expect(context.workerSockets.get('w-live') as unknown).toBe(ws1);

      // Second (attacker) socket — attempts to claim the same workerId.
      const ws2 = createFakeWs();
      handleWorkerWebSocketMessage(
        context,
        options,
        ws2 as never,
        registerMessageJson('w-live', ['doWork'], { concurrency: 2 }),
        NOOP_CLEANUP,
      );

      // Attacker must receive registerError with code 'invalid_registration'.
      // The hijack guard runs immediately before workerSockets.set (after the
      // manifest digest await, to close the concurrent-registration race), so
      // this rejection is asynchronous.
      await waitForRegistrationSideEffect(() => ws2.sentMessages.length > 0);
      expect(ws2.sentMessages).toHaveLength(1);
      const rejection = JSON.parse(ws2.sentMessages[0]!);
      expect(rejection.type).toBe('registerError');
      expect(rejection.code).toBe('invalid_registration');
      // Attacker socket must be closed.
      expect(ws2.closeCode).toBeDefined();
      // Original socket must remain the owner in the map.
      expect(context.workerSockets.get('w-live') as unknown).toBe(ws1);

      // Only the attacker's attempt is recorded — the legitimate first
      // registration never rejected.
      const recentRejections = context.registry.getRecentRejections(10);
      expect(recentRejections).toHaveLength(1);
      expect(recentRejections[0]).toMatchObject({
        code: 'invalid_registration',
        workerId: 'w-live',
      });
    });

    it('allows the same socket to re-register the same workerId (metadata refresh)', async () => {
      // The hijacking guard keys on socket IDENTITY, not mere presence: a second
      // register on the SAME connection (e.g. to refresh its activity list or
      // concurrency) is a legitimate refresh, not a takeover, and must be
      // accepted. `WorkerRegistry.register` is built to refresh an existing id.
      const context = minimalServerContext();
      const options = minimalServeOptions();

      const ws = createFakeWs();
      const register = (activities: string[], concurrency: number) =>
        handleWorkerWebSocketMessage(
          context,
          options,
          ws as never,
          registerMessageJson('w-refresh', activities, { concurrency }),
          NOOP_CLEANUP,
        );

      register(['doWork'], 2);
      await waitForRegistrationSideEffect(() => ws.sentMessages.length > 0);
      expect(JSON.parse(ws.sentMessages[0]!).type).toBe('registerAck');

      // Same socket re-registers with updated metadata — must be accepted, not
      // rejected as a duplicate.
      register(['doWork', 'doMore'], 5);
      await waitForRegistrationSideEffect(() => ws.sentMessages.length > 1);
      expect(ws.sentMessages).toHaveLength(2);
      const second = JSON.parse(ws.sentMessages[1]!);
      expect(second.type).toBe('registerAck');
      expect(second.concurrency).toBe(5);
      // No rejection, socket stays open and owns the id.
      expect(ws.closeCode).toBeUndefined();
      expect(context.workerSockets.get('w-refresh') as unknown).toBe(ws);
      // Manifest normalization sorts activity keys alphabetically for
      // deterministic digests, so the derived order is alphabetical.
      expect(context.registry.getWorker('w-refresh')?.activities).toEqual([
        'test.doMore',
        'test.doWork',
      ]);
      expect(context.registry.getWorker('w-refresh')?.concurrency).toBe(5);
    });

    it('allows reconnect within the grace period for the same workerId (clears pendingWorkerRequeues entry)', async () => {
      // A worker that disconnects and reconnects before its grace-period timer fires
      // must still be accepted: the pending-requeue entry sets isGracePeriodReconnect,
      // which bypasses the duplicate-active rejection.
      const context = minimalServerContext();
      const options = minimalServeOptions();

      // Faithfully model the real close-handler state: the OLD socket is still in
      // `workerSockets` (it is not removed until the grace timer fires or the new
      // socket overwrites it), AND a pending requeue entry exists. With a stale
      // entry present, the duplicate-active guard's `existingSocket !== ws` branch
      // is true — so the ONLY thing letting this registration through is the
      // `isGracePeriodReconnect` bypass. (Without the stale entry the test would
      // still pass even if the bypass were removed, so it would not pin it.)
      const staleSocket = createFakeWs();
      context.workerSockets.set('w-reconnect', staleSocket as never);
      const timerHandle = setTimeout(() => {}, 60_000);
      context.pendingWorkerRequeues.set('w-reconnect', timerHandle);

      // Reconnecting socket registers under the same workerId.
      const ws = createFakeWs();
      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        registerMessageJson('w-reconnect', ['doWork'], { concurrency: 4 }),
        NOOP_CLEANUP,
      );
      await waitForRegistrationSideEffect(() => ws.sentMessages.length > 0);

      // Must succeed: registerAck sent (not a registerError), timer cleared, and
      // the fresh socket has overwritten the stale entry in the map.
      expect(ws.sentMessages).toHaveLength(1);
      expect(JSON.parse(ws.sentMessages[0]!).type).toBe('registerAck');
      expect(ws.closeCode).toBeUndefined();
      expect(context.pendingWorkerRequeues.has('w-reconnect')).toBe(false);
      expect(context.workerSockets.get('w-reconnect') as unknown).toBe(ws);

      clearTimeout(timerHandle);
    });

    it('keeps the registry and workerSockets map in agreement after a successful registration', async () => {
      // The duplicate-active guard reads `workerSockets` as the liveness source;
      // the close handler's stale-socket guard relies on the same map agreeing
      // with the registry. Pin that both are populated together on a successful
      // register so a future change cannot let them diverge (which would either
      // bypass the guard or falsely reject a fresh worker).
      const context = minimalServerContext();
      const options = minimalServeOptions();

      const ws = createFakeWs();
      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        registerMessageJson('w-sync', ['doWork'], { concurrency: 2 }),
        NOOP_CLEANUP,
      );
      await waitForRegistrationSideEffect(() => ws.sentMessages.length > 0);

      expect(JSON.parse(ws.sentMessages[0]!).type).toBe('registerAck');
      expect(context.workerSockets.has('w-sync')).toBe(true);
      expect(context.registry.getWorker('w-sync')).toBeDefined();
      expect(context.workerSockets.get('w-sync') as unknown).toBe(ws);
    });
  });
});
