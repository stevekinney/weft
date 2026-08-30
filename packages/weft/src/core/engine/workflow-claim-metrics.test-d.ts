/**
 * Type-level pin for the hard constraint in ADR 0002 § Observability: a
 * workflow id must be impossible to pass as a claim-metrics label, not merely
 * discouraged. `WorkflowClaimMetricsRecorder.recordClaimAttempt` only accepts
 * the closed {@link WorkflowClaimAttemptOutcome} union — an arbitrary
 * `string` such as a workflow id is not a member of that union, so passing
 * one must fail to typecheck. Checked with `bun run typecheck:tests`.
 */
import {
  WorkflowClaimMetricsCollector,
  type WorkflowClaimAttemptOutcome,
  type WorkflowClaimMetricsRecorder,
} from './workflow-claim-metrics.ts';

const collector = new WorkflowClaimMetricsCollector();
const recorder: WorkflowClaimMetricsRecorder = collector;

// Every real outcome type-checks …
recorder.recordClaimAttempt('acquired');
recorder.recordClaimAttempt('takeover');
recorder.recordClaimAttempt('lost_race');
recorder.recordClaimAttempt('deposed');
recorder.recordClaimAttempt('backoff_skipped');

// … but an arbitrary workflow id — a plain `string`, exactly the shape of a
// real workflow id such as `crypto.randomUUID()` or a caller-supplied id — is
// not assignable to the closed outcome union.
declare const workflowId: string;
// @ts-expect-error a workflow id (arbitrary string) is not a WorkflowClaimAttemptOutcome.
recorder.recordClaimAttempt(workflowId);

// A literal string that merely looks like it could be a workflow id is
// rejected the same way, proving the union is closed rather than widened to
// `string` anywhere along the interface.
// @ts-expect-error 'workflow-123' is not one of the five fixed outcome literals.
recorder.recordClaimAttempt('workflow-123');

// A near-miss on casing/spelling is also rejected — the union is exact, not
// merely "contains a substring of one of the five values".
// @ts-expect-error 'lost-race' (hyphen) is not 'lost_race' (underscore).
recorder.recordClaimAttempt('lost-race');

// The outcome type itself cannot be widened back to `string` at the call
// site either.
declare const outcome: WorkflowClaimAttemptOutcome;
const asString: string = outcome;
void asString;
