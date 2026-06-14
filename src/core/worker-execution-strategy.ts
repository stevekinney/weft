import type { WorkerPool } from '../workers/pool.ts';
import type { ExecutionStrategy } from './execution-strategy.ts';
import type {
  FailureCategory,
  OperationOutcome,
  WorkerInboundMessage,
  WorkerOutboundMessage,
} from './types.ts';
import type { WorkflowLogRecord } from './types/workflow-log.ts';
import { WorkerCheckpointResumeState } from './worker-checkpoint-resume-state.ts';
import { WorkerExecutionDispatcher } from './worker-execution-dispatcher.ts';
import { WorkerExecutionOwnership } from './worker-execution-ownership.ts';
import type { WorkerExecutionStrategyOptions } from './worker-execution-strategy-options.ts';
import {
  buildResumeMessage,
  buildRunMessage,
  type WorkerInboundMessageContext,
} from './worker-inbound-message.ts';
import { WorkerListenerRegistry } from './worker-listener-registry.ts';
import {
  deliverForwardedWorkerLog,
  emitWorkerMessageToEngine,
  isParkableWaitSignalCheckpoint,
} from './worker-message-helpers.ts';
import { WorkerProtocolGuard } from './worker-protocol-guard.ts';
import { isWorkerLogMessage } from './worker-protocol-log.ts';
import { WORKER_PROTOCOL_VERSION } from './worker-protocol.ts';
import { WorkerTurnWatchdog, type WorkerTurnState } from './worker-turn-watchdog.ts';

export class WorkerExecutionStrategy implements ExecutionStrategy {
  readonly #pool: WorkerPool;
  readonly #ownership: WorkerExecutionOwnership;
  readonly #workerListeners: WorkerListenerRegistry;
  readonly #broadcastChannel: BroadcastChannel | null;
  readonly #broadcastListener: ((event: MessageEvent) => void) | null;
  readonly #checkpointResumeState: WorkerCheckpointResumeState;
  readonly #workflowTurnTimeoutMs: number | undefined;
  readonly #maxProtocolMessageBytes: number | undefined;
  readonly #requireProtocolVersion: boolean;
  readonly #discardOnCancel: boolean;
  readonly #onLog: ((record: WorkflowLogRecord) => void) | undefined;
  readonly #turnWatchdog: WorkerTurnWatchdog;
  readonly #protocolGuard: WorkerProtocolGuard;
  readonly #dispatcher: WorkerExecutionDispatcher;
  #messageHandler: ((message: WorkerOutboundMessage) => void | Promise<void>) | null;
  #disposed: boolean;
  #nextTurnId: number;

