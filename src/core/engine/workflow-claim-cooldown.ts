/**
 * Per-workflow-id anti-thrash takeover cooldown, specified in
 * [ADR 0002 § Ownership transitions](../../../documentation/contributing/architecture-decisions/0002-multiengine-per-workflow-ownership.md#ownership-transitions)
 * (the `takeover` row's "A per-workflow-id anti-thrash cooldown" sentence).
 *
 * **The problem this dampens.** Without it, a reclaim scan and the engine
 * that just lost a claim can thrash: this engine loses `workflowId` via a
 * failed `renew`, its own recurring reclaim scan later judges the same
 * holder stale (a genuine race — the deposing engine can itself stall or
 * crash right after depositing this one), and this engine immediately steals
 * it back, only to lose it again the same way. The cooldown makes that loop
 * back off instead of spinning.
 *
 * **Shape.** In-memory, per-engine-process, keyed by workflow id — not
 * durable and not shared across engines; a restart forgets every cooldown,
 * which is safe, since a fresh process has not just been deposed from
 * anything yet. `WorkflowClaimRegistry` owns one instance and drives it from
 * exactly three points: a failed `renew` calls {@link recordDeposition}, a
 * successful `acquire`/`takeover`/folded-acquire calls {@link clear}, and
 * `takeover` consults {@link isActive} before attempting its CAS.
 *
 * **Curve.** A fixed window of `workflowClaimRenewInterval`, not exponential.
 * Through `WorkflowClaimRegistry`'s real call graph, a second
 * `recordDeposition` for the same id is only reachable after an intervening
 * successful (re)acquire has already {@link clear}ed the tracked entry — this
 * class never observes consecutive depositions for the same id without a
 * clear between them, so a growing window would never actually grow. An
 * exponential curve was tried here and found unreachable in review; keep this
 * simple until a call-graph change (preserving loss history across successful
 * reacquisition) makes a growing window meaningful.
 *
 * @module core/engine/workflow-claim-cooldown
 */

/** Options for {@link WorkflowClaimTakeoverCooldown}. Mirrors `WorkflowClaimRegistryOptions`'s same-named field, so the caller need not compute the window itself. */
export type WorkflowClaimTakeoverCooldownOptions = {
  /** Cooldown window (ms) — `workflowClaimRenewInterval`. */
  claimRenewIntervalMs: number;
};

/**
 * Tracks one engine's per-workflow-id takeover cooldown. See the module doc
 * for the mechanism and curve.
 */
export class WorkflowClaimTakeoverCooldown {
  readonly #windowMs: number;
  readonly #untilMsByWorkflowId = new Map<string, number>();

  constructor(options: WorkflowClaimTakeoverCooldownOptions) {
    this.#windowMs = options.claimRenewIntervalMs;
  }

  /**
   * Whether `workflowId` is currently within its cooldown window at `now`.
   * The boundary itself (`now === untilMs`) is NOT active — matches
   * `isWorkflowClaimExpired`'s "strictly earlier" convention for the sibling
   * expiry judgment.
   */
  isActive(workflowId: string, now: number): boolean {
    const untilMs = this.#untilMsByWorkflowId.get(workflowId);
    return untilMs !== undefined && now < untilMs;
  }

  /**
   * Record that this engine just lost ownership of `workflowId` via a failed
   * `renew`. Starts (or restarts) a fixed-length cooldown window.
   */
  recordDeposition(workflowId: string, now: number): void {
    this.#untilMsByWorkflowId.set(workflowId, now + this.#windowMs);
  }

  /** Clear any tracked cooldown for `workflowId` — call on a successful (re)acquire or takeover. */
  clear(workflowId: string): void {
    this.#untilMsByWorkflowId.delete(workflowId);
  }
}
