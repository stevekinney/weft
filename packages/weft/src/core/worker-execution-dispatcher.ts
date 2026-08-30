import type { WorkerPool } from '../workers/pool.ts';
import type { OperationOutcome, WorkerInboundMessage, WorkerOutboundMessage } from './types.ts';
import { WorkerExecutionOwnership } from './worker-execution-ownership.ts';
import { WORKER_PROTOCOL_VERSION } from './worker-protocol.ts';

export interface WorkerExecutionDispatcherDependencies {
  pool: WorkerPool;
  ownership: WorkerExecutionOwnership;
  isDisposed: () => boolean;
  requireProtocolVersion: () => boolean;
  validateHostToWorkerMessage: (
    workflowId: string,
    message: WorkerInboundMessage,
    worker?: Worker,
  ) => boolean;
  attachWorkerListeners: (worker: Worker) => void;
  detachWorkerListenersIfIdle: (worker: Worker) => void;
  /**
   * Resolve once `worker`'s realm-ready handshake has settled (or
   * immediately, if realm-readiness isn't required). `false` means the
   * handshake failed or timed out; the implementation is responsible for
   * discarding the worker and emitting the workflow failure itself, the same
   * contract `validateHostToWorkerMessage` already uses.
   */
  ensureRealmReady: (worker: Worker, workflowId: string) => Promise<boolean>;
  beginTurn: (worker: Worker, workflowId: string, turnId: number, kind: 'run' | 'resume') => void;
  clearTurn: (worker: Worker) => void;
  discardWorkerAndFailWorkflows: (
    worker: Worker,
    options: {
      targetWorkflowId?: string;
      targetCategory?: 'application' | 'timeout' | 'cancellation' | 'resource' | 'system';
      targetError?: string;
      skipTarget?: boolean;
      otherCategory: 'application' | 'timeout' | 'cancellation' | 'resource' | 'system';
      otherError: string;
    },
  ) => void;
  emit: (message: WorkerOutboundMessage) => void;
}

export interface WorkerResumeParameters {
  workflowId: string;
  checkpoint: ArrayBuffer;
  operationResult: OperationOutcome;
}

export class WorkerExecutionDispatcher {
  readonly #dependencies: WorkerExecutionDispatcherDependencies;

  constructor(dependencies: WorkerExecutionDispatcherDependencies) {
    this.#dependencies = dependencies;
  }

  async acquireAndSend(
    workflowId: string,
    message: WorkerInboundMessage & { type: 'run' },
  ): Promise<void> {
    try {
      const worker = await this.#dependencies.pool.acquire();
      this.#dependencies.ownership.setActive(workflowId, worker);
      this.#dependencies.attachWorkerListeners(worker);

      const ready = await this.#dependencies.ensureRealmReady(worker, workflowId);
      if (!ready) return;

      // The realm-ready wait can span the worker's full boot time, during
      // which `cancelWorkflow` may have released this worker back to the
      // pool (or the strategy may have been disposed) — re-check ownership
      // before sending so a cancelled workflow's `run` never reaches a
      // worker another workflow now owns. Mirrors `resumeParkedWorkflow`'s
      // post-await re-check for the identical reason.
      if (
        this.#dependencies.isDisposed() ||
        this.#dependencies.ownership.getActiveWorker(workflowId) !== worker
      ) {
        return;
      }

      this.#sendActiveMessage(worker, workflowId, message, 'run');
    } catch (error) {
      this.#dependencies.emit({
        type: 'failed',
        workflowId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  postResumeMessage(
    worker: Worker,
    parameters: WorkerResumeParameters,
    message: WorkerInboundMessage & { type: 'resume' },
  ): void {
    this.#sendActiveMessage(worker, parameters.workflowId, message, 'resume');
  }

  async resumeParkedWorkflow(
    parameters: WorkerResumeParameters,
    parkedWorker: Worker,
    message: WorkerInboundMessage & { type: 'resume' },
  ): Promise<void> {
    try {
      const worker = await this.#dependencies.pool.acquireSpecificWorker(parkedWorker);
      if (
        this.#dependencies.isDisposed() ||
        !this.#dependencies.ownership.activateParked(parameters.workflowId, worker)
      ) {
        this.#dependencies.pool.release(worker);
        return;
      }
      this.#dependencies.attachWorkerListeners(worker);
      this.postResumeMessage(worker, parameters, message);
    } catch (error) {
      if (
        this.#dependencies.isDisposed() ||
        this.#dependencies.ownership.getParkedWorker(parameters.workflowId) !== parkedWorker
      ) {
        return;
      }
      this.#dependencies.ownership.deleteParked(parameters.workflowId);
      this.#dependencies.emit({
        type: 'failed',
        workflowId: parameters.workflowId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async cancelParkedWorkflow(workflowId: string, parkedWorker: Worker): Promise<void> {
    try {
      const worker = await this.#dependencies.pool.acquireSpecificWorker(parkedWorker);
      const message: WorkerInboundMessage = { type: 'cancel', workflowId };
      if (this.#dependencies.requireProtocolVersion()) {
        message.protocolVersion = WORKER_PROTOCOL_VERSION;
      }
      worker.postMessage(message);
      this.#dependencies.detachWorkerListenersIfIdle(worker);
      this.#dependencies.pool.release(worker);
    } catch {
      // The engine-side parked marker was already cleared; disposal or discard
      // must not leave the workflow mapped as parked.
    }
  }

  #sendActiveMessage(
    worker: Worker,
    workflowId: string,
    message: WorkerInboundMessage & { type: 'run' | 'resume' },
    kind: 'run' | 'resume',
  ): void {
    if (!this.#dependencies.validateHostToWorkerMessage(workflowId, message, worker)) {
      return;
    }
    try {
      this.#dependencies.beginTurn(worker, workflowId, message.turnId ?? 0, kind);
      worker.postMessage(message, [transferableCheckpointBuffer(message.checkpoint)]);
    } catch (error) {
      this.#handlePostMessageFailure(worker, workflowId, error, kind);
    }
  }

  #handlePostMessageFailure(
    worker: Worker,
    workflowId: string,
    error: unknown,
    kind: 'run' | 'resume',
  ): void {
    this.#dependencies.clearTurn(worker);
    if (kind === 'resume') {
      this.#dependencies.discardWorkerAndFailWorkflows(worker, {
        targetWorkflowId: workflowId,
        targetCategory: 'system',
        targetError: error instanceof Error ? error.message : String(error),
        otherCategory: 'system',
        otherError: 'Worker was discarded after resume postMessage failed',
      });
      return;
    }

    this.#dependencies.ownership.forgetWorkflow(workflowId);
    this.#dependencies.detachWorkerListenersIfIdle(worker);
    this.#dependencies.pool.release(worker);
    this.#dependencies.emit({
      type: 'failed',
      workflowId,
      error: error instanceof Error ? error.message : String(error),
      failureCategory: 'system',
    });
  }
}

function transferableCheckpointBuffer(checkpoint: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (checkpoint instanceof ArrayBuffer) return checkpoint;
  if (checkpoint.buffer instanceof ArrayBuffer) return checkpoint.buffer;
  throw new Error('Worker checkpoint must use an ArrayBuffer-backed view');
}
