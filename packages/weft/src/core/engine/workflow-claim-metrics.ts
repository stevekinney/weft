/**
 * Bounded-cardinality observability recorder for the `ownership: 'workflow-lease'`
 * per-workflow claim protocol described in
 * [ADR 0002 § Observability](../../../documentation/contributing/architecture-decisions/0002-multiengine-per-workflow-ownership.md#observability).
 *
 * This module is a standalone recorder, not wired into
 * `src/observability/metrics.ts`/`metrics-catalog.ts` — those files already
 * document a "keeping this as an interface" plug-point idiom for exactly this
 * situation (see `PrometheusExporter` there), and the existing `METRICS`
 * catalogue and `MetricsCollector` have no concept of a labelled series at
 * all: every entry is a flat, unlabelled name. Folding `outcome` into that
 * shape would require editing `metrics-catalog.ts` and `metrics.ts`, which is
 * out of scope for this stage (see the module-level follow-up note below).
 * Instead this module defines the same three signals as a small, injectable,
 * structurally-typed recorder that a later stage can either back the existing
 * exporter with directly, or bridge into `MetricsCollector` by fanning
 * `snapshot().attempts` out into five unlabelled counter names.
 *
 * The ADR states twice that workflow ids are never Prometheus metric labels.
 * That is enforced here at the type level, not by convention: the only value
 * {@link WorkflowClaimMetricsRecorder.recordClaimAttempt} accepts is
 * {@link WorkflowClaimAttemptOutcome}, a closed union of exactly five string
 * literals. A workflow id — an arbitrary `string` — is not a member of that
 * union, so passing one is a compile error, not a runtime cardinality bug
 * waiting to happen. See `workflow-claim-metrics.test-d.ts` for the pinned
 * proof.
 *
 * **Follow-up (not built here):** wiring this recorder's snapshot into the
 * server's `/v1/metrics` `PrometheusExporter` (`src/observability/metrics.ts`)
 * requires editing that file, which is owned by a different in-flight patch
 * for this stage. {@link WorkflowClaimMetricsRecorder} is deliberately
 * structural so that wiring can happen later without reshaping this module.
 *
 * @module core/engine/workflow-claim-metrics
 */

/**
 * The exact, closed set of outcomes {@link WorkflowClaimMetricsRecorder.recordClaimAttempt}
 * accepts. Matches `weft_workflow_claim_attempts_total`'s `outcome` label
 * value set in ADR 0002 § Observability — five fixed values, nothing else.
 */
export type WorkflowClaimAttemptOutcome =
  | 'acquired'
  | 'takeover'
  | 'lost_race'
  | 'deposed'
  | 'backoff_skipped';

/**
 * Every {@link WorkflowClaimAttemptOutcome} value, in declaration order. The
 * single source of truth for the label's cardinality bound — both the
 * recorder's internal counter map and the Prometheus serializer iterate this
 * tuple rather than re-listing the five values.
 */
export const WORKFLOW_CLAIM_ATTEMPT_OUTCOMES = [
  'acquired',
  'takeover',
  'lost_race',
  'deposed',
  'backoff_skipped',
] as const satisfies readonly WorkflowClaimAttemptOutcome[];

/** One count per {@link WorkflowClaimAttemptOutcome}, always present (zero-filled when never recorded). */
export type WorkflowClaimAttemptCounts = Readonly<Record<WorkflowClaimAttemptOutcome, number>>;

/** A point-in-time read of everything this module tracks. */
export type WorkflowClaimMetricsSnapshot = {
  /** Per-outcome attempt counts. Mirrors `weft_workflow_claim_attempts_total{outcome="..."}`. */
  attempts: WorkflowClaimAttemptCounts;
  /** Mirrors `weft_workflow_claims_active` — workflows this engine currently holds a claim for. */
  activeClaims: number;
  /** Mirrors `weft_workflow_claim_renewal_failures_total`. */
  renewalFailures: number;
};

/**
 * Structural recorder interface for the three ADR 0002 observability signals.
 * Defined as an interface — not just the concrete {@link WorkflowClaimMetricsCollector}
 * class — so a caller can satisfy it with any implementation (a bridge into
 * `MetricsCollector`, an OpenTelemetry adapter, a test double) without
 * depending on this module's storage choices.
 *
 * `recordClaimAttempt`'s parameter type is the whole point of this interface:
 * it is impossible to express "pass a workflow id here" without a type error,
 * because the parameter is {@link WorkflowClaimAttemptOutcome}, not `string`.
 */
export interface WorkflowClaimMetricsRecorder {
  /** Record one claim-attempt outcome. Increments only that outcome's series. */
  recordClaimAttempt(outcome: WorkflowClaimAttemptOutcome): void;
  /**
   * Set the absolute count of workflows this engine currently holds a claim
   * for. An absolute set (not a delta), matching the existing
   * `MetricsCollector.gauge()` idiom in `src/observability/metrics.ts`. Must
   * be a safe, non-negative integer.
   */
  setActiveClaims(count: number): void;
  /** Record one renewal-failure occurrence. */
  recordClaimRenewalFailure(): void;
}

function assertSafeNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `${label} must be a safe, non-negative integer; received ${String(value)}`,
    );
  }
}

function zeroFilledAttemptCounts(): Record<WorkflowClaimAttemptOutcome, number> {
  // The cast bridges the empty-object literal to the fully-keyed record type
  // before the loop below has populated every key. The alternative — an
  // object literal listing all five outcome keys by hand — would duplicate
  // WORKFLOW_CLAIM_ATTEMPT_OUTCOMES, the single source of truth this module
  // relies on to keep the label's cardinality bounded at exactly five.
  const counts = {} as Record<WorkflowClaimAttemptOutcome, number>;
  for (const outcome of WORKFLOW_CLAIM_ATTEMPT_OUTCOMES) {
    counts[outcome] = 0;
  }
  return counts;
}

/**
 * In-memory implementation of {@link WorkflowClaimMetricsRecorder}, one per
 * engine process — matching the ADR's "single counter/gauge per engine
 * process" cardinality note for these three signals.
 *
 * @example
 * ```ts
 * import { WorkflowClaimMetricsCollector } from './workflow-claim-metrics.ts';
 *
 * const collector = new WorkflowClaimMetricsCollector();
 * collector.recordClaimAttempt('acquired');
 * collector.setActiveClaims(1);
 * console.log(collector.snapshot().attempts.acquired); // 1
 * ```
 */
export class WorkflowClaimMetricsCollector implements WorkflowClaimMetricsRecorder {
  #attempts: Record<WorkflowClaimAttemptOutcome, number>;
  #activeClaims: number;
  #renewalFailures: number;

  constructor() {
    this.#attempts = zeroFilledAttemptCounts();
    this.#activeClaims = 0;
    this.#renewalFailures = 0;
  }

  recordClaimAttempt(outcome: WorkflowClaimAttemptOutcome): void {
    this.#attempts[outcome] += 1;
  }

  setActiveClaims(count: number): void {
    assertSafeNonNegativeInteger(count, 'activeClaims');
    this.#activeClaims = count;
  }

  recordClaimRenewalFailure(): void {
    this.#renewalFailures += 1;
  }

  /** Return a point-in-time snapshot of all three signals. */
  snapshot(): WorkflowClaimMetricsSnapshot {
    return {
      attempts: { ...this.#attempts },
      activeClaims: this.#activeClaims,
      renewalFailures: this.#renewalFailures,
    };
  }

  /** Clear all collected values back to zero. */
  reset(): void {
    this.#attempts = zeroFilledAttemptCounts();
    this.#activeClaims = 0;
    this.#renewalFailures = 0;
  }
}

/**
 * Serialize a {@link WorkflowClaimMetricsSnapshot} as Prometheus text format,
 * using the exact metric names ADR 0002 § Observability specifies. Every
 * outcome always emits a line — including zero-valued ones — so a scraper
 * sees a stable schema regardless of which outcomes have occurred yet,
 * matching the stable-schema behavior of
 * `serializeMetricsSnapshotForPrometheus` in `src/observability/metrics.ts`.
 *
 * @example
 * ```ts
 * import {
 *   WorkflowClaimMetricsCollector,
 *   serializeWorkflowClaimMetricsForPrometheus,
 * } from './workflow-claim-metrics.ts';
 *
 * const collector = new WorkflowClaimMetricsCollector();
 * collector.recordClaimAttempt('acquired');
 * const body = serializeWorkflowClaimMetricsForPrometheus(collector.snapshot());
 * console.log(body.includes('weft_workflow_claim_attempts_total{outcome="acquired"} 1'));
 * ```
 */
export function serializeWorkflowClaimMetricsForPrometheus(
  snapshot: WorkflowClaimMetricsSnapshot,
): string {
  const lines: string[] = [
    '# HELP weft_workflow_claim_attempts_total Total per-workflow ownership claim attempts, by outcome',
    '# TYPE weft_workflow_claim_attempts_total counter',
  ];
  for (const outcome of WORKFLOW_CLAIM_ATTEMPT_OUTCOMES) {
    lines.push(
      `weft_workflow_claim_attempts_total{outcome="${outcome}"} ${snapshot.attempts[outcome]}`,
    );
  }
  lines.push(
    '# HELP weft_workflow_claims_active Workflows this engine currently holds a claim for',
    '# TYPE weft_workflow_claims_active gauge',
    `weft_workflow_claims_active ${snapshot.activeClaims}`,
    '# HELP weft_workflow_claim_renewal_failures_total Total per-workflow claim renewal failures',
    '# TYPE weft_workflow_claim_renewal_failures_total counter',
    `weft_workflow_claim_renewal_failures_total ${snapshot.renewalFailures}`,
  );
  return lines.join('\n') + '\n';
}
