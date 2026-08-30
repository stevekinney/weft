import type {
  ActivityInterception,
  ChildWorkflowInterception,
  QueryInterception,
  SignalInterception,
  SignalReceivedInterception,
  SleepInterception,
  WorkflowStartInterception,
} from './interception-contexts.ts';
import type { ComposedWorkflowInterceptor, WorkflowInterceptor } from './interceptor-interfaces.ts';

// Composition: workflow interceptors
// ---------------------------------------------------------------------------

/**
 * Compose the `activity` hooks of all workflow interceptors into a single
 * generator chain.
 */
function composeActivityHook(
  interceptors: WorkflowInterceptor[],
): ComposedWorkflowInterceptor['activity'] {
  return function* composedActivity(
    interception: ActivityInterception,
    execute: (interception: ActivityInterception) => Generator<unknown, unknown, unknown>,
  ): Generator<unknown, unknown, unknown> {
    type Next = (ctx: ActivityInterception) => Generator<unknown, unknown, unknown>;

    let chain: Next = execute;

    for (let i = interceptors.length - 1; i >= 0; i--) {
      const interceptor = interceptors[i]!;

      if (interceptor.activity) {
        const innerNext = chain;
        const bound = interceptor.activity.bind(interceptor);
        chain = function* (ctx: ActivityInterception): Generator<unknown, unknown, unknown> {
          return yield* bound(ctx, innerNext);
        };
      }
    }

    return yield* chain(interception);
  };
}

/**
 * Compose the `sleep` hooks of all workflow interceptors into a single
 * generator chain.
 */
function composeSleepHook(
  interceptors: WorkflowInterceptor[],
): ComposedWorkflowInterceptor['sleep'] {
  return function* composedSleep(
    interception: SleepInterception,
    execute: (interception: SleepInterception) => Generator<unknown, void, unknown>,
  ): Generator<unknown, void, unknown> {
    type Next = (ctx: SleepInterception) => Generator<unknown, void, unknown>;

    let chain: Next = execute;

    for (let i = interceptors.length - 1; i >= 0; i--) {
      const interceptor = interceptors[i]!;

      if (interceptor.sleep) {
        const innerNext = chain;
        const bound = interceptor.sleep.bind(interceptor);
        chain = function* (ctx: SleepInterception): Generator<unknown, void, unknown> {
          yield* bound(ctx, innerNext);
        };
      }
    }

    yield* chain(interception);
  };
}

/**
 * Compose the `waitForSignal` hooks of all workflow interceptors into a single
 * generator chain.
 */
function composeWaitForSignalHook(
  interceptors: WorkflowInterceptor[],
): ComposedWorkflowInterceptor['waitForSignal'] {
  return function* composedWaitForSignal(
    interception: SignalInterception,
    execute: (interception: SignalInterception) => Generator<unknown, unknown, unknown>,
  ): Generator<unknown, unknown, unknown> {
    type Next = (ctx: SignalInterception) => Generator<unknown, unknown, unknown>;

    let chain: Next = execute;

    for (let i = interceptors.length - 1; i >= 0; i--) {
      const interceptor = interceptors[i]!;

      if (interceptor.waitForSignal) {
        const innerNext = chain;
        const bound = interceptor.waitForSignal.bind(interceptor);
        chain = function* (ctx: SignalInterception): Generator<unknown, unknown, unknown> {
          return yield* bound(ctx, innerNext);
        };
      }
    }

    return yield* chain(interception);
  };
}

/**
 * Compose the `workflowStart` hooks of all workflow interceptors into a single
 * chain.
 */
function composeWorkflowStartHook(
  interceptors: WorkflowInterceptor[],
): ComposedWorkflowInterceptor['workflowStart'] {
  return function composedWorkflowStart(
    interception: WorkflowStartInterception,
    execute: (interception: WorkflowStartInterception) => void,
  ): void {
    type Next = (ctx: WorkflowStartInterception) => void;

    let chain: Next = execute;

    for (let i = interceptors.length - 1; i >= 0; i--) {
      const interceptor = interceptors[i]!;

      if (interceptor.workflowStart) {
        const innerNext = chain;
        const bound = interceptor.workflowStart.bind(interceptor);
        chain = (ctx: WorkflowStartInterception): void => {
          bound(ctx, innerNext);
        };
      }
    }

    chain(interception);
  };
}

