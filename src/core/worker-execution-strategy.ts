/** Worker-based execution strategy that runs workflows in Web Workers.
 * @module core/worker-execution-strategy */

import type { WorkerPool } from '../workers/pool.ts';
import type { ExecutionStrategy } from './execution-strategy.ts';
import type { OperationOutcome, WorkerInboundMessage, WorkerOutboundMessage } from './types.ts';
import { WorkerCheckpointResumeState } from './worker-checkpoint-resume-state.ts';

interface WorkerListeners {
  message: (event: MessageEvent<WorkerOutboundMessage>) => void;
  error: (event: ErrorEvent) => void;
}

export class WorkerExecutionStrategy implements ExecutionStrategy {
  readonly #pool: WorkerPool;
  readonly #workersByWorkflowId: Map<string, Worker>;
  readonly #parkedWorkersByWorkflowId: Map<string, Worker>;
  readonly #activeWorkflowIdByWorker: Map<Worker, string>;
  readonly #workerListeners: Map<Worker, WorkerListeners>;
  readonly #broadcastChannel: BroadcastChannel | null;
  readonly #broadcastListener: ((event: MessageEvent) => void) | null;
  readonly #checkpointResumeState: WorkerCheckpointResumeState;
  readonly #cancelledWorkflowIds: Set<string>;
  #messageHandler: ((message: WorkerOutboundMessage) => void | Promise<void>) | null;
  #disposed: boolean;

