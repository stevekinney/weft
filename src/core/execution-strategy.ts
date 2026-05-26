/**
 * Execution strategy interface for workflow execution.
 *
 * Defines the contract for how workflows are driven (inline on the main thread
 * or in a Web Worker). The engine delegates generator lifecycle to a strategy
 * and reacts uniformly to {@link WorkerOutboundMessage} regardless of where
 * the workflow code actually runs.
 *
 * @remarks
 * **`ExecutionStrategy` is the untrusted-workflow isolation boundary.** Workflows
 * are user-supplied code. This interface is the single seam across which the engine
 * drives that code, and the only place where "where does the workflow generator
 * step?" is decided. `InlineExecutionStrategy` steps the generator in the engine's
 * own isolate (no isolation — appropriate only for trusted workflows); the engine
 * selects it by default. `WorkerExecutionStrategy` steps the generator inside a Web
 * Worker and communicates with the engine purely through `postMessage`, so untrusted
 * workflow code never executes in the engine isolate. The engine picks the worker
 * strategy when `workerExecution` is configured, and in that mode the engine's
 * `inlineStrategy` is `null` — every code path that would step a workflow generator
 * is guarded on `inlineStrategy` and therefore unreachable.
 *
 * **Security contract the boundary upholds for untrusted code (worker strategy):**
 * - *Memory isolation (execution).* Workflow stepping and its generator
 *   locals/closures/heap live in the Worker's isolate. The engine sees only
 *   serialized checkpoint `ArrayBuffer`s crossing `postMessage`.
 * - *No engine-heap access.* Worker-side workflow code cannot reach engine objects
 *   (the registration map, checkpoints, scheduler, storage); it receives only what
 *   crosses `postMessage` — its input, the checkpoint buffer, and operation results
 *   in, checkpoint/completed/failed messages out.
 * - *Crash containment.* A thrown error inside the worker becomes a `failed`
 *   {@link WorkerOutboundMessage}; an outright worker crash is caught by the
 *   strategy's worker `error` listener, surfaced as `failed`, and the worker is
 *   discarded from the pool so it is never reused.
 *
 * **Caveat — "holds the reference, never executes it."** Even under the worker
 * strategy the engine still *holds* the workflow handler function in its
 * registration map; it simply never *invokes* it. This is execution isolation, not
 * a claim that the engine never possesses the workflow's code. How a given worker
 * obtains its copy of the workflow code is a property of how the caller built the
 * worker bundle (for example the opt-in `createWorkerEntryUrl` helper serializes
 * handlers via `Function.prototype.toString`), not of this interface.
 *
 * **Transport-agnostic.** The methods return `void` and all engine/strategy
 * coupling flows through serializable messages plus {@link ExecutionStrategy.onMessage}.
 * That shape is not Worker-specific: a future out-of-process or remote workflow
 * worker could implement the same interface. (The existing RemoteWorker WebSocket
 * protocol is activity dispatch and is not suitable for stateful workflow checkpoint
 * execution, so it is not that transport.)
 *
 * @module core/execution-strategy
 */

import type { OperationOutcome, WorkerOutboundMessage } from './types.ts';

export interface ExecutionStrategy extends Disposable, AsyncDisposable {
  /**
   * Start a new workflow execution from the beginning.
   */
  startWorkflow(parameters: {
    workflowId: string;
    workflowType: string;
    input: unknown;
    checkpoint: ArrayBuffer | Uint8Array;
    nestingDepth?: number;
    executionStateOwnerId?: string;
    startedAt?: number;
    sleepReferenceTime?: number;
    deadline?: number;
    headers?: [string, string][];
  }): void;

  /**
   * Resume a suspended workflow by feeding an operation result back into it.
   */
  resumeWorkflow(parameters: {
    workflowId: string;
    checkpoint: ArrayBuffer | Uint8Array;
    operationResult: OperationOutcome;
  }): void;

  /**
   * Cancel an in-flight workflow, aborting its generator.
   */
  cancelWorkflow(workflowId: string): void;

  /**
   * Register a handler that receives all outbound messages from the strategy.
   * The engine calls this once during setup; the handler persists for the
   * lifetime of the strategy.
   */
  onMessage(handler: (message: WorkerOutboundMessage) => void | Promise<void>): void;
}
