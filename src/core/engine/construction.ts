import { AlertManager } from '../../alerting/alert-manager.ts';
import { CompressedStorage } from '../../storage/compressed-storage.ts';
import type { Storage as WeftStorage } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { ActivityWorkerDispatcher } from '../../workers/activity-worker-dispatcher.ts';
import { WorkerPool } from '../../workers/pool.ts';
import { InlineExecutionStrategy } from '../inline-execution-strategy.ts';
import type { Interceptor } from '../interceptor.ts';
import {
  DEFAULT_RETENTION_SWEEP_BATCH_SIZE,
  DEFAULT_RETENTION_SWEEP_INTERVAL_MS,
  type AnyActivityDefinition,
  type AnyWorkflowDefinition,
  type EngineOptions,
  type RegisteredWorkflowDefinition,
} from '../types.ts';
import { WorkerExecutionStrategy } from '../worker-execution-strategy.ts';
import type {
  EngineConstructorOptions,
  ExecutionStrategyBundle,
  RegistrationEntry,
  ResolvedOptions,
} from './engine-internal-types.ts';
import { normalizeRetentionDuration, normalizeRetentionPolicy } from './validation.ts';

export type KnownWorkflowNames<TWorkflows extends object> = Extract<keyof TWorkflows, string>;
declare const emptyWorkflowDefinitions: unique symbol;
declare const emptyActivityDefinitions: unique symbol;
export type EmptyWorkflowDefinitions = Record<string, never> & {
  readonly [emptyWorkflowDefinitions]: true;
};
export type EmptyActivityDefinitions = Record<string, never> & {
  readonly [emptyActivityDefinitions]: true;
};
export type EngineCreateRuntimeOptions = EngineConstructorOptions & {
  activities?: Record<string, AnyActivityDefinition> | undefined;
  workflows?: Record<string, AnyWorkflowDefinition> | undefined;
  recover?: boolean | undefined;
  acknowledgeUnknownWorkflowTypes?: boolean | undefined;
};

export function definitionEntries<TDefinition extends object>(
  definitions: Record<string, TDefinition> | undefined,
): Array<[string, TDefinition]> {
  return Object.entries(definitions ?? {});
}

export function typedEngineView<TViewWorkflows extends object, TViewActivities extends object>(
  engine: object,
  _phantomTypes?: readonly [TViewWorkflows, TViewActivities],
): never {
  // Cycle-breaking workaround. The runtime instance is the same Engine; this
  // re-narrows the phantom type parameters after `register` has mutated the
  // underlying registries. The declared return type is `never` so this module
  // does not need to import the Engine class from `./index.ts` (which itself
  // imports from this module — a runtime cycle). The public return type is
  // produced by `register`'s overload signatures in `./index.ts`; this helper
  // is only invoked from inside `register`'s `unknown`-typed implementation
  // body, where `never` is assignable. Do not call from any other context.
  return engine as never;
}

export function resolveEngineStorage(options?: EngineConstructorOptions): WeftStorage {
  const baseStorage = options?.storage ?? new MemoryStorage();
  if (!options?.compression) return baseStorage;
  return new CompressedStorage(baseStorage, options.compression);
}

export function resolveEngineInterceptors(options?: EngineConstructorOptions): Interceptor[] {
  // Defensive copy: callers must not mutate the engine's interceptor list
  // after construction. Mutating the source array directly would bypass
  // the composed-interceptor cache invalidation in `addInterceptor`.
  return options?.interceptors ? [...options.interceptors] : [];
}

export function copyWorkflowDefinition(
  type: string,
  registration: RegistrationEntry,
): RegisteredWorkflowDefinition {
  return {
    type,
    version: registration.version,
    tags: registration.tags === undefined ? [] : [...registration.tags],
    ...(registration.description === undefined ? {} : { description: registration.description }),
    ...(registration.inputSchema === undefined ? {} : { inputSchema: registration.inputSchema }),
    ...(registration.outputSchema === undefined ? {} : { outputSchema: registration.outputSchema }),
    ...(registration.searchAttributes === undefined
      ? {}
      : { searchAttributes: registration.searchAttributes }),
  };
}

