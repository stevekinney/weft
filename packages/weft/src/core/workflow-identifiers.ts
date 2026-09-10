const MAX_WORKFLOW_ID_LENGTH = 128;

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if ((codePoint >= 0x00 && codePoint <= 0x1f) || codePoint === 0x7f) {
      return true;
    }
  }

  return false;
}

/**
 * Assert every workflow-id constraint that predates WFT-95: a string,
 * non-empty, at most {@link MAX_WORKFLOW_ID_LENGTH} characters, and free of
 * control characters. Deliberately does NOT reject the exact strings `.` or
 * `..` — those were valid workflow ids before WFT-95 and may already be
 * durably persisted (a schedule id, a persisted `currentWorkflowId`, a
 * queued run's `workflowId`, schedule-run metadata, an `executionStateOwnerId`
 * or `parentWorkflowId`/`restartedFrom.workflowId` on a decoded
 * `WorkflowState`). Decode and schedule-control (lookup, pause, resume,
 * cancel, update) paths must keep accepting them so an upgrade doesn't
 * strand pre-existing data or make a pre-existing schedule/workflow
 * unmanageable; only fresh admission ({@link assertValidWorkflowId}) adds
 * the `.`/`..` rejection.
 *
 * Takes `unknown`, not `string` (WFT-95 review): every caller passes an
 * already-decoded field whose static `WorkflowState`/`ScheduleState` type
 * says `string` but whose runtime shape is untrusted — the storage record
 * could be corrupted. Without an explicit `typeof` guard here, a decoded
 * array of strings would pass (`.length`, iteration, and
 * `containsControlCharacter()`'s per-element `codePointAt()` all succeed on
 * an array too), silently accepting a malformed field instead of dropping
 * it — the same guard `coerceStartWorkflowId()` performed before this
 * predicate existed.
 */
export function assertDecodableWorkflowId(
  id: unknown,
  fieldName: string = 'options.id',
): asserts id is string {
  if (typeof id !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }

  if (id.length === 0) {
    throw new Error(`${fieldName} must not be an empty string`);
  }

  if (id.length > MAX_WORKFLOW_ID_LENGTH) {
    throw new Error(`${fieldName} must be at most ${MAX_WORKFLOW_ID_LENGTH} characters`);
  }

  if (containsControlCharacter(id)) {
    throw new Error(`${fieldName} must not contain control characters`);
  }
}

/** Whether `id` satisfies {@link assertDecodableWorkflowId}. */
export function isDecodableWorkflowId(id: unknown): boolean {
  try {
    assertDecodableWorkflowId(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `id` is exactly `.` or `..` — the two literals
 * {@link assertValidWorkflowId} rejects at fresh admission (WFT-95). Exported
 * so callers that need to recognize "this id is the one strict admission
 * would reject" without re-running the full assertion (for example, to
 * decide whether a caller-facing id MIGHT be a legacy pre-WFT-95 record
 * worth checking storage for) share one definition instead of re-deriving
 * the literal comparison.
 */
export function isReservedWorkflowIdLiteral(id: string): boolean {
  return id === '.' || id === '..';
}

export function assertValidWorkflowId(id: string, fieldName: string = 'options.id'): void {
  // WHATWG URL path normalization collapses `.` and `..` path segments (and
  // their percent-encoded forms) before `handleRequest()` ever sees
  // `url.pathname`, so a REST route with a single trailing `:id` segment
  // (e.g. `/v1/workflows/:id`) can never address a resource whose id is
  // literally `.` or `..` — no percent-encoding rescues it, and the route
  // matcher never sees enough information to reject it explicitly. Reject
  // the exact strings here, at admission, so "ids are practically always
  // UUIDs" becomes an enforced guarantee instead of an assumption. This does
  // not reject ids that merely contain a dot character (e.g. `my.workflow.v2`).
  //
  // This is an admission-only check: it must not be reused to decode
  // already-persisted data, or to look up/control an already-persisted
  // schedule or workflow by id (see {@link assertDecodableWorkflowId}),
  // because a record written before WFT-95 may legitimately carry `id: '.'`
  // or `'..'` and must remain decodable — and manageable — on upgrade.
  if (isReservedWorkflowIdLiteral(id)) {
    throw new Error(`${fieldName} must not be "." or ".."`);
  }

  assertDecodableWorkflowId(id, fieldName);
}
