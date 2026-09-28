import type { BatchOperation, ConditionalBatchCondition } from '../../../storage/interface.ts';
import type { WorkerStartOverrideConsumption } from '../../../worker/start-override-preview.ts';
import { buildWorkflowWorkerStartOverrideConsumption } from '../../../worker/start-override-preview.ts';
import type { WorkflowWorkerBinding } from '../../../worker/versioning-policy.ts';
import { StartWorkflowValidationError } from '../../start-workflow-validation.ts';
import type { StartWorkflowOptions, WorkflowState } from '../../types.ts';
import type { EngineInternals } from '../internals.ts';

export function prepareWorkerStartOverrideConsumption(
  internals: EngineInternals,
  options: StartWorkflowOptions | undefined,
  workflowId: string,
  terminalRunToPurge: WorkflowState | null,
  workerBinding: WorkflowWorkerBinding | undefined,
): WorkerStartOverrideConsumption | undefined {
  if (options?.workerStartOverridePreview === undefined) return undefined;
  const serverSecret =
    options.workerStartOverrideSigningSecret ??
    internals.options.workerStartOverrideSigningSecret ??
    undefined;
  const consumption =
    serverSecret === undefined
      ? null
      : buildWorkflowWorkerStartOverrideConsumption({
          workflowId,
          preview: options.workerStartOverridePreview,
          previousBinding: terminalRunToPurge?.workerBinding?.current,
          targetBinding: workerBinding,
          serverSecret,
          now: internals.options.getNow(),
        });
  if (consumption === null) {
    throw new StartWorkflowValidationError(
      'options.workerStartOverridePreview is expired, reused, scoped to a different workflow, stale, or incompatible with the accepted worker binding.',
    );
  }
  return consumption;
}

export function mergeWorkerStartOverrideOperations(
  additionalStartOperations: BatchOperation[] | undefined,
  consumption: WorkerStartOverrideConsumption | undefined,
): BatchOperation[] | undefined {
  return consumption === undefined
    ? additionalStartOperations
    : [...(additionalStartOperations ?? []), ...consumption.operations];
}

export function workerStartOverrideConditions(
  consumption: WorkerStartOverrideConsumption | undefined,
): ConditionalBatchCondition[] | undefined {
  return consumption === undefined ? undefined : [...consumption.conditions];
}
