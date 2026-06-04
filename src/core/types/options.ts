import type { AlertingOptions } from '../../alerting/types.ts';
import type { Storage as WeftStorage } from '../../storage/interface.ts';
import type { CompressionOptions } from '../compression.ts';
import type { Interceptor } from '../interceptor.ts';
import type { ArchiveAdapter } from './archive-adapter.ts';
import type { HistoryPolicy } from './history-policy.ts';
import type { FailureCategory, WorkflowStatus } from './identity.ts';
import type { PayloadSizePolicy } from './payload-size-policy.ts';
import type { Duration, RetentionPolicy } from './retry-retention.ts';
import type { SearchAttributeHandle, SearchAttributeValue } from './search-attributes.ts';
import type { Serializer } from './serializer.ts';
import type {
  WorkflowServicesResolution,
  WorkflowServicesResolverInfo,
} from './services-resolution.ts';

// ---------------------------------------------------------------------------
// Start options for engine.start()
// ---------------------------------------------------------------------------

/**
 * Options accepted by `engine.start(type, input, options?)`.
 *
 * Every field is optional. `id` lets you specify your own workflow ID;
 * `idempotencyKey` enforces single-execution semantics within a window;
 * `executionTimeout` caps wall-clock time; `startAt`/`startAfter` defer
 * execution; `tags` and `searchAttributes` make the workflow discoverable
 * via filters.
 *
 * `HttpClient.start` forwards `searchAttributes` to the server. It rejects
 * `idempotencyKey` until the HTTP start protocol exposes matching
 * single-execution semantics, so callers do not accidentally rely on a
 * silently dropped option.
 *
 * @example Start a delayed workflow with tags and search attributes
 * ```ts
 * import { workflow, Engine, type StartOptions } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.register(
 *   workflow({ name: 'greet' }).execute(async function* () {
 *     return 'hi';
 *   }),
 * );
 *
 * const options: StartOptions = {
 *   id: 'greeting-2026-04-29',
 *   startAfter: '5m',
 *   tags: ['nightly', 'ops'],
 *   searchAttributes: { customerId: 'acme' },
 * };
 * const handle = await engine.start('greet', null, options);
 * void handle;
 * ```
 */
export interface StartOptions {
  id?: string;
  idempotencyKey?: string;
  executionTimeout?: Duration;
  startAt?: number;
  startAfter?: Duration;
  tags?: string[];
  searchAttributes?: Record<string, SearchAttributeValue>;
  /**
   * Host-supplied, per-run capabilities exposed to the workflow body as
   * `ctx.services` (live clients, closures, tool registries). The value is
   * **never checkpointed**; on a fresh-process recovery it is re-provided by the
   * engine's {@link EngineOptions.resolveWorkflowServices} resolver before the
   * generator advances.
   *
   * Inline execution mode only. Passing `services` under
   * `workflowExecutionMode: 'worker'` throws at `engine.start()`, because a
   * non-serializable value cannot cross to a Worker.
   */
  services?: unknown;
  /**
   * When `false`, `engine.start()` resolves only after the workflow has begun
   * executing (its generator has been driven its first turn), not merely after
   * the initial state is persisted. The default (`true`) returns a handle as
   * soon as state is written and queues execution onto a macrotask, so a caller
   * cannot assume the run is live without a round-trip. Use `defer: false` when a
   * caller — or a test — must rely on the run being live immediately after
   * `await engine.start(...)`. Inline mode only; throws at `engine.start()` under
   * `workflowExecutionMode: 'worker'` or with a delayed start (`startAt`/
   * `startAfter`), neither of which has inline liveness to await.
   */
  defer?: boolean;
}

/**
 * Options for {@link Engine.fork}. Controls which checkpoint step to fork
 * from; defaults to the latest persisted checkpoint when omitted.
 *
 * @example
 * ```ts
 * import { workflow, Engine, type ForkOptions } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.register(workflow({ name: 'process' }).execute(async function* () { return 'done'; }));
 *
 * const original = await engine.start('process', null);
 * await original.result();
 *
 * const options: ForkOptions = { fromStep: 2 };
 * const forked = await engine.fork(original.id, options);
 * void forked;
 * ```
 */
export interface ForkOptions {
  fromStep?: number;
}

// ---------------------------------------------------------------------------
// Engine configuration
// ---------------------------------------------------------------------------

