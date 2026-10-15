import { KEYS, type BatchOperation } from '../../../storage/interface.ts';
import type { RunIdentity } from '../execution-attempts.ts';

/** The generation and holder marker a start batch wrote for `workflowId`; `null` when it wrote none. */
export function identityFromStartOperations(
  workflowId: string,
  operations: BatchOperation[],
): RunIdentity {
  const written = (key: string): Uint8Array | null => {
    const put = operations.findLast(
      (operation) => operation.type === 'put' && operation.key === key,
    );
    return put?.type === 'put' ? put.value : null;
  };
  return {
    generation: written(KEYS.workflowGeneration(workflowId)),
    holderMarker: written(KEYS.workflowConcurrencyHolder(workflowId)),
  };
}