/**
 * Compose the `childWorkflow` hooks of all workflow interceptors into a single
 * async chain.
 */
function composeChildWorkflowHook(
  interceptors: WorkflowInterceptor[],
): ComposedWorkflowInterceptor['childWorkflow'] {
  return async function composedChildWorkflow(
    interception: ChildWorkflowInterception,
    execute: (interception: ChildWorkflowInterception) => Promise<unknown>,
  ): Promise<unknown> {
    type Next = (ctx: ChildWorkflowInterception) => Promise<unknown>;

    let chain: Next = execute;

    for (let i = interceptors.length - 1; i >= 0; i--) {
      const interceptor = interceptors[i]!;

      if (interceptor.childWorkflow) {
        const innerNext = chain;
        const bound = interceptor.childWorkflow.bind(interceptor);
        chain = (ctx: ChildWorkflowInterception): Promise<unknown> => {
          return bound(ctx, innerNext);
        };
      }
    }

    return chain(interception);
  };
}

/**
 * Compose the `query` hooks of all workflow interceptors into a single
 * generator chain.
 */
function composeQueryHook(
  interceptors: WorkflowInterceptor[],
): ComposedWorkflowInterceptor['query'] {
  return function* composedQuery(
    interception: QueryInterception,
    execute: (interception: QueryInterception) => Generator<unknown, unknown, unknown>,
  ): Generator<unknown, unknown, unknown> {
    type Next = (ctx: QueryInterception) => Generator<unknown, unknown, unknown>;

    let chain: Next = execute;

    for (let i = interceptors.length - 1; i >= 0; i--) {
      const interceptor = interceptors[i]!;

      if (interceptor.query) {
        const innerNext = chain;
        const bound = interceptor.query.bind(interceptor);
        chain = function* (ctx: QueryInterception): Generator<unknown, unknown, unknown> {
          return yield* bound(ctx, innerNext);
        };
      }
    }

    return yield* chain(interception);
  };
}

/**
 * Compose the `signalReceived` hooks of all workflow interceptors into a
 * single chain.
 */
function composeSignalReceivedHook(
  interceptors: WorkflowInterceptor[],
): ComposedWorkflowInterceptor['signalReceived'] {
  return function composedSignalReceived(
    interception: SignalReceivedInterception,
    execute: (interception: SignalReceivedInterception) => void,
  ): void {
    type Next = (ctx: SignalReceivedInterception) => void;

    let chain: Next = execute;

    for (let i = interceptors.length - 1; i >= 0; i--) {
      const interceptor = interceptors[i]!;

      if (interceptor.signalReceived) {
        const innerNext = chain;
        const bound = interceptor.signalReceived.bind(interceptor);
        chain = (ctx: SignalReceivedInterception): void => {
          bound(ctx, innerNext);
        };
      }
    }

    chain(interception);
  };
}

/**
 * Compose multiple workflow interceptors into a single interceptor chain.
 *
 * @example
 * ```ts
 * import { composeWorkflowInterceptors, type WorkflowInterceptor } from '@lostgradient/weft';
 *
 * const tracing: WorkflowInterceptor = {
 *   *activity(ctx, next) {
 *     console.log('start', ctx.activityName);
 *     const result = yield* next(ctx);
 *     console.log('end', ctx.activityName);
 *     return result;
 *   },
 * };
 * const composed = composeWorkflowInterceptors([tracing]);
 * void composed;
 * ```
 */
export function composeWorkflowInterceptors(
  interceptors: WorkflowInterceptor[],
): ComposedWorkflowInterceptor {
  return {
    activity: composeActivityHook(interceptors),
    sleep: composeSleepHook(interceptors),
    waitForSignal: composeWaitForSignalHook(interceptors),
    workflowStart: composeWorkflowStartHook(interceptors),
    childWorkflow: composeChildWorkflowHook(interceptors),
    query: composeQueryHook(interceptors),
    signalReceived: composeSignalReceivedHook(interceptors),
  };
}
