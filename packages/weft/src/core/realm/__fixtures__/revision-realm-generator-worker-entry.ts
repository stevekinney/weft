/// <reference lib="webworker" />
/**
 * Test-only revision realm bootstrap that steps REAL workflow generators
 * (COR-249's engine integration, R2E).
 *
 * Unlike `revision-realm-worker-entry.ts` (R2's fixture, which never runs a
 * real generator — a turn only completes when a test posts an explicit
 * `test-release`/`test-fail` control message), this bootstrap reuses the
 * exact same transport-agnostic generator-stepping helpers the PRODUCTION
 * generic Worker bootstrap (`src/workers/workflow-worker-entry.ts`) uses —
 * `handleRunMessage`/`handleResumeMessage`/`createWorkflowRunnerContext`
 * from `src/workers/workflow-runner.ts`. Nothing about checkpoint replay,
 * operation-result application, or generator lifecycle is reimplemented
 * here: this file only translates between the realm's `realm-run` /
 * `realm-result` / `realm-failure` wire envelope and the `WorkerInboundMessage`
 * / `WorkerOutboundMessage` shapes those helpers already speak, which is
 * exactly what `RevisionRealmExecutionStrategy` (the host side) already
 * builds via `buildRunMessage`/`buildResumeMessage`.
 *
 * A concrete revision's own worker entry file imports {@link
 * initializeRevisionRealmWorker} with its own small map of workflow type
 * name to handler function, matching a real production bootstrap deriving
 * its identity "from its own build" rather than a runtime message (ADR
 * 0004's `#spawnWorker` doc) — see the sibling `*.fixture.ts` files under
 * this directory for one revision each.
 *
 * @module core/realm/__fixtures__/revision-realm-generator-worker-entry
 */

import { buildInternalRealmManifest } from '../../../worker/manifest/internal-realm.ts';
import {
  createWorkflowRunnerContext,
  handleResumeMessage,
  handleRunMessage,
  type WorkerWorkflowContext,
} from '../../../workers/workflow-runner.ts';
import type { WorkerInboundMessage, WorkerOutboundMessage } from '../../types/checkpoint.ts';
import type { WorkerRealmReadyMessage } from '../../worker-realm-readiness.ts';
import type {
  RealmFailureMessage,
  RealmResultMessage,
  RealmRunMessage,
} from '../worker-realm-messages.ts';

export type RevisionRealmWorkflowHandler = (
  ctx: WorkerWorkflowContext,
  input: unknown,
) => AsyncGenerator;

interface RealmConfigureMessage {
  readonly type: 'realm-configure';
  readonly artifactDigest?: string;
}

function isRealmConfigureMessage(message: unknown): message is RealmConfigureMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'realm-configure'
  );
}

function isRealmRunMessage(message: unknown): message is RealmRunMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'realm-run'
  );
}

/**
 * Wire up this Worker's message loop to step real generators for
 * `workflows` (type name -> handler). Sends its `ready` handshake only
 * after the first `realm-configure` message, matching {@link
 * import('../worker-realm.ts').WorkerRealm}'s own send order.
 */
export function initializeRevisionRealmWorker(
  workflows: Readonly<Record<string, RevisionRealmWorkflowHandler>>,
): void {
  const runnerContext = createWorkflowRunnerContext();
  const getWorkflowHandler = (type: string): RevisionRealmWorkflowHandler | undefined =>
    workflows[type];

  self.onmessage = (event: MessageEvent) => {
    const message: unknown = event.data;

    if (isRealmConfigureMessage(message)) {
      sendReady(Object.keys(workflows), message.artifactDigest);
      return;
    }

    if (isRealmRunMessage(message)) {
      void handleRealmRun(runnerContext, getWorkflowHandler, message);
    }
  };
}

function sendReady(workflowTypes: readonly string[], artifactDigest: string | undefined): void {
  const manifest = buildInternalRealmManifest(workflowTypes);
  const ready: WorkerRealmReadyMessage = {
    type: 'ready',
    protocolVersion: manifest.protocolVersion,
    realmGeneration: crypto.randomUUID(),
    manifest:
      artifactDigest === undefined
        ? manifest
        : {
            ...manifest,
            deployment: { ...manifest.deployment, buildId: artifactDigest, artifactDigest },
          },
  };
  self.postMessage(ready);
}

async function handleRealmRun(
  runnerContext: ReturnType<typeof createWorkflowRunnerContext>,
  getWorkflowHandler: (type: string) => RevisionRealmWorkflowHandler | undefined,
  message: RealmRunMessage,
): Promise<void> {
  try {
    const outbound = await stepTurn(runnerContext, getWorkflowHandler, message.input);
    const result: RealmResultMessage = {
      type: 'realm-result',
      envelope: message.envelope,
      result: outbound,
    };
    self.postMessage(result);
  } catch (error) {
    const failure: RealmFailureMessage = {
      type: 'realm-failure',
      envelope: message.envelope,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(failure);
  }
}

function stepTurn(
  runnerContext: ReturnType<typeof createWorkflowRunnerContext>,
  getWorkflowHandler: (type: string) => RevisionRealmWorkflowHandler | undefined,
  rawInput: unknown,
): Promise<WorkerOutboundMessage> {
  const input = rawInput as WorkerInboundMessage;
  if (input.type === 'run') {
    return handleRunMessage(runnerContext, input, getWorkflowHandler);
  }
  if (input.type === 'resume') {
    const resultValue =
      input.operationResult.status === 'completed' ? input.operationResult.value : undefined;
    return handleResumeMessage(runnerContext, {
      workflowId: input.workflowId,
      result: resultValue,
      operationResult: input.operationResult,
    });
  }
  throw new Error(`Revision realm worker received an unsupported turn input type: ${input.type}`);
}