/**
 * Configuration options for the {@link Engine} constructor.
 *
 * All fields are optional. Common overrides include `storage`, `retention`,
 * `development`, `serializer`, `compression`, `workflowExecutionMode`,
 * `workerExecution`, and `alerts`.
 *
 * @example
 * ```ts
 * import { Engine, type EngineOptions } from '@lostgradient/weft';
 *
 * const options: EngineOptions = {
 *   development: true,
 *   retention: { completed: '7d', failed: '30d' },
 *   checkpointSizeWarningThreshold: 128_000,
 * };
 *
 * const engine = new Engine(options);
 * void engine;
 * ```
 */
export interface EngineOptions {
  storage?: WeftStorage;
  development?: boolean;
  serializer?: Serializer;
  retention?: RetentionPolicy;
  retentionSweepInterval?: Duration;
  retentionSweepBatchSize?: number;
  /**
   * History circuit-breaker thresholds. When `history.maxEvents` is set, a
   * workflow whose event-log record count would exceed it is forced to a
   * terminal `timed-out` state with reason {@link HISTORY_CIRCUIT_BREAKER_REASON}.
   * Omit to disable. There are no baked-in defaults.
   */
  history?: HistoryPolicy;
  /**
   * Operator-supplied sink for event-log ranges discarded by
   * `history.retentionWindow` compaction. Best-effort export only — see
   * {@link ArchiveAdapter}. Omit for no archival (the default).
   */
  archive?: ArchiveAdapter;
  /**
   * Payload-size cap thresholds. When `payloadSize.maxBytes` is set, a workflow
   * input, signal payload, or activity result whose serialized (codec-encoded)
   * size would exceed it is rejected at admission with `PayloadSizeExceededError`
   * before any storage write. Omit to disable. There are no baked-in defaults.
   */
  payloadSize?: PayloadSizePolicy;
  /** Payload compression applied at the storage layer. */
  compression?: CompressionOptions;
  checkpointHistory?: number;
  checkpointSizeWarningThreshold?: number;
  maxNestingDepth?: number;
  /** Enable BroadcastChannel for cross-worker event coordination. Default: false. */
  broadcastEvents?: boolean;
  /**
   * Select where workflow generator turns execute. Omitting this defaults to
   * `'inline'`, which steps the generator in the engine isolate and is
   * appropriate only when workflow code is trusted. Use `'worker'` for
   * untrusted deployments: it requires `workerExecution` and applies hardened
   * Worker turn-timeout and protocol-message-size limits. Explicit `'inline'`
   * rejects `workerExecution`.
   */
  workflowExecutionMode?: 'inline' | 'worker';
  /**
   * Enable Worker-based workflow execution. When provided, workflow generator
   * turns run in Web Workers instead of inline on the engine isolate. Activities
   * are still executed on the main thread via the activity registry unless
   * `activityExecution` is also configured.
   *
   * Explicit `workflowExecutionMode: 'worker'` requires this object, applies
   * hardened defaults for Worker turn timeout and protocol-message size, and
   * rejects invalid runtime values. Explicit `workflowExecutionMode: 'inline'`
   * rejects this object to avoid ambiguous trust posture.
   *
   * Worker execution protects engine liveness and engine heap access. It is not
   * an operating-system sandbox: workflow code can still access APIs exposed in
   * the Worker runtime.
   */
  workerExecution?: {
    /** URL of the worker script, for example `new URL('./workflow-worker.ts', import.meta.url)`. */
    workerUrl: string | URL;
    /** Maximum number of concurrent workers. Default: 4. */
    poolSize?: number;
    /** Use Bun's `smol` worker option for smaller memory footprint. */
    smol?: boolean;
    /**
     * Host-enforced wall-clock timeout for each Worker `run` or `resume` turn.
     * Defaults to `1_000` in Worker mode. Provide a positive safe integer to
     * override the default.
     */
    workflowTurnTimeoutMs?: number;
    /**
     * Maximum encoded size of Weft-owned Worker protocol messages. Defaults to
     * `1_048_576` in explicit Worker mode. The minimum accepted value is
     * `4_096` so bounded failure envelopes can always cross the protocol.
     */
    maxProtocolMessageBytes?: number;
  };