  constructor(pool: WorkerPool, options?: WorkerExecutionStrategyOptions) {
    // Destructure-with-defaults once so constructor reads are plain (low complexity).
    const {
      workflowTurnTimeoutMs,
      maxProtocolMessageBytes,
      onLog,
      requireProtocolVersion = false,
      discardOnCancel = false,
      broadcastEvents = false,
    } = options ?? {};
    this.#pool = pool;
    this.#ownership = new WorkerExecutionOwnership();
    this.#workerListeners = new WorkerListenerRegistry();
    this.#checkpointResumeState = new WorkerCheckpointResumeState();
    this.#workflowTurnTimeoutMs = workflowTurnTimeoutMs;
    this.#maxProtocolMessageBytes = maxProtocolMessageBytes;
    this.#requireProtocolVersion = requireProtocolVersion;
    this.#discardOnCancel = discardOnCancel;
    this.#onLog = onLog;
    this.#turnWatchdog = new WorkerTurnWatchdog(this.#workflowTurnTimeoutMs, (turn) => {
      this.#handleTurnTimeout(turn);
    });
    this.#protocolGuard = new WorkerProtocolGuard(
      this.#maxProtocolMessageBytes,
      this.#requireProtocolVersion,
      this.#turnWatchdog,
    );
    this.#dispatcher = new WorkerExecutionDispatcher({
      pool: this.#pool,
      ownership: this.#ownership,
      isDisposed: () => this.#disposed,
      requireProtocolVersion: () => this.#requireProtocolVersion,
      validateHostToWorkerMessage: (workflowId, message, worker) =>
        this.#assertHostToWorkerMessageWithinLimit(workflowId, message, worker),
      attachWorkerListeners: (worker) => {
        this.#attachWorkerListeners(worker);
      },
      detachWorkerListenersIfIdle: (worker) => {
        this.#detachWorkerListenersIfIdle(worker);
      },
      beginTurn: (worker, workflowId, turnId, kind) => {
        this.#turnWatchdog.begin(worker, workflowId, turnId, kind);
      },
      clearTurn: (worker) => {
        this.#turnWatchdog.clear(worker);
      },
      discardWorkerAndFailWorkflows: (worker, discardOptions) => {
        this.#discardWorkerAndFailWorkflows(worker, discardOptions);
      },
      emit: (message) => {
        this.#emit(message);
      },
    });
    this.#messageHandler = null;
    this.#broadcastChannel = null;
    this.#broadcastListener = null;
    this.#disposed = false;
    this.#nextTurnId = 1;

    if (broadcastEvents) {
      try {
        this.#broadcastChannel = new BroadcastChannel('weft:events');
        this.#broadcastListener = (event: MessageEvent) => {
          this.#handleBroadcastMessage(event.data as Record<string, unknown>);
        };
        this.#broadcastChannel.addEventListener('message', this.#broadcastListener);
      } catch {}
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
    this.#ownership.resetWorkflow(parameters.workflowId);
    this.#checkpointResumeState.resetWorkflow(parameters.workflowId);

    const message = buildRunMessage(parameters, this.#inboundMessageContext());
    if (!this.#assertHostToWorkerMessageWithinLimit(parameters.workflowId, message)) {
      return;
    }
    void this.#dispatcher.acquireAndSend(parameters.workflowId, message);
  }

  resumeWorkflow(parameters: {
    workflowId: string;
    checkpoint: ArrayBuffer;
    operationResult: OperationOutcome;
  }): void {
    const worker = this.#ownership.getActiveWorker(parameters.workflowId);
    if (worker) {
      this.#checkpointResumeState.recordResume(parameters.workflowId);
      const resumeMessage = buildResumeMessage(parameters, this.#inboundMessageContext());
      this.#dispatcher.postResumeMessage(worker, parameters, resumeMessage);
      return;
    }

    const parkedWorker = this.#ownership.getParkedWorker(parameters.workflowId);
    if (parkedWorker) {
      const resumeMessage = buildResumeMessage(parameters, this.#inboundMessageContext());
      void this.#dispatcher.resumeParkedWorkflow(parameters, parkedWorker, resumeMessage);
      return;
    }

    if (this.#ownership.consumeCancelled(parameters.workflowId)) {
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

  #inboundMessageContext(): WorkerInboundMessageContext {
    return {
      turnId: this.#nextTurnId++,
      maxProtocolMessageBytes: this.#maxProtocolMessageBytes,
      hasLogSink: this.#onLog !== undefined,
    };
  }

  cancelWorkflow(workflowId: string): void {
    const worker = this.#ownership.getActiveWorker(workflowId);
    if (worker) {
      this.#ownership.markCancelled(workflowId);
      if (this.#discardOnCancel) {
        this.#discardWorkerAndFailWorkflows(worker, {
          targetWorkflowId: workflowId,
          skipTarget: true,
          otherCategory: 'system',
          otherError: `Worker discarded during cancellation of workflow: ${workflowId}`,
        });
        return;
      }
      const message: WorkerInboundMessage = {
        type: 'cancel',
        workflowId,
      };
      if (this.#requireProtocolVersion) {
        message.protocolVersion = WORKER_PROTOCOL_VERSION;
      }

      worker.postMessage(message);
      this.#releaseActiveWorker(workflowId);
      return;
    }

    const parkedWorker = this.#ownership.getParkedWorker(workflowId);
    if (!parkedWorker) return;

    this.#ownership.markCancelled(workflowId);
    this.#ownership.deleteParked(workflowId);
    if (this.#discardOnCancel) {
      this.#discardWorkerAndFailWorkflows(parkedWorker, {
        targetWorkflowId: workflowId,
        skipTarget: true,
        otherCategory: 'system',
        otherError: `Worker discarded during cancellation of parked workflow: ${workflowId}`,
      });
      return;
    }
    void this.#dispatcher.cancelParkedWorkflow(workflowId, parkedWorker);
  }

  [Symbol.dispose](): void {
    this.#teardown();
    this.#pool[Symbol.dispose]();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#teardown();
    await this.#pool[Symbol.asyncDispose]();
  }

  #teardown(): void {
    this.#disposed = true;

    if (this.#broadcastChannel) {
      if (this.#broadcastListener) {
        this.#broadcastChannel.removeEventListener('message', this.#broadcastListener);
      }
      this.#broadcastChannel.close();
    }

    this.#turnWatchdog.clearAll();

    const activeWorkflowIds = this.#ownership.activeWorkflowIds();
    for (const workflowId of activeWorkflowIds) {
      this.#releaseActiveWorker(workflowId);
    }

    this.#workerListeners.detachAll();
    this.#ownership.clear();
    this.#checkpointResumeState.clear();
    this.#messageHandler = null;
  }

  async #handleWorkerMessage(worker: Worker, message: unknown): Promise<void> {
    // A `log` is non-terminal observability: handle it BEFORE the strict accept-or-discard
    // gate (an out-of-turn log must not discard the worker) and never touch the watchdog (#529).
    // The ownership gate is the trust boundary in the hardened worker path: a worker may only
    // forward logs for a workflow it owns (active or parked), so an untrusted worker cannot
    // spoof a log as another workflow. Validity/identity/size/console-fallback live in the
    // helper; a wrong-owner log is dropped here, never discards the worker.
    if (isWorkerLogMessage(message)) {
      if (
        typeof message.workflowId === 'string' &&
        this.#ownership.getTargetWorker(message.workflowId) === worker
      ) {
        deliverForwardedWorkerLog(message, this.#onLog, this.#maxProtocolMessageBytes);
      }
      return;
    }

    if (!this.#acceptWorkerMessage(worker, message)) {
      return;
    }

    this.#turnWatchdog.clear(worker);
    const resumeVersionBeforeCheckpointHandling =
      this.#checkpointResumeState.beginCheckpointHandling(message);

    const emitResult = emitWorkerMessageToEngine(this.#messageHandler, message);
    const handlerFailed = emitResult instanceof Promise ? await emitResult : emitResult;

    try {
      if (this.#settleTerminalWorkerMessage(worker, message)) {
        return;
      }

      if (handlerFailed) {
        return;
      }

      this.#parkCheckpointIfStillWaiting(worker, message, resumeVersionBeforeCheckpointHandling);
    } finally {
      this.#checkpointResumeState.finishCheckpointHandling(
        message.workflowId,
        resumeVersionBeforeCheckpointHandling,
        this.#ownership.isWorkflowClosed(message.workflowId),
      );
    }
  }

  #settleTerminalWorkerMessage(worker: Worker, message: WorkerOutboundMessage): boolean {
    if (message.type !== 'completed' && message.type !== 'failed') {
      return false;
    }

    this.#ownership.consumeCancelled(message.workflowId);
    this.#ownership.deleteParked(message.workflowId);
    this.#releaseActiveWorker(message.workflowId);
    this.#detachWorkerListenersIfIdle(worker);
    this.#checkpointResumeState.forgetWorkflowIfClosed(
      message.workflowId,
      this.#ownership.isWorkflowClosed(message.workflowId),
    );
    return true;
  }

  #parkCheckpointIfStillWaiting(
    worker: Worker,
    message: WorkerOutboundMessage,
    resumeVersionBeforeCheckpointHandling: number | null,
  ): void {
    if (message.type !== 'checkpoint' || !isParkableWaitSignalCheckpoint(message)) {
      return;
    }
    if (
      this.#checkpointResumeState.wasResumedDuringCheckpointHandling(
        message.workflowId,
        resumeVersionBeforeCheckpointHandling,
      )
    ) {
      return;
    }
    if (this.#ownership.parkActive(message.workflowId, worker)) {
      this.#pool.release(worker);
    }
  }

  #handleWorkerError(worker: Worker, errorEvent: ErrorEvent): void {
    this.#discardWorkerAndFailWorkflows(worker, {
      targetCategory: 'system',
      targetError: `Worker crashed: ${errorEvent.message ?? 'unknown error'}`,
      otherCategory: 'system',
      otherError: `Worker crashed: ${errorEvent.message ?? 'unknown error'}`,
    });
  }

  #releaseActiveWorker(workflowId: string): void {
    const worker = this.#ownership.releaseActive(workflowId);
    if (worker) {
      this.#turnWatchdog.clear(worker);
      this.#detachWorkerListenersIfIdle(worker);

      this.#pool.release(worker);
    }
  }

  #attachWorkerListeners(worker: Worker): void {
    this.#workerListeners.attach(worker, {
      message: (message) => {
        void this.#handleWorkerMessage(worker, message).catch(() => {});
      },
      error: (errorEvent) => {
        this.#handleWorkerError(worker, errorEvent);
      },
      messageerror: () => {
        this.#discardWorkerAndFailWorkflows(worker, {
          targetCategory: 'system',
          targetError: 'Worker messageerror event',
          otherCategory: 'system',
          otherError: 'Worker messageerror event',
        });
      },
    });
  }

  #detachWorkerListenersIfIdle(worker: Worker): void {
    this.#workerListeners.detachIfIdle(worker, (candidate) =>
      this.#ownership.workerIsIdle(candidate),
    );
  }

  #assertHostToWorkerMessageWithinLimit(
    workflowId: string,
    message: WorkerInboundMessage,
    worker?: Worker,
  ): boolean {
    const failure = this.#protocolGuard.validateHostToWorkerMessage(message);
    if (!failure) return true;
    if (worker) {
      this.#discardWorkerAndFailWorkflows(worker, {
        targetWorkflowId: workflowId,
        targetCategory: failure.failureCategory,
        targetError: failure.error,
        otherCategory: 'system',
        otherError: `Worker discarded after protocol send failure for workflow: ${workflowId}`,
      });
      return false;
    }

    this.#emit({
      type: 'failed',
      workflowId,
      error: failure.error,
      failureCategory: failure.failureCategory,
    });
    return false;
  }

  #acceptWorkerMessage(worker: Worker, message: unknown): message is WorkerOutboundMessage {
    const result = this.#protocolGuard.acceptWorkerMessage(worker, message);
    if (result.accepted) return true;
    this.#discardWorkerAndFailWorkflows(worker, {
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

  #handleTurnTimeout(turn: WorkerTurnState): void {
    this.#discardWorkerAndFailWorkflows(turn.worker, {
      targetWorkflowId: turn.workflowId,
      targetCategory: 'timeout',
      targetError: `Worker workflow turn timed out after ${this.#workflowTurnTimeoutMs}ms`,
      otherCategory: 'timeout',
      otherError: `Worker discarded after workflow turn timed out: ${turn.workflowId}`,
    });
  }

  #discardWorkerAndFailWorkflows(
    worker: Worker,
    options: {
      targetWorkflowId?: string;
      targetCategory?: FailureCategory;
      targetError?: string;
      skipTarget?: boolean;
      otherCategory: FailureCategory;
      otherError: string;
    },
  ): void {
    const workflowIds = this.#ownership.workflowIdsForWorker(worker);
    if (workflowIds.length === 0) {
      this.#turnWatchdog.clear(worker);
      return;
    }

    for (const workflowId of workflowIds) {
      const isTarget = workflowId === options.targetWorkflowId;
      this.#ownership.forgetWorkflow(workflowId);
      this.#checkpointResumeState.forgetWorkflowIfClosed(workflowId, true);
      if (isTarget && options.skipTarget) {
        continue;
      }

      this.#emit({
        type: 'failed',
        workflowId,
        error: isTarget ? (options.targetError ?? options.otherError) : options.otherError,
        failureCategory: isTarget
          ? (options.targetCategory ?? options.otherCategory)
          : options.otherCategory,
      });
    }

    this.#turnWatchdog.clear(worker);
    this.#workerListeners.detach(worker);
    this.#pool.discard(worker);
  }

  #handleBroadcastMessage(data: Record<string, unknown>): void {
    if (data['type'] === 'signal:received' && typeof data['workflowId'] === 'string') {
      const targetWorker = this.#ownership.getTargetWorker(data['workflowId']);
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
