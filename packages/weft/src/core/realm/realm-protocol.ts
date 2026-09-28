/**
 * Host/realm turn protocol envelope (COR-117).
 *
 * Every turn a host sends to an opt-in revision realm — and every result a
 * realm sends back — is fenced by four identifiers the host already knows
 * to expect. A realm process is not trusted just because a message arrived
 * on its channel: any one of these four disagreeing with what the host
 * expects means either a stale/misrouted message (a slow realm's answer to
 * a turn the host already gave up on) or a wire-level bug, and the host
 * must reject it rather than apply it to live workflow state.
 *
 * - `workflowRevision` — the exact immutable artifact revision the turn
 *   belongs to (the seam COR-249's per-revision pools will key on).
 * - `realmGeneration` — the realm instance's own identity, echoing the
 *   `realmGeneration` a realm reports in its {@link
 *   import('../worker-realm-readiness.ts').WorkerRealmReadyMessage}; a
 *   restarted (`Crashed` -> `Warming`) realm gets a fresh generation, so a
 *   message from the realm's previous incarnation is caught here even if
 *   the revision and workflow are otherwise unchanged.
 * - `executionToken` — the specific execution this turn belongs to, the
 *   same identity worn elsewhere in this package as
 *   `workflowExecutionToken` (see `src/worker/remote-activity-context.ts`).
 * - `turnId` — strictly increasing per execution, rejecting anything out of
 *   order the same way the existing generic Worker path's `#nextTurnId`
 *   does (`src/core/worker-execution-strategy.ts`).
 *
 * This module only defines the envelope shape and the comparison — it does
 * not send anything over any transport. {@link
 * import('./fake-realm.test-support.ts')} is the first (and, this slice,
 * only) thing that drives it.
 *
 * @module core/realm/realm-protocol
 */

/** The four identifiers every realm turn (and its result) must carry. */
export interface RealmTurnEnvelope {
  readonly workflowRevision: string;
  readonly realmGeneration: string;
  readonly executionToken: string;
  readonly turnId: number;
}

/** Which field of a {@link RealmTurnEnvelope} failed to match. */
export type RealmEnvelopeField = keyof RealmTurnEnvelope;

export type RealmEnvelopeValidation =
  | { ok: true }
  | {
      ok: false;
      mismatch: RealmEnvelopeField;
      expected: RealmTurnEnvelope[RealmEnvelopeField];
      received: RealmTurnEnvelope[RealmEnvelopeField];
    };

/**
 * Checked in this fixed order so two envelopes disagreeing on more than one
 * field always report the same mismatch, deterministically.
 */
const FIELD_CHECK_ORDER: readonly RealmEnvelopeField[] = [
  'workflowRevision',
  'realmGeneration',
  'executionToken',
  'turnId',
];

/**
 * Compare a received envelope against what the host expects. Returns the
 * first mismatching field, or `{ ok: true }` when all four agree.
 */
export function validateRealmTurnEnvelope(
  expected: RealmTurnEnvelope,
  received: RealmTurnEnvelope,
): RealmEnvelopeValidation {
  for (const field of FIELD_CHECK_ORDER) {
    if (expected[field] !== received[field]) {
      return { ok: false, mismatch: field, expected: expected[field], received: received[field] };
    }
  }
  return { ok: true };
}

/** Thrown by the fake realm (and, later, real adapters) when a turn envelope fails {@link validateRealmTurnEnvelope}. */
export class RealmEnvelopeMismatchError extends Error {
  constructor(public readonly validation: Extract<RealmEnvelopeValidation, { ok: false }>) {
    super(
      `Realm turn envelope mismatch on ${validation.mismatch}: expected ${String(validation.expected)}, received ${String(validation.received)}`,
    );
    this.name = 'RealmEnvelopeMismatchError';
  }
}
