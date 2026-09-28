import type { WorkflowWorkerBinding } from '../../worker/versioning-policy.ts';
import { MAX_TASK_IDENTIFIER_BYTES, utf8ByteLength } from './task-ledger-limits.ts';

const WORKFLOW_WORKER_BINDING_STRING_FIELDS = [
  'workflowId',
  'workflowType',
  'deploymentName',
  'buildId',
  'artifactDigest',
  'manifestDigest',
  'workflowRevision',
  'workflowContractHash',
  'activityName',
  'activityContractHash',
  'checkpointId',
] as const satisfies readonly (keyof WorkflowWorkerBinding)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    utf8ByteLength(value) <= MAX_TASK_IDENTIFIER_BYTES
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isValidWorkflowWorkerBinding(value: unknown): value is WorkflowWorkerBinding {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    WORKFLOW_WORKER_BINDING_STRING_FIELDS.every((field) => isBoundedIdentifier(value[field])) &&
    isFiniteNumber(value['routingGeneration']) &&
    isFiniteNumber(value['boundAt']) &&
    isRecord(value['activityContracts']) &&
    Object.values(value['activityContracts']).every((entry) => isBoundedIdentifier(entry))
  );
}
