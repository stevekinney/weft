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
 * import { activity, Context, type ContextOperationRequest } from 'weft';
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
      callerStack?: string;
    }
  | {
      type: 'memo';
      operationId: string;
      key: string;
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
