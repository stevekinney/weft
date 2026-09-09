import type { FailureCategory } from '../types/identity.ts';

type WorkflowSourceKind = import('../source/index.ts').WorkflowSourceKind;

/**
 * Fired on the {@link Engine} when a dynamic workflow source's single-flight
 * load for `(workflowType, revision)` starts — the loader is about to be
 * invoked. Never fired for a cache hit (an already-installed revision
 * `resolveWorkflowSource()` returns without invoking the loader).
 *
 * @example
 * ```ts
 * import { Engine, WorkflowSourceLoadStartedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(WorkflowSourceLoadStartedEvent.type, (event) => {
 *   console.log('loading:', event.workflowType, event.revision);
 * });
 * ```
 */
export class WorkflowSourceLoadStartedEvent extends Event {
  static readonly type = 'workflow-source:load-started' as const;
  readonly workflowType: string;
  readonly revision: string;
  readonly kind: WorkflowSourceKind;

  constructor(workflowType: string, revision: string, kind: WorkflowSourceKind) {
    super(WorkflowSourceLoadStartedEvent.type);
    this.workflowType = workflowType;
    this.revision = revision;
    this.kind = kind;
  }
}

/**
 * Fired on the {@link Engine} when a dynamic workflow source's load for
 * `(workflowType, revision)` completes successfully — the loader ran,
 * validation passed, and the manifest is durably installed.
 * `loadDurationMs` is measured via the engine's own injected clock.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowSourceLoadReadyEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(WorkflowSourceLoadReadyEvent.type, (event) => {
 *   console.log('ready:', event.workflowType, event.revision, event.loadDurationMs);
 * });
 * ```
 */
export class WorkflowSourceLoadReadyEvent extends Event {
  static readonly type = 'workflow-source:load-ready' as const;
  readonly workflowType: string;
  readonly revision: string;
  readonly kind: WorkflowSourceKind;
  readonly loadDurationMs: number;

  constructor(
    workflowType: string,
    revision: string,
    kind: WorkflowSourceKind,
    loadDurationMs: number,
  ) {
    super(WorkflowSourceLoadReadyEvent.type);
    this.workflowType = workflowType;
    this.revision = revision;
    this.kind = kind;
    this.loadDurationMs = loadDurationMs;
  }
}

/**
 * Fired on the {@link Engine} when a dynamic workflow source's load for
 * `(workflowType, revision)` fails — the loader threw, validation rejected
 * the loaded module, or the durable install failed. `failureCategory` is
 * the closed, low-cardinality {@link FailureCategory} classification, safe
 * to use as a metric label; the underlying error itself is never included.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowSourceLoadFailedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(WorkflowSourceLoadFailedEvent.type, (event) => {
 *   console.log('failed:', event.workflowType, event.revision, event.failureCategory);
 * });
 * ```
 */
export class WorkflowSourceLoadFailedEvent extends Event {
  static readonly type = 'workflow-source:load-failed' as const;
  readonly workflowType: string;
  readonly revision: string;
  readonly kind: WorkflowSourceKind;
  readonly loadDurationMs: number;
  readonly failureCategory: FailureCategory;

  constructor(
    workflowType: string,
    revision: string,
    kind: WorkflowSourceKind,
    loadDurationMs: number,
    failureCategory: FailureCategory,
  ) {
    super(WorkflowSourceLoadFailedEvent.type);
    this.workflowType = workflowType;
    this.revision = revision;
    this.kind = kind;
    this.loadDurationMs = loadDurationMs;
    this.failureCategory = failureCategory;
  }
}

/**
 * Fired on the {@link Engine} when the LAST outstanding
 * `resolveWorkflowSource()` waiter for `(workflowType, revision)` releases
 * (its own abort, or engine disposal) while the shared load is still
 * unsettled. The shared load itself is never aborted — a fresh caller
 * starting a new attempt for the same key re-fires
 * {@link WorkflowSourceLoadStartedEvent}, not this event again for the
 * orphaned attempt.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowSourceLoadCancelledEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(WorkflowSourceLoadCancelledEvent.type, (event) => {
 *   console.log('cancelled:', event.workflowType, event.revision);
 * });
 * ```
 */
export class WorkflowSourceLoadCancelledEvent extends Event {
  static readonly type = 'workflow-source:load-cancelled' as const;
  readonly workflowType: string;
  readonly revision: string;
  readonly kind: WorkflowSourceKind;

  constructor(workflowType: string, revision: string, kind: WorkflowSourceKind) {
    super(WorkflowSourceLoadCancelledEvent.type);
    this.workflowType = workflowType;
    this.revision = revision;
    this.kind = kind;
  }
}