function resolveRetentionFields(
  options: EngineConstructorOptions | undefined,
): Pick<ResolvedOptions, 'retention' | 'retentionSweepIntervalMs' | 'retentionSweepBatchSize'> {
  return {
    retention: normalizeRetentionPolicy(options?.retention, 'options.retention'),
    retentionSweepIntervalMs:
      normalizeRetentionDuration(
        options?.retentionSweepInterval,
        'options.retentionSweepInterval',
      ) ?? DEFAULT_RETENTION_SWEEP_INTERVAL_MS,
    retentionSweepBatchSize:
      options?.retentionSweepBatchSize !== undefined
        ? Math.max(1, Math.floor(options.retentionSweepBatchSize))
        : DEFAULT_RETENTION_SWEEP_BATCH_SIZE,
  };
}

export function resolveEngineOptions(
  storage: WeftStorage,
  options: EngineConstructorOptions | undefined,
  getNow: () => number,
): ResolvedOptions {
  if (options?.suspendOnLlmWait === true) {
    throw new Error('suspendOnLlmWait is not yet implemented');
  }

  const {
    development = false,
    checkpointHistory = 10,
    checkpointSizeWarningThreshold = 65_536,
    maxNestingDepth = 10,
    broadcastEvents = false,
    tenantResolver,
  } = options ?? {};

  return {
    storage,
    development,
    checkpointHistory,
    checkpointSizeWarningThreshold,
    maxNestingDepth,
    broadcastEvents,
    suspendOnLlmWait: false,
    getNow,
    tenantResolver,
    ...resolveRetentionFields(options),
  };
}

export function createExecutionStrategyBundle(parameters: {
  options: EngineConstructorOptions | undefined;
  getNow: () => number;
  maxNestingDepth: number;
  development: boolean;
  broadcastEvents: boolean;
  getRegistration: (workflowType: string) => RegistrationEntry | undefined;
  resolveWorkflowType: (target: string | Function) => string;
}): ExecutionStrategyBundle {
  const {
    options,
    getNow,
    maxNestingDepth,
    development,
    broadcastEvents,
    getRegistration,
    resolveWorkflowType,
  } = parameters;
  if (options?.workerExecution) {
    const pool = new WorkerPool({
      workerUrl: options.workerExecution.workerUrl,
      concurrency: options.workerExecution.poolSize ?? 4,
      smol: options.workerExecution.smol ?? false,
    });
    return {
      strategy: new WorkerExecutionStrategy(pool, { broadcastEvents }),
      inlineStrategy: null,
    };
  }
  const inlineStrategy = new InlineExecutionStrategy({
    getRegistration,
    getNow,
    maxNestingDepth,
    development,
    resolveWorkflowType,
  });
  return { strategy: inlineStrategy, inlineStrategy };
}

export function createActivityWorkerDispatcher(
  activityExecution: EngineConstructorOptions['activityExecution'],
): ActivityWorkerDispatcher | null {
  if (!activityExecution) return null;
  return new ActivityWorkerDispatcher(
    new WorkerPool({
      workerUrl: activityExecution.workerUrl,
      concurrency: activityExecution.poolSize ?? 4,
      smol: activityExecution.smol ?? false,
    }),
  );
}

export function createAlertManagerForEngine(
  // Typed as the structural parent `EventTarget` rather than `Engine<...>` to
  // keep this module free of an Engine import (see `typedEngineView` for the
  // cycle rationale). `AlertManager` only relies on the EventTarget surface;
  // no workflow/activity generic information is lost at call sites because
  // they retain their `Engine` typing.
  engine: EventTarget,
  alerts: EngineOptions['alerts'] | undefined,
  getNow: () => number,
): AlertManager | null {
  return alerts ? new AlertManager(engine, alerts, getNow) : null;
}
