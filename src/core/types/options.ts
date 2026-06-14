import type { AlertingOptions } from '../../alerting/types.ts';
import type { Storage as WeftStorage } from '../../storage/interface.ts';
import type { CompressionOptions } from '../compression.ts';
import type { Interceptor } from '../interceptor.ts';
import type { ArchiveAdapter } from './archive-adapter.ts';
import type { HistoryPolicy } from './history-policy.ts';
import type { PayloadSizePolicy } from './payload-size-policy.ts';
import type { Duration, RetentionPolicy } from './retry-retention.ts';
import type { SearchAttributeValue } from './search-attributes.ts';
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
 * `idempotencyKey` enforces at-most-once starts (a repeated key returns the
 * existing run instead of starting a second, even after it reaches a terminal
 * state); `executionTimeout` caps wall-clock time; `startAt`/`startAfter` defer
 * execution; `tags` and `searchAttributes` make the workflow discoverable
 * via filters. `id` and `idempotencyKey` are mutually exclusive — idempotency
 * assigns its own generated id and dedups through the key.
 *
 * This is the shared base accepted by every start-like surface
 * (`engine.start`, `engine.startOrSignal`, and the clients). `engine.start`
 * specifically accepts the wider {@link StartWorkflowOptions}, which adds
 * `onTerminalConflict`; that policy is intentionally absent here so it cannot be
 * passed to `startOrSignal` (whose at-most-once identity is the permanent
 * idempotency mapping).
 *
 * The `idempotencyKey` mapping is durable and permanent: it survives the run
 * reaching a terminal state, so repeat calls keep returning the same handle. When
 * the workflow record is purged or swept by retention the mapping itself survives
 * (purge does not touch the `start-idem:` keyspace) but now points at a gone run;
 * a call with that spent key throws {@link IdempotencyKeyPurgedError} (mapped to
 * HTTP 409 over REST/JSON-RPC) rather than silently starting a new run.
 *
 * Both `LocalClient.start` and `HttpClient.start` forward `idempotencyKey` and
 * `searchAttributes` to the server, so single-execution semantics hold across
 * transports. Idempotent start requires a storage backend with `conditionalBatch`.
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
export interface StartOptions<TServices = unknown> {
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
  services?: TServices;
  /**
   * When `false`, `engine.start()` resolves only after the workflow has begun
   * executing (its generator has been driven its first turn), not merely after
   * the initial state is persisted. The default (`true`) returns a handle as
   * soon as state is written and queues execution onto a macrotask, so a caller
   * cannot assume the run is live without a round-trip. Use `defer: false` when a
   * caller — or a test — must rely on the run being live immediately after
   * `await engine.start(...)`. If the body throws on its first turn, `start()`
   * still resolves; observe the failure via `handle.result()`. Inline mode only;
   * throws at `engine.start()` under `workflowExecutionMode: 'worker'` or with a
   * delayed start (`startAt`/`startAfter`), neither of which has liveness to await.
   */
  defer?: boolean;
}

/**
 * Options accepted by `engine.start(type, input, options?)` — the shared
 * {@link StartOptions} plus the start-only `onTerminalConflict` policy.
 *
 * `onTerminalConflict` lives here, not on {@link StartOptions}, so it is
 * structurally rejected on every other start-like surface: `engine.startOrSignal`
 * (whose identity is the permanent at-most-once idempotency mapping),
 * `ctx.startChild` (which re-attaches to an existing run by id on replay), and the
 * REST/JSON-RPC transport (which keeps `weft.workflows.start` honestly
 * `destructive: false`). It is therefore an in-process `engine.start`-only policy.
 */
export interface StartWorkflowOptions<TServices = unknown> extends StartOptions<TServices> {
  /**
   * What `engine.start()` does when the supplied `id` already belongs to a run
   * that has reached a **terminal** state (`completed` | `failed` | `cancelled`
   * | `timed-out`). This is Weft's equivalent of Temporal's
   * `WorkflowIdReusePolicy.ALLOW_DUPLICATE`, for the common case of a periodic
   * job keyed by a stable id (e.g. `reconcile:installation-42`) whose previous
   * run has already finished.
   *
   * - `'error'` (default): preserve the existing contract — a duplicate id always
   *   throws {@link WorkflowAlreadyExistsError}, terminal or not.
   * - `'start-new'`: if the prior run under this id is terminal, purge it (while
   *   holding the in-process start reservation, the same teardown as
   *   `engine.purge`, sweeping every key the run owns) and start a fresh run in
   *   its place; if the prior run is still **non-terminal** (running/pending),
   *   throw {@link WorkflowAlreadyExistsError} unchanged — `'start-new'` never
   *   displaces a live run.
   *
   * Requires an explicit `id` (the policy only makes sense for a caller-chosen,
   * reusable id) and is mutually exclusive with `idempotencyKey` (whose mapping
   * is permanent and at-most-once — restarting under it would violate that
   * contract). The previous run's durable record is gone after a `'start-new'`
   * restart, so a {@link WorkflowHandle} held against the old id resolves to the
   * fresh run for every method (`result()`, `snapshot()`, status), because handles
   * are id-scoped, not run-attempt-scoped. The restart holds the same in-process
   * start reservation as a normal start, so two concurrent `'start-new'` calls for
   * one id cannot both win — the loser sees {@link WorkflowAlreadyExistsError}.
   */
  onTerminalConflict?: 'error' | 'start-new';
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
export interface EngineOptions<TServices = unknown> {
  storage?: WeftStorage;
  development?: boolean;
  serializer?: Serializer;
  retention?: RetentionPolicy;
  retentionSweepInterval?: Duration;
  retentionSweepBatchSize?: number;
  /**
   * Enable a best-effort, warn-only detector for a SECOND engine instance writing
   * to the same durable store — a smoke alarm for singleton misconfiguration (an
   * autoscaler above one replica, or overlapping rolling deploys). Default `false`.
   * This is **liveness, not fencing**: it never blocks boot, gates recovery, or
   * prevents duplicate execution — enforce one instance at the infrastructure layer
   * (one replica + a `Recreate` deploy, or a single systemd unit). When enabled,
   * each engine writes a periodic heartbeat and warns (`process.emitWarning`) when
   * it sees another instance's heartbeat advancing while it runs. The periodic
   * writes are an ongoing cost, so leave it off unless you want the backstop.
   */
  detectSecondInstance?: boolean;
  /**
   * Heartbeat interval for {@link EngineOptions.detectSecondInstance} (default
   * `15s`). A foreign heartbeat must advance across two intervals before warning,
   * so this also sets how long a deploy overlap must last before it warns — keep it
   * well above your deploy drain window. Ignored when detection is disabled.
   */
  secondInstanceHeartbeatInterval?: Duration;
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
   * Without a resolver, a recovered run that carries the durable "expects
   * services" marker fails before the generator advances and emits a diagnostic
   * warning naming this option.
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
  ) => WorkflowServicesResolution<TServices> | Promise<WorkflowServicesResolution<TServices>>;
}
