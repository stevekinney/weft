export const WORKFLOW_VERSION_LOCAL_PREFIX = 'version:';

export type WorkflowVersionPatchResolution = {
  localKey: string;
  version: number;
  newlyPinned: boolean;
  checkpointLocals: Record<string, unknown>;
};

export function resolveWorkflowVersionPatch(
  checkpointLocals: Record<string, unknown>,
  changeId: string,
  minSupported: number,
  maxSupported: number,
): WorkflowVersionPatchResolution {
  validateWorkflowVersionPatchArguments(changeId, minSupported, maxSupported);

  const localKey = `${WORKFLOW_VERSION_LOCAL_PREFIX}${changeId}`;
  const existing = checkpointLocals[localKey];
  if (existing === undefined) {
    return {
      localKey,
      version: maxSupported,
      newlyPinned: true,
      checkpointLocals: { ...checkpointLocals, [localKey]: maxSupported },
    };
  }

  if (typeof existing !== 'number' || !Number.isSafeInteger(existing)) {
    throw new Error(
      `Invalid checkpointed workflow version patch "${changeId}" value ${JSON.stringify(existing)}`,
    );
  }

  const version = existing;
  assertPinnedVersionSupported(changeId, version, minSupported, maxSupported);
  return {
    localKey,
    version,
    newlyPinned: false,
    checkpointLocals,
  };
}

function validateWorkflowVersionPatchArguments(
  changeId: string,
  minSupported: number,
  maxSupported: number,
): void {
  if (typeof changeId !== 'string' || changeId.length === 0) {
    throw new Error('ctx.getVersion() requires a non-empty changeId');
  }
  assertVersionBoundary('minSupported', minSupported);
  assertVersionBoundary('maxSupported', maxSupported);
  if (minSupported > maxSupported) {
    throw new Error('ctx.getVersion() minSupported must be less than or equal to maxSupported');
  }
}

function assertVersionBoundary(name: string, value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`ctx.getVersion() ${name} must be a safe integer`);
  }
}

function assertPinnedVersionSupported(
  changeId: string,
  version: number,
  minSupported: number,
  maxSupported: number,
): void {
  if (version < minSupported) {
    throw new Error(
      `Workflow version patch "${changeId}" is pinned to version ${version}, below the minimum supported version ${minSupported}`,
    );
  }
  if (version > maxSupported) {
    throw new Error(
      `Workflow version patch "${changeId}" is pinned to version ${version}, above the maximum supported version ${maxSupported}`,
    );
  }
}
