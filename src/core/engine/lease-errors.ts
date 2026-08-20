import { WeftError } from '../weft-error.ts';
import type { FencingOwnershipMode } from './workflow-claim-codec.ts';

/**
 * Thrown when `ownership: 'lease'` is configured and the engine cannot acquire the
 * storage lease within the configured wait window — another live instance still
 * holds it. Raised from the lease-acquire step, which runs both inside
 * {@link Engine.create} and at the top of {@link Engine.recoverAll} (so a
 * `new Engine({ ownership: 'lease' })` + `recoverAll()` boot must handle it too).
 * In a rolling deploy this means the
 * outgoing instance has not released the lease (or its lease has not yet expired)
 * within `leaseWaitTimeout`; size that window above the outgoing instance's drain
 * time and above the lease TTL so a crash (no clean release) still resolves once
 * the held lease expires. Inspect `waitedMs` for how long this instance waited
 * and `heldBy` for the holder id observed when it gave up (`null` if unknown).
 *
 * @example
 * ```ts
 * import { EngineLeaseAcquisitionTimeoutError } from '@lostgradient/weft';
 *
 * function isLeaseHandoffStuck(error: unknown): boolean {
 *   return error instanceof EngineLeaseAcquisitionTimeoutError;
 * }
 * ```
 */
export class EngineLeaseAcquisitionTimeoutError extends WeftError<'EngineLeaseAcquisitionTimeoutError'> {
  readonly waitedMs: number;
  readonly heldBy: string | null;

  constructor(waitedMs: number, heldBy: string | null) {
    const heldClause = heldBy === null ? '' : ` (currently held by "${heldBy}")`;
    super(
      'EngineLeaseAcquisitionTimeoutError',
      `Could not acquire the storage ownership lease within ${waitedMs}ms${heldClause}. ` +
        'Another engine instance still holds it. Increase leaseWaitTimeout above the outgoing ' +
        "instance's drain time and the lease TTL, or ensure the previous instance releases the lease on shutdown.",
    );
    this.waitedMs = waitedMs;
    this.heldBy = heldBy;
  }
}

/**
 * Thrown when `ownership: 'lease'` is configured but the lease keys in storage are
 * corrupt. Raised from the lease-acquire step, which runs both inside
 * {@link Engine.create} and at the top of {@link Engine.recoverAll} (so a
 * `new Engine({ ownership: 'lease' })` + `recoverAll()` boot must handle it too) —
 * the `lease:epoch` high-water mark is present
 * but does not decode to a valid epoch, or a holder record exists with no epoch
 * key (which the lease protocol never produces, since `release()` deletes only the
 * holder and never the epoch). The lease epoch is the sole source of truth for the
 * monotonic fencing generation, so a booting instance fails closed rather than
 * re-minting a generation at or below the true high-water mark and risking a
 * split-brain. Resolve by operator repair: delete both `lease:` keys only if you
 * are certain no other instance is running, or reset `lease:epoch` above its last
 * known value.
 *
 * @example
 * ```ts
 * import { EngineLeaseCorruptedError } from '@lostgradient/weft';
 *
 * function isLeaseCorrupted(error: unknown): boolean {
 *   return error instanceof EngineLeaseCorruptedError;
 * }
 * ```
 */
export class EngineLeaseCorruptedError extends WeftError<'EngineLeaseCorruptedError'> {
  constructor(detail: string) {
    super(
      'EngineLeaseCorruptedError',
      `The ownership lease state in storage is corrupt and cannot be used safely: ${detail}. ` +
        'Resolve by operator repair (delete both "lease:" keys only if no other instance is ' +
        'running, or reset "lease:epoch" above its last known value).',
    );
  }
}

/**
 * Thrown by {@link Engine.start} and {@link Engine.startOrSignal} when
 * `ownership: 'lease'` is configured but the engine does not yet hold the lease —
 * it was constructed with `new Engine({ ownership: 'lease' })` and used to start
 * work before `recoverAll()` ran, or created with `recover: false`. In lease mode
 * an engine must hold the single-writer lease (and have recovered existing runs)
 * before it durably writes new workflow state, or a fresh start could race an
 * instance that legitimately owns the store. {@link Engine.create} acquires the
 * lease and recovers for you; a direct constructor must `await engine.recoverAll()`
 * first.
 *
 * @example
 * ```ts
 * import { Engine, EngineLeaseNotHeldError } from '@lostgradient/weft';
 *
 * const engine = new Engine({ ownership: 'lease' });
 * try {
 *   await engine.start('ping', null);
 * } catch (error) {
 *   if (error instanceof EngineLeaseNotHeldError) {
 *     await engine.recoverAll(); // acquires the lease, then retry the start
 *   }
 * }
 * ```
 */
export class EngineLeaseNotHeldError extends WeftError<'EngineLeaseNotHeldError'> {
  constructor() {
    super(
      'EngineLeaseNotHeldError',
      "ownership: 'lease' requires the engine to hold the lease before starting work. " +
        'Use `Engine.create({ ownership: "lease" })` (which acquires the lease and recovers), ' +
        'or call `await engine.recoverAll()` on a directly-constructed engine before `start()`.',
    );
  }
}

