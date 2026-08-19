import type { WorkerPool } from '../workers/pool.ts';
import type { FailureCategory, WorkerInboundMessage, WorkerOutboundMessage } from './types.ts';
import type { WorkerCheckpointResumeState } from './worker-checkpoint-resume-state.ts';
import type { WorkerExecutionOwnership } from './worker-execution-ownership.ts';
import type { WorkerListenerRegistry } from './worker-listener-registry.ts';
import type { ForwardedLogGate } from './worker-log-abuse-counter.ts';
import type { WorkerProtocolGuard } from './worker-protocol-guard.ts';
import type { WorkerRealmReadiness } from './worker-realm-readiness.ts';
import type { WorkerTurnState, WorkerTurnWatchdog } from './worker-turn-watchdog.ts';

export interface WorkerFaultHandlerDependencies {
  ownership: WorkerExecutionOwnership;
  checkpointResumeState: WorkerCheckpointResumeState;
  turnWatchdog: WorkerTurnWatchdog;
  forwardedLogGate: ForwardedLogGate;
  realmReadiness: WorkerRealmReadiness | null;
  workerListeners: WorkerListenerRegistry;
  protocolGuard: WorkerProtocolGuard;
  pool: WorkerPool;
  emit: (message: WorkerOutboundMessage) => void;
}

export interface WorkerDiscardOptions {
  targetWorkflowId?: string;
  targetCategory?: FailureCategory;
  targetError?: string;
  skipTarget?: boolean;
  otherCategory: FailureCategory;
  otherError: string;
}

/**
 * Owns every path that ends in a worker being discarded and its owned
 * workflows failed: protocol violations, turn timeouts, worker crashes, and
 * (WFT-28) realm-ready handshake failures. Extracted from
 * {@link WorkerExecutionStrategy} to keep that file under the repository's
 * file-size ceiling; every method here previously lived as a private method
 * on that class and is unchanged in behavior.
 */
export class WorkerFaultHandler {
  readonly #dependencies: WorkerFaultHandlerDependencies;

  constructor(dependencies: WorkerFaultHandlerDependencies) {
    this.#dependencies = dependencies;
  }

  assertHostToWorkerMessageWithinLimit(
    workflowId: string,
    message: WorkerInboundMessage,
    worker?: Worker,
  ): boolean {
    const failure = this.#dependencies.protocolGuard.validateHostToWorkerMessage(message);
    if (!failure) return true;
    if (worker) {
      this.discardWorkerAndFailWorkflows(worker, {
        targetWorkflowId: workflowId,
        targetCategory: failure.failureCategory,
        targetError: failure.error,
        otherCategory: 'system',
        otherError: `Worker discarded after protocol send failure for workflow: ${workflowId}`,
      });
      return false;
    }

    this.#dependencies.emit({
      type: 'failed',
      workflowId,
      error: failure.error,
      failureCategory: failure.failureCategory,
    });
    return false;
  }

  acceptWorkerMessage(worker: Worker, message: unknown): message is WorkerOutboundMessage {
    const result = this.#dependencies.protocolGuard.acceptWorkerMessage(worker, message);
    if (result.accepted) return true;
    this.discardWorkerAndFailWorkflows(worker, {
      ...(result.failure.targetWorkflowId === undefined
        ? {}
        : { targetWorkflowId: result.failure.targetWorkflowId }),
      targetCategory: result.failure.failureCategory,
      targetError: result.failure.error,
      otherCategory: 'system',
      otherError: result.failure.otherError,
    });
    return false;
  }

  handleTurnTimeout(turn: WorkerTurnState): void {
    this.discardWorkerAndFailWorkflows(turn.worker, {
      targetWorkflowId: turn.workflowId,
      targetCategory: 'timeout',
      targetError: `Worker workflow turn timed out after ${turn.timeoutMs}ms`,
      otherCategory: 'timeout',
      otherError: `Worker discarded after workflow turn timed out: ${turn.workflowId}`,
    });
  }

  handleWorkerError(worker: Worker, errorEvent: ErrorEvent): void {
    this.discardWorkerAndFailWorkflows(worker, {
      targetCategory: 'system',
      targetError: `Worker crashed: ${errorEvent.message ?? 'unknown error'}`,
      otherCategory: 'system',
      otherError: `Worker crashed: ${errorEvent.message ?? 'unknown error'}`,
    });
  }

  discardWorkerAndFailWorkflows(worker: Worker, options: WorkerDiscardOptions): void {
    const { ownership } = this.#dependencies;
    const workflowIds = ownership.workflowIdsForWorker(worker);
    if (workflowIds.length === 0) {
      // Every discard trigger owns >= 1 workflow when it fires. Do not discard here:
      // a fully released worker may already be re-acquired for another workflow.
      this.#clearWorkerState(worker);
      return;
    }

    for (const workflowId of workflowIds) {
      this.#failOwnedWorkflow(workflowId, workflowId === options.targetWorkflowId, options);
    }

    this.#clearWorkerState(worker);
    this.#dependencies.workerListeners.detach(worker);
    this.#dependencies.pool.discard(worker);
  }

  #failOwnedWorkflow(workflowId: string, isTarget: boolean, options: WorkerDiscardOptions): void {
    const { ownership, checkpointResumeState } = this.#dependencies;
    ownership.forgetWorkflow(workflowId);
    checkpointResumeState.forgetWorkflowIfClosed(workflowId, true);
    if (isTarget && options.skipTarget) {
      return;
    }

    this.#dependencies.emit({
      type: 'failed',
      workflowId,
      error: isTarget ? (options.targetError ?? options.otherError) : options.otherError,
      failureCategory: isTarget
        ? (options.targetCategory ?? options.otherCategory)
        : options.otherCategory,
    });
  }

  #clearWorkerState(worker: Worker): void {
    this.#dependencies.turnWatchdog.clear(worker);
    this.#dependencies.forwardedLogGate.forget(worker);
    this.#dependencies.realmReadiness?.forget(worker);
  }
}
