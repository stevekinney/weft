import type { EngineInternals } from './internals.ts';

const committedCheckpointBytes = new WeakMap<EngineInternals, Map<string, Uint8Array>>();

export function rememberCommittedCheckpointBytes(
  internals: EngineInternals,
  workflowId: string,
  serialized: Uint8Array,
): void {
  let bytesByWorkflowId = committedCheckpointBytes.get(internals);
  if (!bytesByWorkflowId) {
    bytesByWorkflowId = new Map();
    committedCheckpointBytes.set(internals, bytesByWorkflowId);
  }
  bytesByWorkflowId.set(workflowId, new Uint8Array(serialized));
}

export function getCommittedCheckpointBytes(
  internals: EngineInternals,
  workflowId: string,
): Uint8Array | undefined {
  const committedBytes = committedCheckpointBytes.get(internals)?.get(workflowId);
  return committedBytes ? new Uint8Array(committedBytes) : undefined;
}

export function forgetCommittedCheckpointBytes(
  internals: EngineInternals,
  workflowId: string,
): void {
  committedCheckpointBytes.get(internals)?.delete(workflowId);
}