/**
 * Thrown internally on the durable-write path when either fencing `ownership`
 * mode is configured and a fenced write's CAS fails because the held epoch is
 * stale — a successor instance has taken over, so this instance has been
 * deposed. It is the local unwind that stops the commit from advancing
 * in-memory state past a durable write that did not land; the actual "this
 * engine is deposed" reaction (set the `deposed` flag, warn the operator, tear
 * the engine down) is driven by {@link handleDeposition} at the detection
 * site, not by this error propagating — the inline strategy swallows turn
 * rejections, so the throw never reaches a handler. Internal-only: it is never
 * surfaced to user code (deposition reaches operators through the
 * `WeftEngineLeaseLostWarning` process warning, or, under `workflow-lease`,
 * through `WeftWorkflowClaimLostWarning`).
 *
 * `workflowId` is additive: under the global `ownership: 'lease'` mode
 * deposition is store-wide and no single workflow is implicated, so existing
 * call sites that construct `new EngineDeposedError()` with no argument keep
 * working unchanged. Under `ownership: 'workflow-lease'`, deposition is scoped
 * to one workflow's fenced epoch, so callers on that path supply the id and it
 * folds into the message.
 */
export class EngineDeposedError extends WeftError<'EngineDeposedError'> {
  readonly workflowId: string | undefined;

  constructor(workflowId?: string) {
    const scopeClause =
      workflowId === undefined
        ? 'another instance now holds the ownership lease at a newer epoch'
        : `another engine now holds workflow "${workflowId}"'s ownership claim at a newer epoch`;
    super(
      'EngineDeposedError',
      `Engine was deposed: a fenced durable write lost its CAS race because ${scopeClause}. ` +
        'This engine is halting.',
    );
    this.workflowId = workflowId;
  }
}

/**
 * Thrown when an explicit, single-workflow public API — {@link Engine.resume},
 * or a per-workflow step inside a bulk operation — loses the `acquire`,
 * `takeover`, or standalone-resume CAS for a workflow's ownership claim under
 * `ownership: 'workflow-lease'`, because another engine still holds a live,
 * unexpired claim on it. Never thrown from background scanning: `recoverAll`
 * and the scheduler tick isolate the loss to that one workflow and continue
 * with the rest of the sweep, exactly as a background scan skips a workflow it
 * cannot acquire rather than failing the whole pass.
 *
 * Like the other lease errors in this module, this does not carry a stable
 * {@link WeftErrorCode} — match by `instanceof` rather than `.code`.
 *
 * @example
 * ```ts
 * import { WorkflowClaimUnavailableError } from '@lostgradient/weft';
 *
 * function isClaimContested(error: unknown): boolean {
 *   return error instanceof WorkflowClaimUnavailableError;
 * }
 * ```
 */
export class WorkflowClaimUnavailableError extends WeftError<'WorkflowClaimUnavailableError'> {
  readonly workflowId: string;
  readonly heldBy: string | null;

  constructor(workflowId: string, heldBy: string | null) {
    const heldClause = heldBy === null ? '' : ` (currently held by "${heldBy}")`;
    super(
      'WorkflowClaimUnavailableError',
      `Could not acquire the ownership claim for workflow "${workflowId}"${heldClause}. ` +
        'Another engine still holds a live, unexpired claim for it. Retry later, or investigate ' +
        'whether the holding engine has crashed without releasing (it will become eligible for ' +
        'takeover once its claim expires).',
    );
    this.workflowId = workflowId;
    this.heldBy = heldBy;
  }
}

/**
 * Thrown at engine construction when Gate 2 (the store-wide
 * `ownership-mode-marker` check) finds the store already stamped with a
 * different fencing mode than this engine is configured with. Fired
 * immediately after Gate 1 (storage `conditionalBatch` capability) passes, for
 * `ownership: 'lease'` or `ownership: 'workflow-lease'` — `ownership: 'none'`
 * engines never touch the marker. Raised before `recoverAll()` or any storage
 * write beyond the marker read/CAS attempt, so construction fails closed
 * rather than letting two incompatible fencing modes coexist against one
 * store.
 *
 * Unlike the other lease errors in this module, this one DOES carry a stable
 * {@link WeftErrorCode} — it is a configuration-time boot blocker an operator
 * needs to route and alert on, not an internal fencing unwind.
 *
 * @example
 * ```ts
 * import { OwnershipModeMismatchError } from '@lostgradient/weft';
 *
 * function describeMismatch(error: OwnershipModeMismatchError): string {
 *   return `configured "${error.configuredMode}" but store is "${error.storedMode}" ` +
 *     `(established ${new Date(error.establishedAt).toISOString()})`;
 * }
 * ```
 */
export class OwnershipModeMismatchError extends WeftError<'OwnershipModeMismatchError'> {
  /** This engine's configured `ownership` option. */
  readonly configuredMode: FencingOwnershipMode;
  /** The fencing mode read from the store's `ownership-mode-marker`. */
  readonly storedMode: FencingOwnershipMode;
  /** The marker's `establishedAt` timestamp, for diagnosing when the mismatch was introduced. */
  readonly establishedAt: number;

  constructor(
    configuredMode: FencingOwnershipMode,
    storedMode: FencingOwnershipMode,
    establishedAt: number,
  ) {
    super(
      'OwnershipModeMismatchError',
      `This engine is configured with ownership: '${configuredMode}', but the store's ` +
        `ownership-mode-marker records '${storedMode}' (established at ` +
        `${new Date(establishedAt).toISOString()}). Every engine sharing a store under a fencing ` +
        'mode must agree on that mode. Stop every engine pointed at this store, pick one mode, ' +
        'and restart them all — mixing modes against one store is unsafe.',
    );
    this.configuredMode = configuredMode;
    this.storedMode = storedMode;
    this.establishedAt = establishedAt;
  }
}
