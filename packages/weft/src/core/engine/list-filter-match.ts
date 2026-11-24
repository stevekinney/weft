/**
 * The match every list, aggregate and bulk path applies to a loaded run: {@link matchesListFilter}
 * on the state, then the one dimension that lives in a record of its own, `retrying`
 * (COR-2530). Every caller that loads a candidate goes through this function, so a filter field
 * is never honored by one path and dropped by another.
 *
 * @module core/engine/list-filter-match
 */
import { KEYS } from '../../storage/keys.ts';
import type {
  ListFilter,
  SearchAttributeValue,
  WorkflowRetrying,
  WorkflowState,
} from '../types.ts';
import { decodeActivityRetrying } from './activity-retrying-record.ts';
import type { EngineInternals } from './internals.ts';
import { matchesListFilter } from './state-utilities.ts';

/**
 * The activity a run is retrying, read only for a run that is running: the record is deleted when
 * the run leaves `running`, but never trusted after it. One small read per running run.
 */
export async function readRetryingRecord(
  internals: EngineInternals,
  state: WorkflowState,
): Promise<WorkflowRetrying | undefined> {
  if (state.status !== 'running') return undefined;
  return decodeActivityRetrying(
    await internals.storage.get(KEYS.activityRetrying(state.id)),
    state.workflowExecutionToken,
  );
}

/**
 * Whether `state` satisfies `ListFilter.retrying`: authoritative, read from the record behind
 * `WorkflowSummary.retrying`, so an index entry never decides it. `undefined` matches every run,
 * and a run that is not running is never retrying, with no read.
 */
async function matchesRetryingFilter(
  internals: EngineInternals,
  state: WorkflowState,
  retrying: boolean | undefined,
): Promise<boolean> {
  if (retrying === undefined) return true;
  const isRetrying = (await readRetryingRecord(internals, state)) !== undefined;
  return isRetrying === retrying;
}

/**
 * Whether `state` satisfies `filter`. The cheap state checks run first, so the retrying record is
 * read (one small read, only for a running run) just for a run that already matches the rest.
 */
export async function matchesListFilterAndRecords(
  internals: EngineInternals,
  state: WorkflowState,
  filter: ListFilter | undefined,
  constrainedIds: Set<string> | null,
  normalizedTagFilters: readonly string[] | undefined,
  searchAttributes?: Readonly<Record<string, SearchAttributeValue>> | null,
): Promise<boolean> {
  if (!matchesListFilter(state, filter, constrainedIds, normalizedTagFilters, searchAttributes)) {
    return false;
  }
  return matchesRetryingFilter(internals, state, filter?.retrying);
}
