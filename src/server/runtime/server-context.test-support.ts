/**
 * Minimal `ServerContext` / serve-options factories for runtime handler
 * characterization tests.
 *
 * Every `runtime/*.characterization.test.ts` suite needs a `ServerContext`
 * populated with inert collaborators so a single handler can be exercised in
 * isolation. These factories supply that scaffolding while keeping each
 * suite's actual assertions local.
 */

import { MetricsCollector } from '../../observability/metrics.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { WorkerRegistry } from '../../worker/registry.ts';
import { DeadlineTracker } from '../deadline-tracker.ts';
import { TaskQueue } from '../task-queue.ts';

import type { ServeOptions } from '../index.ts';
import type { ServerContext } from './context.ts';

/**
 * Minimal `ServerContext` with inert collaborators. `registry` defaults to a
 * real `WorkerRegistry`; suites whose handler never consults it (task-result
 * polling) pass `{ registry: null as never }` to keep their original setup.
 */
export function minimalServerContext(
  overrides?: Partial<Pick<ServerContext, 'registry'>>,
): ServerContext {
  // Property-presence check, not `?? new WorkerRegistry()`: a suite that passes
  // `{ registry: null as never }` does so deliberately, and `??` would clobber
  // that null with a real registry, silently changing its setup.
  const registry = overrides && 'registry' in overrides ? overrides.registry : new WorkerRegistry();
  return {
    registry,
    taskQueue: new TaskQueue(),
    workerSockets: new Map(),
    streamSockets: new Map(),
    workerAffinity: new Map(),
    workflowOperations: new Map(),
    operationToWorkflow: new Map(),
    pendingTimers: new Set(),
    deadlineTracker: new DeadlineTracker(),
    liveOperationRegistry: null as never,
    liveRestBindings: null as never,
    supportedAuthenticationSchemes: new Set() as never,
    corsPolicy: null,
    metricsCollector: new MetricsCollector(),
    eventFeedBackend: null as never,
    workflowEventFeed: null as never,
    activeJsonRpcSessions: new Set(),
    mcpSessionManager: null as never,
    authenticatorPromise: null,
    visibilityPollMs: 5000,
    workerReconnectGracePeriodMs: 0,
    pendingWorkerRequeues: new Map(),
    scanRunning: false,
    processingOperations: new Set(),
    reconciliationRunning: false,
  };
}

/**
 * Minimal serve options carrying just an engine storage backend and port. The
 * runtime handlers only read `options.engine.storage`, so the `engine` is a
 * partial stub rather than a real `Engine`; the cast is to the public
 * `ServeOptions` type (not `never`) so call sites see the correct option shape.
 */
export function minimalServeOptions(storage: MemoryStorage = new MemoryStorage()): ServeOptions {
  // Test-only: the handlers under test only touch `engine.storage`, so a full
  // Engine is unnecessary. The cast covers the deliberately partial `engine`.
  return { engine: { storage }, port: 0 } as unknown as ServeOptions;
}