  constructor(pool: WorkerPool, options?: { broadcastEvents?: boolean }) {
    this.#pool = pool;
    this.#workersByWorkflowId = new Map();
    this.#parkedWorkersByWorkflowId = new Map();
    this.#activeWorkflowIdByWorker = new Map();
    this.#workerListeners = new Map();
    this.#checkpointResumeState = new WorkerCheckpointResumeState();
    this.#cancelledWorkflowIds = new Set();
    this.#messageHandler = null;
    this.#broadcastChannel = null;
    this.#broadcastListener = null;
    this.#disposed = false;

    if (options?.broadcastEvents) {
      try {
        this.#broadcastChannel = new BroadcastChannel('weft:events');
        this.#broadcastListener = (event: MessageEvent) => {
          this.#handleBroadcastMessage(event.data as Record<string, unknown>);
        };
        this.#broadcastChannel.addEventListener('message', this.#broadcastListener);
      } catch {
        // BroadcastChannel may not be available in all environments
      }
    }
  }

  onMessage(handler: (message: WorkerOutboundMessage) => void | Promise<void>): void {
    this.#messageHandler = handler;
  }

  startWorkflow(parameters: {
    workflowId: string;
    workflowType: string;
    input: unknown;
    checkpoint: ArrayBuffer;
    nestingDepth?: number;
    executionStateOwnerId?: string;
    startedAt?: number;
    sleepReferenceTime?: number;
    deadline?: number;
    headers?: [string, string][];
  }): void {
    this.#cancelledWorkflowIds.delete(parameters.workflowId);
    this.#checkpointResumeState.resetWorkflow(parameters.workflowId);

    const message: WorkerInboundMessage & { type: 'run' } = {
      type: 'run',
      workflowId: parameters.workflowId,
      workflowType: parameters.workflowType,
      checkpoint: parameters.checkpoint,
      input: parameters.input,
      executionStateOwnerId: parameters.executionStateOwnerId ?? parameters.workflowId,
    };
    if (parameters.deadline !== undefined) {
      message.deadline = parameters.deadline;
    }
    if (parameters.headers) {
      message.headers = parameters.headers;
    }
    void this.#acquireAndSend(parameters.workflowId, message);
  }

  resumeWorkflow(parameters: {
    workflowId: string;
    checkpoint: ArrayBuffer;
    operationResult: OperationOutcome;
  }): void {
    const worker = this.#workersByWorkflowId.get(parameters.workflowId);
    if (worker) {
      this.#checkpointResumeState.recordResume(parameters.workflowId);
      this.#postResumeMessage(worker, parameters);
      return;
    }

    const parkedWorker = this.#parkedWorkersByWorkflowId.get(parameters.workflowId);
    if (parkedWorker) {
      void this.#resumeParkedWorkflow(parameters, parkedWorker);
      return;
    }

    if (this.#cancelledWorkflowIds.delete(parameters.workflowId)) {
      return;
    }

    if (!this.#disposed) {
      this.#emit({
        type: 'failed',
        workflowId: parameters.workflowId,
        error: `No worker assigned for workflow: ${parameters.workflowId}`,
      });
    }
  }

  #postResumeMessage(
    worker: Worker,
    parameters: {
      workflowId: string;
      checkpoint: ArrayBuffer;
      operationResult: OperationOutcome;
    },
  ): void {
    const message: WorkerInboundMessage = {
      type: 'resume',
      workflowId: parameters.workflowId,
      checkpoint: parameters.checkpoint,
      operationResult: parameters.operationResult,
    };

    const transferable =
      parameters.checkpoint instanceof ArrayBuffer
        ? parameters.checkpoint
        : (parameters.checkpoint as Uint8Array).buffer;
    worker.postMessage(message, [transferable]);
  }

  cancelWorkflow(workflowId: string): void {
    const worker = this.#workersByWorkflowId.get(workflowId);
    if (worker) {
      this.#cancelledWorkflowIds.add(workflowId);
      const message: WorkerInboundMessage = {
        type: 'cancel',
        workflowId,
      };

      worker.postMessage(message);
      this.#releaseActiveWorker(workflowId);
      return;
    }

    const parkedWorker = this.#parkedWorkersByWorkflowId.get(workflowId);
    if (!parkedWorker) return;

    this.#cancelledWorkflowIds.add(workflowId);
    this.#parkedWorkersByWorkflowId.delete(workflowId);
    void this.#cancelParkedWorkflow(workflowId, parkedWorker);
  }

  [Symbol.dispose](): void {
    this.#teardown();
    this.#pool[Symbol.dispose]();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#teardown();
    await this.#pool[Symbol.asyncDispose]();
  }

  /** Shared cleanup for both sync and async disposal paths. */
  #teardown(): void {
    this.#disposed = true;

    if (this.#broadcastChannel) {
      if (this.#broadcastListener) {
        this.#broadcastChannel.removeEventListener('message', this.#broadcastListener);
      }
      this.#broadcastChannel.close();
    }

    // Release all active workers back to the pool before disposing
    const activeWorkflowIds = Array.from(this.#workersByWorkflowId.keys());
    for (const workflowId of activeWorkflowIds) {
      this.#releaseActiveWorker(workflowId);
    }

    this.#detachAllWorkerListeners();
    this.#parkedWorkersByWorkflowId.clear();
    this.#activeWorkflowIdByWorker.clear();
    this.#workerListeners.clear();
    this.#checkpointResumeState.clear();
    this.#cancelledWorkflowIds.clear();
    this.#messageHandler = null;
  }

  async #acquireAndSend(
    workflowId: string,
    message: WorkerInboundMessage & { type: 'run' },
  ): Promise<void> {
    try {
      const worker = await this.#pool.acquire();
      this.#workersByWorkflowId.set(workflowId, worker);
      this.#activeWorkflowIdByWorker.set(worker, workflowId);

      this.#attachWorkerListeners(worker);

      // Send the run message with checkpoint as Transferable.
      // Extract the underlying ArrayBuffer since only ArrayBuffer objects
      // are valid Transferables (not Uint8Array or other typed arrays).
      const transferable =
        message.checkpoint instanceof ArrayBuffer
          ? message.checkpoint
          : (message.checkpoint as Uint8Array).buffer;
      worker.postMessage(message, [transferable]);
    } catch (error) {
      this.#emit({
        type: 'failed',
        workflowId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #resumeParkedWorkflow(
    parameters: {
      workflowId: string;
      checkpoint: ArrayBuffer;
      operationResult: OperationOutcome;
    },
    parkedWorker: Worker,
  ): Promise<void> {
    try {
      const worker = await this.#pool.acquireSpecificWorker(parkedWorker);

      if (this.#disposed || this.#parkedWorkersByWorkflowId.get(parameters.workflowId) !== worker) {
        this.#pool.release(worker);
        return;
      }

      this.#parkedWorkersByWorkflowId.delete(parameters.workflowId);
      this.#workersByWorkflowId.set(parameters.workflowId, worker);
      this.#activeWorkflowIdByWorker.set(worker, parameters.workflowId);
      this.#attachWorkerListeners(worker);
      this.#postResumeMessage(worker, parameters);
    } catch (error) {
      if (
        this.#disposed ||
        this.#parkedWorkersByWorkflowId.get(parameters.workflowId) !== parkedWorker
      ) {
        return;
      }

      this.#parkedWorkersByWorkflowId.delete(parameters.workflowId);
      this.#emit({
        type: 'failed',
        workflowId: parameters.workflowId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #cancelParkedWorkflow(workflowId: string, parkedWorker: Worker): Promise<void> {
    try {
      const worker = await this.#pool.acquireSpecificWorker(parkedWorker);

      worker.postMessage({ type: 'cancel', workflowId } satisfies WorkerInboundMessage);
      this.#detachWorkerListenersIfIdle(worker);
      this.#pool.release(worker);
    } catch {
      // Cancellation is best-effort once the engine-side parked marker has
      // been cleared. A disposed or crashed pool must not keep the workflow
      // mapped as parked.
    }
  }

  async #handleWorkerMessage(worker: Worker, message: WorkerOutboundMessage): Promise<void> {
    const resumeVersionBeforeCheckpointHandling =
      this.#checkpointResumeState.beginCheckpointHandling(message);

    // Forward the message to the engine
    let handlerFailed = false;
    try {
      const emitResult = this.#messageHandler?.(message);
      if (emitResult instanceof Promise) {
        await emitResult;
      }
    } catch {
      handlerFailed = true;
    }

    try {
      // On terminal messages, release the worker back to the pool
      if (message.type === 'completed' || message.type === 'failed') {
        this.#cancelledWorkflowIds.delete(message.workflowId);
        this.#parkedWorkersByWorkflowId.delete(message.workflowId);
        this.#releaseActiveWorker(message.workflowId);
        this.#detachWorkerListenersIfIdle(worker);
        this.#checkpointResumeState.forgetWorkflowIfClosed(
          message.workflowId,
          this.#isWorkflowClosed(message.workflowId),
        );
        return;
      }

      if (handlerFailed) {
        return;
      }

      if (
        message.type === 'checkpoint' &&
        this.#isParkableWaitSignalCheckpoint(message) &&
        !this.#checkpointResumeState.wasResumedDuringCheckpointHandling(
          message.workflowId,
          resumeVersionBeforeCheckpointHandling,
        )
      ) {
        this.#parkActiveWorkflow(message.workflowId, worker);
      }
    } finally {
      this.#checkpointResumeState.finishCheckpointHandling(
        message.workflowId,
        resumeVersionBeforeCheckpointHandling,
        this.#isWorkflowClosed(message.workflowId),
      );
    }
  }

  #handleWorkerError(worker: Worker, errorEvent: ErrorEvent): void {
    const workflowIds = this.#workflowIdsForWorker(worker);
    if (workflowIds.length === 0) return; // Already cleaned up by a racing completion

    for (const workflowId of workflowIds) {
      this.#emit({
        type: 'failed',
        workflowId,
        error: `Worker crashed: ${errorEvent.message ?? 'unknown error'}`,
      });

      this.#workersByWorkflowId.delete(workflowId);
      this.#parkedWorkersByWorkflowId.delete(workflowId);
      this.#cancelledWorkflowIds.delete(workflowId);
    }

    this.#activeWorkflowIdByWorker.delete(worker);
    const listeners = this.#workerListeners.get(worker);
    if (listeners) {
      worker.removeEventListener('message', listeners.message as EventListener);
      worker.removeEventListener('error', listeners.error as EventListener);
      this.#workerListeners.delete(worker);
    }

    // Discard the crashed worker so the pool cannot hand the terminated
    // instance out to another workflow.
    this.#pool.discard(worker);
  }

  #releaseActiveWorker(workflowId: string): void {
    const worker = this.#workersByWorkflowId.get(workflowId);
    if (worker) {
      this.#workersByWorkflowId.delete(workflowId);
      this.#activeWorkflowIdByWorker.delete(worker);

      this.#detachWorkerListenersIfIdle(worker);

      this.#pool.release(worker);
    }
  }

  #parkActiveWorkflow(workflowId: string, worker: Worker): void {
    if (this.#workersByWorkflowId.get(workflowId) !== worker) {
      return;
    }

    this.#workersByWorkflowId.delete(workflowId);
    this.#activeWorkflowIdByWorker.delete(worker);
    this.#parkedWorkersByWorkflowId.set(workflowId, worker);
    this.#pool.release(worker);
  }

  #isWorkflowClosed(workflowId: string): boolean {
    return (
      !this.#workersByWorkflowId.has(workflowId) && !this.#parkedWorkersByWorkflowId.has(workflowId)
    );
  }

  #attachWorkerListeners(worker: Worker): void {
    if (this.#workerListeners.has(worker)) {
      return;
    }

    const listeners: WorkerListeners = {
      message: (event: MessageEvent<WorkerOutboundMessage>) => {
        void this.#handleWorkerMessage(worker, event.data).catch(() => {});
      },
      error: (errorEvent: ErrorEvent) => {
        this.#handleWorkerError(worker, errorEvent);
      },
    };

    this.#workerListeners.set(worker, listeners);
    worker.addEventListener('message', listeners.message as EventListener);
    worker.addEventListener('error', listeners.error as EventListener);
  }

  #detachWorkerListenersIfIdle(worker: Worker): void {
    if (this.#activeWorkflowIdByWorker.has(worker)) {
      return;
    }
    if (this.#workflowHasParkedWorker(worker)) {
      return;
    }

    const listeners = this.#workerListeners.get(worker);
    if (!listeners) {
      return;
    }

    worker.removeEventListener('message', listeners.message as EventListener);
    worker.removeEventListener('error', listeners.error as EventListener);
    this.#workerListeners.delete(worker);
  }

  #detachAllWorkerListeners(): void {
    for (const [worker, listeners] of this.#workerListeners) {
      worker.removeEventListener('message', listeners.message as EventListener);
      worker.removeEventListener('error', listeners.error as EventListener);
    }
  }

  #workflowHasParkedWorker(worker: Worker): boolean {
    for (const parkedWorker of this.#parkedWorkersByWorkflowId.values()) {
      if (parkedWorker === worker) {
        return true;
      }
    }
    return false;
  }

  #workflowIdsForWorker(worker: Worker): string[] {
    const workflowIds: string[] = [];
    const activeWorkflowId = this.#activeWorkflowIdByWorker.get(worker);
    if (activeWorkflowId) {
      workflowIds.push(activeWorkflowId);
    }
    for (const [workflowId, parkedWorker] of this.#parkedWorkersByWorkflowId) {
      if (parkedWorker === worker) {
        workflowIds.push(workflowId);
      }
    }
    return workflowIds;
  }

  #isParkableWaitSignalCheckpoint(
    message: Extract<WorkerOutboundMessage, { type: 'checkpoint' }>,
  ): boolean {
    const operationRequest = message.operationRequest as Record<string, unknown>;
    return operationRequest['type'] === 'wait-signal' || operationRequest['kind'] === 'signal-wait';
  }

  #handleBroadcastMessage(data: Record<string, unknown>): void {
    // Forward signal-related messages to the appropriate worker
    if (data['type'] === 'signal:received' && typeof data['workflowId'] === 'string') {
      const worker = this.#workersByWorkflowId.get(data['workflowId']);
      const targetWorker = worker ?? this.#parkedWorkersByWorkflowId.get(data['workflowId']);
      if (targetWorker) {
        targetWorker.postMessage(data);
      }
    }
  }

  #emit(message: WorkerOutboundMessage): void {
    const result = this.#messageHandler?.(message);
    if (result instanceof Promise) {
      // Worker strategy callers do not await handler turns, so observe
      // rejections here to prevent unhandled rejection noise.
      void result.catch(() => {});
    }
  }
}
