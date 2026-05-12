import { KEYS } from '../../storage/interface.ts';
import { decode, encode } from '../codec.ts';
import { buildIndexOperations, validateAttributeType } from '../search-attributes.ts';
import type {
  ListFilter,
  PaginatedResult,
  SearchAttributeValue,
  WorkflowState,
  WorkflowSummary,
} from '../types.ts';
import { mutateWorkflowTags, validateAttributeValueSizes } from './attributes-tags.ts';
import type { EngineInternals } from './internals.ts';
import { paginateWorkflowSummaries } from './state-utilities.ts';
import { decodeWorkflowState, normalizeBulkFilterNumber } from './validation.ts';
import {
  collectMatchingWorkflowStates,
  streamMatchingWorkflowStates,
} from './workflow-state-stream.ts';

export const BULK_OPERATION_BATCH_SIZE = 1000;

/** List workflow summaries that match a filter, using indexes when available. */
export async function list(
  internals: EngineInternals,
  filter?: ListFilter,
): Promise<PaginatedResult<WorkflowSummary>> {
  const items: WorkflowSummary[] = [];

  for (const state of await collectMatchingWorkflowStates(internals, filter)) {
    items.push({
      id: state.id,
      type: state.type,
      status: state.status,
      ...(state.tags !== undefined && { tags: state.tags }),
      version: state.version,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    });
  }

  return paginateWorkflowSummaries(items, filter);
}

/** Stream decoded workflow states that match a list filter. */
export async function* streamWorkflowStates(
  internals: EngineInternals,
  filter?: ListFilter,
): AsyncGenerator<WorkflowState> {
  yield* streamMatchingWorkflowStates(internals, filter);
}

/** Stream decoded workflow states in fixed-size batches for bulk operations. */
// oxlint-disable-next-line complexity -- ID:core-engine-line-3045-complexity
export async function* streamWorkflowStateBatches(
  internals: EngineInternals,
  filter?: ListFilter,
): AsyncGenerator<WorkflowState[]> {
  let remainingOffset = normalizeBulkFilterNumber(filter?.offset, 'offset') ?? 0;
  let remainingLimit = normalizeBulkFilterNumber(filter?.limit, 'limit');

  if (remainingLimit === 0) {
    return;
  }

  let batch: WorkflowState[] = [];

  for await (const state of streamWorkflowStates(internals, filter)) {
    if (remainingOffset > 0) {
      remainingOffset -= 1;
      continue;
    }

    batch.push(state);

    if (remainingLimit !== undefined) {
      remainingLimit -= 1;
    }

    if (batch.length === BULK_OPERATION_BATCH_SIZE) {
      yield batch;
      batch = [];
    }

    if (remainingLimit === 0) {
      break;
    }
  }

  if (batch.length > 0) {
    yield batch;
  }
}

/** Retrieve search attributes for a workflow. */
export async function getAttributes(
  internals: EngineInternals,
  workflowId: string,
): Promise<Record<string, SearchAttributeValue> | null> {
  const bytes = await internals.storage.get(KEYS.attribute(workflowId));
  if (!bytes) return null;
  return decode(bytes) as Record<string, SearchAttributeValue>;
}

/** Merge search attributes into a workflow's existing attributes, updating the index. */
export async function setAttributes(
  internals: EngineInternals,
  workflowId: string,
  attributes: Record<string, SearchAttributeValue>,
): Promise<void> {
  // Validate against the registration's schema if one exists
  const stateBytes = await internals.storage.get(KEYS.workflow(workflowId));
  if (stateBytes) {
    const state = decodeWorkflowState(stateBytes);
    const registration = internals.registrations.get(state.type);
    if (registration?.searchAttributes) {
      const schema = registration.searchAttributes;
      for (const [key, value] of Object.entries(attributes)) {
        if (!(key in schema)) {
          throw new Error(
            `Unknown search attribute "${key}". Registered attributes: ${Object.keys(schema).join(', ')}`,
          );
        }
        validateAttributeType(key, value, schema[key]!);
      }
    }
  }

  validateAttributeValueSizes(attributes);

  const existingBytes = await internals.storage.get(KEYS.attribute(workflowId));
  const existing: Record<string, SearchAttributeValue> = existingBytes
    ? (decode(existingBytes) as Record<string, SearchAttributeValue>)
    : {};

  const merged: Record<string, SearchAttributeValue> = { ...existing, ...attributes };

  const indexOperations = buildIndexOperations(workflowId, existing, merged);

  const operations = [
    { type: 'put' as const, key: KEYS.attribute(workflowId), value: encode(merged) },
    ...indexOperations,
  ];

  await internals.storage.batch(operations);
}

/** Add one or more tags to a workflow. */
export async function addTags(
  internals: EngineInternals,
  workflowId: string,
  ...tags: string[]
): Promise<void> {
  await mutateWorkflowTags(internals, workflowId, tags, 'add');
}

/** Remove one or more tags from a workflow. */
export async function removeTags(
  internals: EngineInternals,
  workflowId: string,
  ...tags: string[]
): Promise<void> {
  await mutateWorkflowTags(internals, workflowId, tags, 'remove');
}
