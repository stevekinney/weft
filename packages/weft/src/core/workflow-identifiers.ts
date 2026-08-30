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

  if (id.length > MAX_WORKFLOW_ID_LENGTH) {
    throw new Error(`${fieldName} must be at most ${MAX_WORKFLOW_ID_LENGTH} characters`);
  }

  if (containsControlCharacter(id)) {
    throw new Error(`${fieldName} must not contain control characters`);
  }
}
