import type { AtomicStateOptions } from '../atomic-state.ts';
import type { TenantContext } from '../tenant.ts';
import type { WorkflowVersionTuple } from '../workflow-version-tuple.ts';
import type { ActivityCallOptions } from './activity.ts';
import type { CheckpointState } from './checkpoint.ts';
import type { FailureCategory, WorkflowId, WorkflowStatus } from './identity.ts';
import type { WorkflowOperation } from './workflow-function.ts';

// ---------------------------------------------------------------------------
// Workflow state persisted in storage
// ---------------------------------------------------------------------------

/**
 * Snapshot of a workflow's persisted state.
 *
 * Returned by `handle.state()` and `engine.get(workflowId)`. Users observe
 * this shape — they don't construct it. Includes the input, current status,
 * tenant, attributes, retention policy snapshot, and lineage information,
 * plus `failureCategory` (populated on failed workflows), version tuple
 * metadata, `forkedFrom` lineage metadata, and the optional
 * `executionDeadline`/`terminalCleanupToken` housekeeping fields.
 */
export interface WorkflowState {
  id: WorkflowId;
  type: string;
  status: WorkflowStatus;
  tags?: string[];
  input: unknown;
  result?: unknown;
  error?: string;
  errorStack?: string;
  /**
   * Classifies why this workflow failed. Populated automatically on failure;
   * absent (`undefined`) on workflows that have not failed. `null` indicates
   * a failure occurred but the category could not be determined.
   *
   * Also indexed as a search attribute so callers can query via:
   * `engine.list({ attributes: [{ key: 'failureCategory', value: 'application' }] })`
   */
  failureCategory?: FailureCategory | null;
  version: string;
  /**
   * Owner identifier for execution-scoped durable state. Top-level workflows
   * own their own execution state; durable child workflows inherit the
   * parent's owner so `ctx.state.execution()` is shared across the execution
   * tree.
   */
  executionStateOwnerId?: string;
  /**
   * Legacy version tuple metadata retained so existing persisted workflow
   * states can still be decoded and compared during recovery.
   */
  agentVersion?: string;
  /**
   * Legacy version tuple metadata retained so existing persisted workflow
   * states can still be decoded and compared during recovery.
   */
  toolVersions?: string[];
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
  terminalCleanupToken?: string;
  executionDeadline?: number;
  /**
   * Optional {@link TenantContext} resolved at start time by the engine's
   * `tenantResolver`. Persisted here so it survives workflow recovery — the
   * field is only present on workflows started while a resolver was
   * configured and the resolver returned a value.
   */
  tenant?: TenantContext;
  /**
   * Lineage metadata recorded when this workflow was created by a fork from
   * another workflow checkpoint. Absent for workflows started normally.
   */
  forkedFrom?: ForkLineage;
}

/**
 * Lineage metadata recorded when a workflow was created by forking another
 * workflow at a checkpoint boundary. Absent on workflows started normally via
 * {@link Engine.start}. Available on {@link WorkflowState.forkedFrom}.
 */
export interface ForkLineage {
  workflowId: WorkflowId;
  step: number;
}

/**
 * Status of an individual entry in the workflow execution timeline. Mirrors
 * {@link WorkflowStatus} but scoped to a single timeline step rather than the
 * whole workflow. Used in {@link WorkflowTimelineEntry}.
 */
export type WorkflowTimelineStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out';

/**
 * A single chronological entry in a workflow's execution timeline, summarising
 * one operation (activity call, sleep, signal wait, etc.). Returned by
 * `engine.getTimeline(workflowId)` for replay and debugging.
 * The optional `versionTuple` field is populated only for entries produced by
 * versioned workflows and carries the version tuple captured at the time of
 * the operation.
 */
export type WorkflowTimelineEntry = {
  step: number;
  operationType: string;
  operationLabel: string;
  inputSummary: string;
  outputSummary?: string;
  duration?: number;
  timestamp: number;
  status: WorkflowTimelineStatus;
  versionTuple?: WorkflowVersionTuple;
};

/**
 * Options accepted by `ctx.state.session(key, options)`.
 */
export interface WorkflowSessionStateOptions<T> {
  /**
   * Value returned by `get()` before this session slot has been written.
   * The value is captured when the handle is constructed.
   */
  initial?: T;
}

/**
 * Typed per-workflow session state slot returned by `ctx.state.session(key)`.
 * Survives checkpoint recovery but is scoped to the current workflow instance.
 * Use `get` to read the current value, `set` or `update` to write, and `run`
 * to schedule a sticky durable activity that may need session-bound context.
 * `delete()` removes the stored value; subsequent `get()` returns the handle's
 * captured `initial` value if one was provided, otherwise `undefined`.
 * `run` schedules the function as a regular activity routed through sticky
 * worker execution. The function receives the single input value you pass to
 * `run(...)` — it cannot read the slot from inside. Read `session.get()`
 * before yielding the run if the function needs the current value.
 */
export interface WorkflowSessionState<T> {
  get(): T | undefined;
  set(value: T): T;
  update(updater: (current: T | undefined) => T): T;
  delete(): void;
  increment(this: WorkflowSessionState<number>, amount?: number): number;
  decrement(this: WorkflowSessionState<number>, amount?: number): number;
  merge<TObject extends Record<string, unknown>>(
    this: WorkflowSessionState<TObject>,
    patch: Partial<TObject>,
  ): TObject;
  append<TItem>(this: WorkflowSessionState<TItem[]>, item: TItem): TItem[];
  removeFirst<TItem>(this: WorkflowSessionState<TItem[]>): TItem | undefined;
  removeLast<TItem>(this: WorkflowSessionState<TItem[]>): TItem | undefined;
  run<TResult>(
    fn: () => Promise<TResult> | TResult,
    options?: ActivityCallOptions,
  ): WorkflowOperation<TResult>;
  run<TInput, TResult>(
    fn: (input: TInput) => Promise<TResult> | TResult,
    input: TInput,
    options?: ActivityCallOptions,
  ): WorkflowOperation<TResult>;
}

