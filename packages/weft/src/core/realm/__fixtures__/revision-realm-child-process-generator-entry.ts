/**
 * Test-only child-process revision realm bootstrap that steps REAL workflow
 * generators (COR-246's engine integration).
 *
 * The `Bun.spawn` IPC counterpart of `revision-realm-generator-worker-entry.ts`
 * — reuses the exact same transport-agnostic generator-stepping helpers
 * (`handleRunMessage`/`handleResumeMessage`/`createWorkflowRunnerContext`
 * from `src/workers/workflow-runner.ts`) and the identical
 * `RevisionRealmWorkflowHandler` shape, so one handler factory (for example
 * `order-workflow-handler.fixture.ts`'s `createOrderWorkflowHandler`) works
 * unchanged against either transport's engine-level test fixtures. Nothing
 * about checkpoint replay, operation-result application, or generator
 * lifecycle is reimplemented here: this file only translates between the
 * realm's `realm-run` / `realm-result` / `realm-failure` wire envelope and
 * the `WorkerInboundMessage` / `WorkerOutboundMessage` shapes those helpers
 * already speak, exactly like its Worker-side sibling — just over
 * `process.send` / `process.on('message')` instead of `postMessage`.
 *
 * @module core/realm/__fixtures__/revision-realm-child-process-generator-entry
 */

import { buildInternalRealmManifest } from '../../../worker/manifest/internal-realm.ts';
import {
  createWorkflowRunnerContext,
  handleResumeMessage,
  handleRunMessage,
} from '../../../workers/workflow-runner.ts';
import type { WorkerInboundMessage, WorkerOutboundMessage } from '../../types/checkpoint.ts';
import type { WorkerRealmReadyMessage } from '../../worker-realm-readiness.ts';
import type {
  RealmFailureMessage,
  RealmResultMessage,
  RealmRunMessage,
} from '../worker-realm-messages.ts';
import type { RevisionRealmWorkflowHandler } from './revision-realm-generator-worker-entry.ts';

export type { RevisionRealmWorkflowHandler };

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
 * Wire up this child process's IPC message loop to step real generators for
 * `workflows` (type name -> handler). Sends its `ready` handshake only
 * after the first `realm-configure` message, matching {@link
 * import('../child-process-realm.ts').ChildProcessRealm}'s own send order.
 */
export function initializeRevisionRealmChildProcess(
  workflows: Readonly<Record<string, RevisionRealmWorkflowHandler>>,
): void {
  const runnerContext = createWorkflowRunnerContext();
  const getWorkflowHandler = (type: string): RevisionRealmWorkflowHandler | undefined =>
    workflows[type];

  process.on('message', (message: unknown) => {
    if (isRealmConfigureMessage(message)) {
      sendReady(Object.keys(workflows), message.artifactDigest);
      return;
    }

    if (isRealmRunMessage(message)) {
      void handleRealmRun(runnerContext, getWorkflowHandler, message);
    }
  });

  process.on('disconnect', () => {
    process.exit(0);
  });
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
  process.send?.(ready);
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
    process.send?.(result);
  } catch (error) {
    const failure: RealmFailureMessage = {
      type: 'realm-failure',
      envelope: message.envelope,
      error: error instanceof Error ? error.message : String(error),
    };
    process.send?.(failure);
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
  throw new Error(
    `Revision realm child process received an unsupported turn input type: ${input.type}`,
  );
}
