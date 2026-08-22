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
 * **Curve.** Exponential, starting at `workflowClaimRenewInterval` and capped
 * at `workflowClaimTtl * WORKFLOW_CLAIM_TAKEOVER_COOLDOWN_CAP_MULTIPLIER`
 * (ADR proposal; the exact curve is an open question there). Each
 * {@link recordDeposition} call doubles the previous window instead of
 * restarting it — through `WorkflowClaimRegistry`'s real call graph a second
 * deposition for the same id is only reachable after an intervening
 * successful (re)acquire has already cleared the cooldown, so doubling does
 * not compound in practice today; it is implemented and unit-tested here
 * directly against the tracker so the shape is correct if a future stage
 * changes that call graph.
 *
 * @module core/engine/workflow-claim-cooldown
 */

/** `workflowClaimTtl` times this multiplier is the cooldown's cap. */
export const WORKFLOW_CLAIM_TAKEOVER_COOLDOWN_CAP_MULTIPLIER = 4;

/** Options for {@link WorkflowClaimTakeoverCooldown}. Mirrors `WorkflowClaimRegistryOptions`'s same-named fields, so the caller need not compute the cap itself. */
export type WorkflowClaimTakeoverCooldownOptions = {
  /** Cooldown's starting window (ms) — `workflowClaimRenewInterval`. */
  claimRenewIntervalMs: number;
  /** `workflowClaimTtl` (ms); scaled by {@link WORKFLOW_CLAIM_TAKEOVER_COOLDOWN_CAP_MULTIPLIER} for the cap. */
  claimTtlMs: number;
};

type CooldownEntry = { untilMs: number; windowMs: number };

/**
 * Tracks one engine's per-workflow-id takeover cooldown. See the module doc
 * for the mechanism and curve.
 */
export class WorkflowClaimTakeoverCooldown {
  readonly #baseMs: number;
  readonly #capMs: number;
  readonly #entries = new Map<string, CooldownEntry>();

  constructor(options: WorkflowClaimTakeoverCooldownOptions) {
    this.#baseMs = options.claimRenewIntervalMs;
    this.#capMs = options.claimTtlMs * WORKFLOW_CLAIM_TAKEOVER_COOLDOWN_CAP_MULTIPLIER;
  }

  /**
   * Whether `workflowId` is currently within its cooldown window at `now`.
   * The boundary itself (`now === untilMs`) is NOT active — matches
   * `isWorkflowClaimExpired`'s "strictly earlier" convention for the sibling
   * expiry judgment.
   */
  isActive(workflowId: string, now: number): boolean {
    const entry = this.#entries.get(workflowId);
    return entry !== undefined && now < entry.untilMs;
  }

  /**
   * Record that this engine just lost ownership of `workflowId` via a failed
   * `renew`. Starts a fresh window at `baseMs` when none is tracked yet, or
   * doubles the previous window (capped at `capMs`) when one already is.
   */
  recordDeposition(workflowId: string, now: number): void {
    const existing = this.#entries.get(workflowId);
    const windowMs =
      existing === undefined ? this.#baseMs : Math.min(existing.windowMs * 2, this.#capMs);
    this.#entries.set(workflowId, { untilMs: now + windowMs, windowMs });
  }

  /** Clear any tracked cooldown for `workflowId` — call on a successful (re)acquire or takeover. */
  clear(workflowId: string): void {
    this.#entries.delete(workflowId);
  }
}
