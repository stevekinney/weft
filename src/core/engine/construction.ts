import { AlertManager } from '../../alerting/alert-manager.ts';
import { CompressedStorage } from '../../storage/compressed-storage.ts';
import type { Storage as WeftStorage } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { ActivityWorkerDispatcher } from '../../workers/activity-worker-dispatcher.ts';
import { WorkerPool } from '../../workers/pool.ts';
import { InlineExecutionStrategy } from '../inline-execution-strategy.ts';
import type { ComposedWorkflowInterceptor, Interceptor } from '../interceptor.ts';
import {
  DEFAULT_RETENTION_SWEEP_BATCH_SIZE,
  DEFAULT_RETENTION_SWEEP_INTERVAL_MS,
  type AnyActivityDefinition,
  type AnyWorkflowDefinition,
  type EngineOptions,
  type RegisteredWorkflowDefinition,
} from '../types.ts';
import { WorkerExecutionStrategy } from '../worker-execution-strategy.ts';
import {
  DEFAULT_WORKER_PROTOCOL_MESSAGE_BYTES,
  DEFAULT_WORKER_TURN_TIMEOUT_MS,
  MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
} from '../worker-protocol.ts';
import type {
  EngineConstructorOptions,
  ExecutionStrategyBundle,
  RegistrationEntry,
  ResolvedOptions,
} from './engine-internal-types.ts';
import {
  normalizeHistoryPolicy,
  normalizePayloadSizePolicy,
  normalizeRetentionDuration,
  normalizeRetentionPolicy,
} from './validation.ts';

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
  requireConcurrentResumeSafety?: boolean | undefined;
  allowLegacyData?: boolean | undefined;
};