/**
 * Options accepted by storage-backed workflow state handles such as
 * `ctx.state.execution(key, options)`, `ctx.state.workflow(key, options)`,
 * and `ctx.state.tenant(key, options)`.
 *
 * @example
 * ```ts
 * import type { WorkflowAtomicStateOptions } from 'weft';
 *
 * const options: WorkflowAtomicStateOptions<number> = {
 *   initial: 0,
 *   maxRetries: 5,
 * };
 * void options;
 * ```
 */
export type WorkflowAtomicStateOptions<T> = Pick<AtomicStateOptions<T>, 'initial' | 'maxRetries'>;

/**
 * Typed storage-backed workflow state slot returned by durable
 * `ctx.state.*` factories.
 *
 * @example
 * ```ts
 * import type { WorkflowAtomicState } from 'weft';
 *
 * declare const counter: WorkflowAtomicState<number>;
 * const operation = counter.increment();
 * void operation;
 * ```
 */
export interface WorkflowAtomicState<T> {
  get(): WorkflowOperation<T | undefined>;
  set(value: T): WorkflowOperation<T>;
  update(updater: (current: T | undefined) => T): WorkflowOperation<T>;
  delete(): WorkflowOperation<void>;
  increment(this: WorkflowAtomicState<number>, amount?: number): WorkflowOperation<number>;
  decrement(this: WorkflowAtomicState<number>, amount?: number): WorkflowOperation<number>;
  merge<TObject extends Record<string, unknown>>(
    this: WorkflowAtomicState<TObject>,
    patch: Partial<TObject>,
  ): WorkflowOperation<TObject>;
  append<TItem>(this: WorkflowAtomicState<TItem[]>, item: TItem): WorkflowOperation<TItem[]>;
  removeFirst<TItem>(this: WorkflowAtomicState<TItem[]>): WorkflowOperation<TItem | undefined>;
  removeLast<TItem>(this: WorkflowAtomicState<TItem[]>): WorkflowOperation<TItem | undefined>;
  addEventListener(type: 'change' | 'conflict' | 'exhausted', listener: EventListener): void;
  removeEventListener(type: 'change' | 'conflict' | 'exhausted', listener: EventListener): void;
}

/**
 * State factory namespace exposed as `ctx.state` inside workflow code.
 *
 * @example
 * ```ts
 * import type { WorkflowStateNamespace } from 'weft';
 *
 * declare const state: WorkflowStateNamespace;
 * const session = state.session<number>('attempts', { initial: 0 });
 * const durable = state.execution<number>('branches', { initial: 0, maxRetries: 5 });
 * void session;
 * void durable;
 * ```
 */
export interface WorkflowStateNamespace {
  session<T>(key: string, options?: WorkflowSessionStateOptions<T>): WorkflowSessionState<T>;
  execution<T>(key: string, options?: WorkflowAtomicStateOptions<T>): WorkflowAtomicState<T>;
  workflow<T>(key: string, options?: WorkflowAtomicStateOptions<T>): WorkflowAtomicState<T>;
  tenant<T>(key: string, options?: WorkflowAtomicStateOptions<T>): WorkflowAtomicState<T>;
}

// ---------------------------------------------------------------------------
// Workflow summary (returned by list)
// ---------------------------------------------------------------------------

/**
 * Lightweight summary of a workflow returned by list operations. Contains
 * identity and lifecycle fields but not the full input, result, or checkpoint.
 * Use {@link Engine.get} to retrieve the complete {@link WorkflowState}. The
 * optional fields (`tenant`, `tenantId`, `executionDeadline`, and
 * `failureCategory`) are populated whenever the underlying `WorkflowState`
 * carries them. For failed workflows missing a state category, `failureCategory`
 * can also be backfilled from stored search attributes when list callers
 * explicitly request it. Notably absent from the summary: `input`, `result`,
 * `error`, and `forkedFrom` — fetch the full `WorkflowState` via
 * `engine.get(id)` to access those.
 */
export interface WorkflowSummary {
  id: WorkflowId;
  type: string;
  status: WorkflowStatus;
  tags?: string[];
  tenant?: TenantContext;
  version: string;
  createdAt: number;
  updatedAt: number;
  /** Resolved tenant identifier projected from `WorkflowState.tenant?.id`. */
  tenantId?: string;
  /** Execution deadline (ms epoch) if set on the workflow. */
  executionDeadline?: number;
  /** Failure category if set on the workflow state. */
  failureCategory?: FailureCategory;
}

// ---------------------------------------------------------------------------
// Workflow event (returned by engine.getEvents)
// ---------------------------------------------------------------------------

/**
 * Event entries returned by `engine.getEvents()` are stored records — use
 * `engine.addEventListener(type, handler)` with the typed `Event` subclasses
 * (e.g. `WorkflowCompletedEvent`) for live observation; the stored `data` map
 * is provided for replay/audit.
 */
export interface WorkflowEvent {
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

/**
 * Full replay package for a workflow step, combining the checkpoint state,
 * the accumulated operation results up to that step, and the event log.
 * Returned by `engine.replayTo(workflowId, step)` for time-travel debugging.
 */
export type WorkflowReplay = {
  checkpoint: CheckpointState;
  accumulatedResults: Array<[number, unknown]>;
  events: WorkflowEvent[];
};
