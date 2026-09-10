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

export function assertValidWorkflowId(id: string, fieldName: string = 'options.id'): void {
  if (id.length === 0) {
    throw new Error(`${fieldName} must not be an empty string`);
  }

  // WHATWG URL path normalization collapses `.` and `..` path segments (and
  // their percent-encoded forms) before `handleRequest()` ever sees
  // `url.pathname`, so a REST route with a single trailing `:id` segment
  // (e.g. `/v1/workflows/:id`) can never address a resource whose id is
  // literally `.` or `..` — no percent-encoding rescues it, and the route
  // matcher never sees enough information to reject it explicitly. Reject
  // the exact strings here, at admission, so "ids are practically always
  // UUIDs" becomes an enforced guarantee instead of an assumption. This does
  // not reject ids that merely contain a dot character (e.g. `my.workflow.v2`).
  if (id === '.' || id === '..') {
    throw new Error(`${fieldName} must not be "." or ".."`);
  }

  if (id.length > MAX_WORKFLOW_ID_LENGTH) {
    throw new Error(`${fieldName} must be at most ${MAX_WORKFLOW_ID_LENGTH} characters`);
  }

  if (containsControlCharacter(id)) {
    throw new Error(`${fieldName} must not contain control characters`);
  }
}
