import type { WorkflowCompatibilityReason } from '../contract/compatibility.ts';

/**
 * Fired on the {@link Engine} when a `(name, revision)` is durably installed
 * into the workflow catalog for the first time. Never fired for a
 * byte-identical reinstall of an already-installed revision. Read
 * `e.workflowType` and `e.revision` directly off the event.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowRevisionInstalledEvent, workflow } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(WorkflowRevisionInstalledEvent.type, (event) => {
 *   console.log('installed:', event.workflowType, event.revision);
 * });
 * engine.register(workflow({ name: 'ping' }).execute(async function* () { return 'pong'; }));
 * ```
 */
export class WorkflowRevisionInstalledEvent extends Event {
  static readonly type = 'catalog:revision-installed' as const;
  readonly workflowType: string;
  readonly revision: string;

  constructor(workflowType: string, revision: string) {
    super(WorkflowRevisionInstalledEvent.type);
    this.workflowType = workflowType;
    this.revision = revision;
  }
}

/**
 * Fired on the {@link Engine} when a `(name, revision)` becomes the active
 * revision for its name — bumping the catalog's per-name `generation`
 * counter. `previousRevision` is `undefined` on a name's first-ever
 * activation, and set to the revision this activation replaced otherwise.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowRevisionActivatedEvent, workflow } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(WorkflowRevisionActivatedEvent.type, (event) => {
 *   console.log('activated:', event.workflowType, event.revision, 'gen', event.generation);
 * });
 * engine.register(workflow({ name: 'ping' }).execute(async function* () { return 'pong'; }));
 * ```
 */
export class WorkflowRevisionActivatedEvent extends Event {
  static readonly type = 'catalog:revision-activated' as const;
  readonly workflowType: string;
  readonly revision: string;
  readonly generation: number;
  readonly previousRevision: string | undefined;

  constructor(
    workflowType: string,
    revision: string,
    generation: number,
    previousRevision: string | undefined,
  ) {
    super(WorkflowRevisionActivatedEvent.type);
    this.workflowType = workflowType;
    this.revision = revision;
    this.generation = generation;
    this.previousRevision = previousRevision;
  }
}

/**
 * Fired on the {@link Engine} when a candidate activation
 * (`activateCatalogRevisionCandidate`, the guarded primitive) is refused.
 * `reason` is a closed, low-cardinality union safe to use as a metric label;
 * `incompatibilityReasons` is populated only when `reason === 'incompatible'`,
 * carrying every applicable {@link WorkflowCompatibilityReason} — never the
 * full compatibility verdict object.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowRevisionActivationRejectedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(WorkflowRevisionActivationRejectedEvent.type, (event) => {
 *   console.log('rejected:', event.workflowType, event.candidateRevision, event.reason);
 * });
 * ```
 */
export class WorkflowRevisionActivationRejectedEvent extends Event {
  static readonly type = 'catalog:activation-rejected' as const;
  readonly workflowType: string;
  readonly candidateRevision: string;
  readonly reason: 'incompatible' | 'stale-generation' | 'conflict';
  readonly incompatibilityReasons: readonly WorkflowCompatibilityReason[] | undefined;

  constructor(
    workflowType: string,
    candidateRevision: string,
    reason: 'incompatible' | 'stale-generation' | 'conflict',
    incompatibilityReasons?: readonly WorkflowCompatibilityReason[],
  ) {
    super(WorkflowRevisionActivationRejectedEvent.type);
    this.workflowType = workflowType;
    this.candidateRevision = candidateRevision;
    this.reason = reason;
    this.incompatibilityReasons = incompatibilityReasons;
  }
}

/**
 * Fired on the {@link Engine} alongside {@link WorkflowRevisionActivatedEvent}
 * when activating a new revision displaces a previously active one for the
 * same name. Never fired on a name's first-ever activation (there is
 * nothing to drain).
 *
 * @example
 * ```ts
 * import { Engine, WorkflowRevisionDrainingEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(WorkflowRevisionDrainingEvent.type, (event) => {
 *   console.log('draining:', event.workflowType, event.revision);
 * });
 * ```
 */
export class WorkflowRevisionDrainingEvent extends Event {
  static readonly type = 'catalog:revision-draining' as const;
  readonly workflowType: string;
  readonly revision: string;

  constructor(workflowType: string, revision: string) {
    super(WorkflowRevisionDrainingEvent.type);
    this.workflowType = workflowType;
    this.revision = revision;
  }
}

/**
 * Fired on the {@link Engine} when a `(name, revision)` is durably removed
 * from the workflow catalog via `removeWorkflowRevision`.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowRevisionRemovedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(WorkflowRevisionRemovedEvent.type, (event) => {
 *   console.log('removed:', event.workflowType, event.revision);
 * });
 * ```
 */
export class WorkflowRevisionRemovedEvent extends Event {
  static readonly type = 'catalog:revision-removed' as const;
  readonly workflowType: string;
  readonly revision: string;

  constructor(workflowType: string, revision: string) {
    super(WorkflowRevisionRemovedEvent.type);
    this.workflowType = workflowType;
    this.revision = revision;
  }
}