  /**
   * Enable worker-based activity execution. When provided, activity functions
   * run in isolated Web Workers instead of on the main thread. Activities must
   * be pre-registered in the worker via `createActivityWorkerEntryUrl`.
   */
  activityExecution?: {
    /** URL of the activity worker script (created via `createActivityWorkerEntryUrl`). */
    workerUrl: string | URL;
    /** Maximum number of concurrent activity workers. Default: 4. */
    poolSize?: number;
    /** Use Bun's `smol` worker option for smaller memory footprint. */
    smol?: boolean;
  };

  /** Built-in alerting configuration. */
  alerts?: AlertingOptions;

  /**
   * Unified interceptors registered at construction. This is equivalent to
   * calling `addInterceptor` for each entry; each interceptor participates in
   * the workflow and/or activity pipeline based on which hooks it implements.
   * The engine takes a defensive copy at construction — mutating this array
   * after passing it has no effect.
   */
  interceptors?: readonly Interceptor[];

  /**
   * Re-provide the non-serialized per-run `services` value (see
   * {@link StartOptions.services}) for a workflow recovered in a fresh process.
   * `engine.recoverAll()` and `engine.resume(id)` call this **before** the
   * generator is driven forward (and the delayed-start timer handler calls it
   * for a `startAfter`/`startAt` run that crashed before firing), so the resumed
   * body can read `ctx.services` exactly as it did before the crash.
   *
   * Return `{ status: 'available', services }` to supply the rebuilt
   * capabilities, or `{ status: 'unavailable', reason }` to fail just that one
   * recovered run — the engine and every other recovered run are unaffected.
   * Without a resolver, a recovered inline workflow that reads `ctx.services`
   * sees `undefined`.
   *
   * Contract a fresh integrator must know:
   * - Fires only for recovered inline runs that were launched WITH `services`
   *   (those carrying the durable "expects services" marker). A run started
   *   without `services` never reaches the resolver, regardless of what it would
   *   return — so a fail-closed resolver does not fail innocent no-services runs.
   * - `{ status: 'unavailable' }` permanently fails the run (terminal `failed`,
   *   `system` category) with `reason` as the message — not a "retry later"
   *   signal. A resolver *throw* is treated identically (error message → reason).
   * - May be called again on a later boot if a prior recovery left the run still
   *   recoverable (e.g. the terminal-fail commit faulted), so keep it idempotent.
   * - Inline only; worker-mode runs never invoke it.
   *
   * Engine-scoped: each engine instance carries its own resolver, so two engines
   * in one process never collide on per-run dependency reconstruction.
   */
  resolveWorkflowServices?: (
    info: WorkflowServicesResolverInfo,
  ) => WorkflowServicesResolution | Promise<WorkflowServicesResolution>;
}

// ---------------------------------------------------------------------------
// List/filter options
// ---------------------------------------------------------------------------

/**
 * Filter criteria for {@link Engine.list}. All fields are optional and
 * combine with AND semantics. `status` accepts a single value or an array;
 * `attributes` is a list of attribute predicates evaluated on indexed search
 * attributes. Pairs with `limit`/`offset` for pagination.
 *
 * @example
 * ```ts
 * import { Engine, type ListFilter } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * const filter: ListFilter = {
 *   status: ['running', 'pending'],
 *   tags: ['nightly'],
 *   attributes: [{ key: 'customerId', value: 'acme' }],
 *   limit: 20,
 *   offset: 0,
 * };
 * const result = await engine.list(filter);
 * console.log(result.items.length);
 * ```
 */
/**
 * Numeric half-open range bound, used by visibility filters that match a
 * stored numeric field (timestamps, deadlines). Provide at least one of the
 * four bounds. `gt`/`gte` are mutually exclusive on the lower side; `lt`/`lte`
 * are mutually exclusive on the upper side.
 */
export interface TimeRange {
  gte?: number;
  lte?: number;
  gt?: number;
  lt?: number;
}

/**
 * Filter passed to {@link Engine.list} (and equivalent visibility transports)
 * to narrow which {@link WorkflowSummary} entries are returned. Every field
 * is optional; combining fields applies them as AND.
 *
 * @example
 * ```ts
 * import { Engine, type ListFilter } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * const filter: ListFilter = {
 *   status: ['running', 'failed'],
 *   createdAt: { gte: Date.now() - 60_000 },
 * };
 *
 * const page = await engine.list(filter);
 * ```
 */