export type NormalizedWorkerExecutionConfiguration =
  | { mode: 'inline'; workerExecution: null }
  | {
      mode: 'worker';
      workerExecution: NonNullable<EngineConstructorOptions['workerExecution']>;
      // Worker mode is reachable only via explicit `workflowExecutionMode: 'worker'`,
      // which always applies the hardened defaults — these are never undefined and
      // the two guards are always on.
      workflowTurnTimeoutMs: number;
      maxProtocolMessageBytes: number;
      requireProtocolVersion: true;
      discardOnCancel: true;
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

let didWarnOnMemoryStorageFallback = false;

/**
 * Read an environment variable without assuming a runtime. The engine
 * constructor runs in Bun, Node, and the browser/Service Worker, so a bare
 * `Bun.env[...]` (or `process.env[...]`) would throw a ReferenceError where
 * that global is absent. Returns `undefined` when no environment object exists.
 */
function readEnvironmentVariable(name: string): string | undefined {
  if (typeof Bun !== 'undefined') {
    return Bun.env[name];
  }
  if (typeof process !== 'undefined') {
    return process.env[name];
  }
  return undefined;
}

/**
 * Whether to warn when an `Engine` falls back to {@link MemoryStorage}. Gated
 * to development so production never logs it: the explicit `development: true`
 * option, or the same environment signals as the other engine dev-warnings
 * (`WEFT_DEV_WARNINGS=1` / `NODE_ENV=development`). No test override is needed —
 * the gate is just an option plus two env vars, so tests drive it directly.
 */
function shouldWarnOnMemoryStorageFallback(options?: EngineConstructorOptions): boolean {
  return (
    options?.development === true ||
    readEnvironmentVariable('WEFT_DEV_WARNINGS') === '1' ||
    readEnvironmentVariable('NODE_ENV') === 'development'
  );
}

/** Test-only reset of the one-shot MemoryStorage-fallback warning latch. */
export function resetMemoryStorageFallbackWarningForTesting(): void {
  didWarnOnMemoryStorageFallback = false;
}

export function resolveEngineStorage(options?: EngineConstructorOptions): WeftStorage {
  // `?? null`-style coalescing: a `null` storage (untyped JS callers) falls back
  // just like `undefined`, matching the original `options?.storage ?? …` and the
  // `defaultTo` helper's documented behavior.
  const providedStorage = options?.storage ?? undefined;
  let baseStorage = providedStorage;
  if (baseStorage === undefined) {
    // No storage configured: workflow state lives only in memory and is lost
    // when the process exits. Warn in development so a first-time user who
    // crashes and restarts understands why their workflows vanished; stay
    // silent in production, where MemoryStorage may be a deliberate choice.
    // The latch keeps repeated Engine constructions from spamming the log.
    if (!didWarnOnMemoryStorageFallback && shouldWarnOnMemoryStorageFallback(options)) {
      didWarnOnMemoryStorageFallback = true;
      console.warn(
        '[weft] Engine started with no `storage` configured — falling back to MemoryStorage. ' +
          'Workflow state is held only in memory and is lost when the process exits, so a crash ' +
          'or restart discards every in-flight workflow. Pass a durable adapter (e.g. ' +
          'SQLiteStorage) via `new Engine({ storage })` for anything beyond tests and local dev. ' +
          '(This warning appears only in development.)',
      );
    }
    baseStorage = new MemoryStorage();
  }
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

// `??` coerces both `undefined` and `null` to the default; destructuring
// defaults only fire on `undefined`. Using `??` here preserves the
// pre-refactor behavior for untyped JS callers that may pass an explicit
// `null` for an optional field. `defaultTo` keeps each defaulting expression
// at constant complexity, so the surrounding helpers stay under the
// per-function complexity ceiling.
function defaultTo<T>(value: T | null | undefined, fallback: T): T {
  return value ?? fallback;
}

function resolveBooleanDefaults(
  options: EngineConstructorOptions | undefined,
): Pick<ResolvedOptions, 'development' | 'broadcastEvents'> {
  return {
    development: defaultTo(options?.development, false),
    broadcastEvents: defaultTo(options?.broadcastEvents, false),
  };
}

function resolveNumericDefaults(
  options: EngineConstructorOptions | undefined,
): Pick<
  ResolvedOptions,
  'checkpointHistory' | 'checkpointSizeWarningThreshold' | 'maxNestingDepth'
> {
  return {
    checkpointHistory: defaultTo(options?.checkpointHistory, 10),
    checkpointSizeWarningThreshold: defaultTo(options?.checkpointSizeWarningThreshold, 65_536),
    maxNestingDepth: defaultTo(options?.maxNestingDepth, 10),
  };
}

function resolveHistoryFields(
  options: EngineConstructorOptions | undefined,
): Pick<ResolvedOptions, 'historyPolicy' | 'archiveAdapter' | 'payloadSizePolicy'> {
  return {
    historyPolicy: normalizeHistoryPolicy(options?.history, 'options.history'),
    archiveAdapter: options?.archive ?? null,
    payloadSizePolicy: normalizePayloadSizePolicy(options?.payloadSize, 'options.payloadSize'),
  };
}

export function resolveEngineOptions(
  storage: WeftStorage,
  options: EngineConstructorOptions | undefined,
  getNow: () => number,
): ResolvedOptions {
  return {
    storage,
    getNow,
    ...resolveBooleanDefaults(options),
    ...resolveNumericDefaults(options),
    ...resolveRetentionFields(options),
    ...resolveHistoryFields(options),
  };
}

export function normalizeWorkerExecutionConfiguration(
  options: EngineConstructorOptions | undefined,
): NormalizedWorkerExecutionConfiguration {
  const workflowExecutionMode = normalizeWorkflowExecutionMode(options?.workflowExecutionMode);
  const workerExecution = resolveWorkerExecutionForMode(options, workflowExecutionMode);
  if (!workerExecution) {
    return { mode: 'inline', workerExecution: null };
  }

  return normalizeWorkerModeConfiguration(workerExecution);
}

function normalizeWorkflowExecutionMode(
  value: unknown,
): EngineConstructorOptions['workflowExecutionMode'] {
  if (value === undefined || value === 'inline' || value === 'worker') {
    return value;
  }
  throw new Error('options.workflowExecutionMode must be "inline" or "worker" when provided');
}

function resolveWorkerExecutionForMode(
  options: EngineConstructorOptions | undefined,
  workflowExecutionMode: EngineConstructorOptions['workflowExecutionMode'],
): NonNullable<EngineConstructorOptions['workerExecution']> | null {
  if (workflowExecutionMode === 'inline') {
    if (options?.workerExecution !== undefined) {
      throw new Error(
        'options.workerExecution cannot be provided when workflowExecutionMode is "inline"',
      );
    }
    return null;
  }
  if (workflowExecutionMode === 'worker') {
    if (options?.workerExecution === undefined) {
      throw new Error('options.workerExecution is required when workflowExecutionMode is "worker"');
    }
    return options.workerExecution;
  }
  // Omitted mode defaults to inline. Worker execution is the hardened untrusted
  // posture and must be requested explicitly; providing workerExecution alone is
  // an error rather than a silent, weaker Worker selection.
  if (options?.workerExecution !== undefined) {
    throw new Error(
      'options.workflowExecutionMode must be "worker" when options.workerExecution is provided',
    );
  }
  return null;
}

function normalizeWorkerModeConfiguration(
  workerExecution: NonNullable<EngineConstructorOptions['workerExecution']>,
): NormalizedWorkerExecutionConfiguration {
  // Worker mode is reachable only via explicit `workflowExecutionMode: 'worker'`,
  // so it always applies the hardened turn-timeout and protocol-message defaults.
  // Validate any caller override (which may be undefined), then fall back to the
  // hardened default so both values are always a concrete `number`.
  const workflowTurnTimeoutMs =
    normalizePositiveSafeIntegerOption(
      workerExecution.workflowTurnTimeoutMs,
      'options.workerExecution.workflowTurnTimeoutMs',
      undefined,
    ) ?? DEFAULT_WORKER_TURN_TIMEOUT_MS;
  const maxProtocolMessageBytes =
    normalizePositiveSafeIntegerOption(
      workerExecution.maxProtocolMessageBytes,
      'options.workerExecution.maxProtocolMessageBytes',
      undefined,
    ) ?? DEFAULT_WORKER_PROTOCOL_MESSAGE_BYTES;
  if (
    maxProtocolMessageBytes !== undefined &&
    maxProtocolMessageBytes < MIN_WORKER_PROTOCOL_MESSAGE_BYTES
  ) {
    throw new Error(
      `options.workerExecution.maxProtocolMessageBytes must be at least ${MIN_WORKER_PROTOCOL_MESSAGE_BYTES}`,
    );
  }

  return {
    mode: 'worker',
    workerExecution,
    workflowTurnTimeoutMs,
    maxProtocolMessageBytes,
    requireProtocolVersion: true,
    discardOnCancel: true,
  };
}

function normalizePositiveSafeIntegerOption(
  value: unknown,
  fieldName: string,
  defaultValue: number | undefined,
): number | undefined {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive safe integer when provided`);
  }
  return value;
}

export function createExecutionStrategyBundle(parameters: {
  options: EngineConstructorOptions | undefined;
  getNow: () => number;
  maxNestingDepth: number;
  development: boolean;
  broadcastEvents: boolean;
  getRegistration: (workflowType: string) => RegistrationEntry | undefined;
  getComposedWorkflowInterceptor?: () => ComposedWorkflowInterceptor | null;
  resolveWorkflowType: (target: string | Function) => string;
  registerCancelHandler?: (workflowId: string, handler: () => Promise<void> | void) => () => void;
}): ExecutionStrategyBundle {
  const {
    options,
    getNow,
    maxNestingDepth,
    development,
    broadcastEvents,
    getRegistration,
    getComposedWorkflowInterceptor,
    resolveWorkflowType,
    registerCancelHandler,
  } = parameters;
  const workerExecutionConfiguration = normalizeWorkerExecutionConfiguration(options);
  if (workerExecutionConfiguration.mode === 'worker') {
    const pool = new WorkerPool({
      workerUrl: workerExecutionConfiguration.workerExecution.workerUrl,
      concurrency: workerExecutionConfiguration.workerExecution.poolSize ?? 4,
      smol: workerExecutionConfiguration.workerExecution.smol ?? false,
    });
    const strategyOptions = {
      broadcastEvents,
      requireProtocolVersion: workerExecutionConfiguration.requireProtocolVersion,
      discardOnCancel: workerExecutionConfiguration.discardOnCancel,
      workflowTurnTimeoutMs: workerExecutionConfiguration.workflowTurnTimeoutMs,
      maxProtocolMessageBytes: workerExecutionConfiguration.maxProtocolMessageBytes,
    };
    return {
      strategy: new WorkerExecutionStrategy(pool, strategyOptions),
      inlineStrategy: null,
    };
  }
  const inlineStrategy = new InlineExecutionStrategy({
    getRegistration,
    ...(getComposedWorkflowInterceptor !== undefined && { getComposedWorkflowInterceptor }),
    getNow,
    maxNestingDepth,
    development,
    resolveWorkflowType,
    ...(registerCancelHandler !== undefined && { registerCancelHandler }),
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
