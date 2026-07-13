import type { AtomicStateScope } from '../atomic-state.ts';
import type { HumanReviewOptions } from '../review/index.ts';
import type { ChildWorkflowOptions } from '../types.ts';
import type { Context } from './index.ts';
import type { OffloadReference, StreamSink } from './types.ts';

/**
 * Discriminated union of all operation descriptors that a workflow generator
 * can yield to the engine. Each variant corresponds to one durable operation.
 *
 * @example
 * ```ts
 * import { activity, Context, type ContextOperationRequest } from '@lostgradient/weft';
 *
 * const ping = activity({ name: 'ping', execute: async (input: unknown) => input });
 * const ctx = new Context({
 *   workflowId: 'wf-demo',
 *   workflowType: 'demo',
 *   startedAt: Date.now(),
 *   abortController: new AbortController(),
 * });
 * const generator = ctx.run(ping, 'hello');
 * const first = generator.next();
 * const request: ContextOperationRequest | undefined = first.done ? undefined : first.value;
 * void request;
 * ```
 */
export type ContextOperationRequest =
  | {
      type: 'activity';
      operationId: string;
      activityName: string;
      fn?: (input: unknown, context?: unknown) => unknown;
      input: unknown;
      /** Immutable owner token for this workflow run, used to fence external side effects. */
      workflowExecutionToken?: string;
      callerStack?: string;
      options?: Record<string, unknown>;
      /** Dispatch attempt used for worker payloads, interceptors, and reconciliation verifiers. */
      attempt?: number;
      /**
       * Deterministic workflow step index for this activity call. Stable across
       * replay (unlike `operationId`, which is regenerated each yield), so it
       * anchors the durable async-completion task token to a fixed activity.
       */
      step?: number;
      /**
       * Optional deterministic state key for activity sub-operations that are
       * owned by another workflow step. Plain `ctx.run()` leaves this unset and
       * uses `step`; memo-scoped helper activities set it to a key derived from
       * the owning memo step, memo key, and helper-call ordinal so retry and
       * heartbeat state cannot collide with the parent memo step.
       */
      activityStateKey?: string;
      /** Serialized interceptor headers (Map entries) for remote worker propagation. */
      headers?: [string, string][];
    }
  | {
      type: 'sleep';
      operationId: string;
      duration: number;
      scheduledFireAt: number;
      callerStack?: string;
    }
  | {
      type: 'wait-signal';
      operationId: string;
      signalName: string;
      callerStack?: string;
    }
  | {
      type: 'wait-update';
      operationId: string;
      updateName: string;
      callerStack?: string;
    }
  | {
      type: 'wait-condition';
      operationId: string;
      /**
       * Deterministic workflow step index for this `ctx.waitUntil` call. Stable
       * across replay (unlike `operationId`, which is regenerated each yield), so
       * it anchors both the deterministic deadline timer key
       * (`cond:${workflowId}:${step}`) and the in-process condition waiter to a
       * fixed step. Re-using a regenerated `operationId` would arm duplicate
       * durable timers on recovery.
       */
      step: number;
      /**
       * The condition predicate. A non-serializable closure (like `memo.fn`) held
       * in-process by the engine processor and re-evaluated on every wake; it is
       * never checkpointed. The workflow re-yields a fresh request after each
       * replay, so the engine always has a live closure to call. Must be pure and
       * read only checkpoint-restored workflow-local state.
       */
      predicate: () => boolean;
      /**
       * Absolute deadline (epoch millis) after which the wait completes with
       * `false`. Anchored once via `readOrInitConditionDeadline` so crash/replay
       * never resets the window. Absent means "wait forever".
       */
      deadline?: number;
      callerStack?: string;
    }
  | {
      type: 'get-version';
      operationId: string;
      changeId: string;
      minSupported: number;
      maxSupported: number;
      version: number;
      callerStack?: string;
    }
  | {
      type: 'parallel';
      operationId: string;
      operations: ContextOperationRequest[];
      /**
       * Workflow step index where this parallel op lives. The engine
       * writes the partial cache entry to `context.accumulatedResults[step]`
       * after settlement so on retry the workflow generator can reuse
       * fulfilled branches.
       */
      step: number;
      /**
       * Resumed parallel-operation cache entry from a prior attempt. Engine
       * uses this to skip dispatch for fulfilled branch slots and re-dispatch
       * the rest. Typed as `unknown` here to avoid a circular import with
       * `./parallel-operations.ts` where the entry shape is defined; the
       * engine validates the shape via `isParallelOperationCacheEntry`.
       */
      resumedCacheEntry?: unknown;
      callerStack?: string;
    }
  | {
      type: 'race';
      operationId: string;
      operations: ContextOperationRequest[];
      /** Ordered branch names for `ctx.raceKeyed`; absent for positional `ctx.race`. */
      branchNames?: string[];
      callerStack?: string;
    }
  | {
      type: 'memo';
      operationId: string;
      key: string;
      /**
       * Workflow step index for the owning `ctx.memo()` call. Plain async
       * helper activity calls derive sub-operation identity from this parent
       * step, the memo key, and their call ordinal without consuming the
       * workflow's outer step index.
       */
      step?: number;
      fn: () => unknown;
      callerStack?: string;
    }
  | {
      type: 'child-workflow';
      operationId: string;
      workflowType: string;
      input: unknown;
      callerStack?: string;
      options?: ChildWorkflowOptions;
    }
  | {
      type: 'offload';
      operationId: string;
      key: string;
      fn: () => Promise<unknown>;
      callerStack?: string;
    }
  | {
      type: 'load';
      operationId: string;
      reference: OffloadReference;
      callerStack?: string;
    }
  | {
      type: 'archive';
      operationId: string;
      key: string;
      data: unknown;
      callerStack?: string;
    }
  | {
      type: 'state-read';
      operationId: string;
      scope: AtomicStateScope;
      key: string;
      initial?: unknown;
      callerStack?: string;
    }
  | {
      type: 'state-commit';
      operationId: string;
      scope: AtomicStateScope;
      key: string;
      expectedVersion: number;
      mode: 'set' | 'delete';
      value?: unknown;
      callerStack?: string;
    }
  | {
      type: 'run-all';
      operationId: string;
      branches: Record<string, readonly [Function] | readonly [Function, unknown]>;
      /** Workflow step index — see note on `parallel.step`. */
      step: number;
      /**
       * Resumed run-all cache entry from a prior attempt. See note on
       * `parallel.resumedCacheEntry` for why this is typed as `unknown`.
       */
      resumedCacheEntry?: unknown;
      callerStack?: string;
    }
  | {
      type: 'speculate';
      operationId: string;
      execute: (
        context: Context,
      ) =>
        | Generator<ContextOperationRequest, unknown, unknown>
        | AsyncGenerator<unknown, unknown, unknown>;
      callerStack?: string;
    }
  | {
      type: 'stream';
      operationId: string;
      key: string;
      fn: (sink: StreamSink) => AsyncGenerator<unknown, void, unknown>;
      callerStack?: string;
    }
  | {
      type: 'wait-review';
      operationId: string;
      reviewOptions: HumanReviewOptions;
      callerStack?: string;
    };