export interface ListFilter {
  /** Match workflows whose {@link WorkflowState.status} is one of the listed values. */
  status?: WorkflowStatus | WorkflowStatus[];
  /**
   * Match workflows by registered workflow type (e.g. `'order-fulfillment'`).
   *
   * @example
   * ```ts
   * import type { ListFilter } from '@lostgradient/weft';
   * const filter: ListFilter = { type: 'order-fulfillment' };
   * ```
   */
  type?: string;
  /** Match workflows that carry every listed tag. */
  tags?: string[];
  /** Filter on indexed search attributes (equality or range). */
  attributes?: readonly AttributeFilter[];
  /** Maximum number of summaries to return. Server enforces an upper bound. */
  limit?: number;
  /** Number of summaries to skip before returning results. */
  offset?: number;
  /**
   * Workflow id prefix. Restricted to `[A-Za-z0-9_-]+`; values containing
   * other characters are rejected during validation. Matches by raw
   * `state.id.startsWith(idPrefix)` after candidate enumeration.
   */
  idPrefix?: string;
  /** Range filter on `WorkflowState.createdAt` (ms epoch). */
  createdAt?: TimeRange;
  /** Range filter on `WorkflowState.updatedAt` (ms epoch). */
  updatedAt?: TimeRange;
  /** Range filter on `WorkflowState.executionDeadline` (ms epoch). */
  executionDeadline?: TimeRange;
  /**
   * Match by the workflow's `failureCategory`. The engine uses the
   * `failureCategory` search-attribute index to narrow candidate workflow IDs,
   * then still verifies the loaded `WorkflowState.failureCategory` so state
   * remains authoritative when index entries are stale.
   */
  failureCategory?: FailureCategory | FailureCategory[];
}

/**
 * Projection options for {@link Engine.list}. These options do not change
 * which workflows match the list filter; they only control optional summary
 * fields that may require additional storage reads.
 *
 * @example Include failure categories projected from search attributes
 * ```ts
 * import { Engine, type ListOptions } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * const options: ListOptions = { includeFailureCategory: true };
 * const page = await engine.list({ status: 'failed' }, options);
 * void page;
 * ```
 */
export interface ListOptions {
  /**
   * Populate `WorkflowSummary.failureCategory` for failed workflows from the
   * stored `failureCategory` search attribute when the workflow state itself
   * does not carry a category. Defaults to `false`.
   */
  includeFailureCategory?: boolean;
}

export type AttributeFilterKey = string | SearchAttributeHandle;

export type AttributeFilterValue<TKey extends AttributeFilterKey> =
  TKey extends SearchAttributeHandle<infer TValue>
    ? TValue extends string[]
      ? string
      : TValue
    : SearchAttributeValue;

export type AttributeRangeValue<TKey extends AttributeFilterKey> =
  TKey extends SearchAttributeHandle<infer TValue>
    ? Extract<TValue, Date | number>
    : SearchAttributeValue;

export type AttributeFilter<TKey extends AttributeFilterKey = AttributeFilterKey> =
  TKey extends SearchAttributeHandle
    ?
        | {
            key: TKey;
            value?: AttributeFilterValue<TKey>;
            gt?: never;
            lt?: never;
            gte?: never;
            lte?: never;
          }
        | {
            key: TKey;
            value?: never;
            gt?: AttributeRangeValue<TKey>;
            lt?: AttributeRangeValue<TKey>;
            gte?: AttributeRangeValue<TKey>;
            lte?: AttributeRangeValue<TKey>;
          }
    : {
        key: TKey;
        value?: SearchAttributeValue;
        gt?: SearchAttributeValue;
        lt?: SearchAttributeValue;
        gte?: SearchAttributeValue;
        lte?: SearchAttributeValue;
      };

export type AttributeFilterList<TAttributeKeys extends readonly AttributeFilterKey[]> = {
  readonly [TIndex in keyof TAttributeKeys]: AttributeFilter<TAttributeKeys[TIndex]>;
};

export type TypedListFilter<TAttributeKeys extends readonly AttributeFilterKey[]> = Omit<
  ListFilter,
  'attributes'
> & {
  attributes?: AttributeFilterList<TAttributeKeys>;
};

// ---------------------------------------------------------------------------
// Paginated result
// ---------------------------------------------------------------------------

/**
 * Generic paginated response envelope returned by list operations such as
 * {@link Engine.list} and `engine.listSchedules`. `total` is the full count
 * matching the filter; `items` is the current page slice. `items.length` is
 * bounded by `limit`; the consumer reaches the end of the result set when
 * `offset + items.length >= total`.
 */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}
