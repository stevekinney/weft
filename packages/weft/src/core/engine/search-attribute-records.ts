import { KEYS } from '../../storage/interface.ts';
import type { ListFilter, SearchAttributeValue } from '../types.ts';

import type { EngineInternals } from './internals.ts';
import { decodeSearchAttributeRecord, listFilterHasAttributeFilters } from './state-utilities.ts';
import { decodeWorkflowState } from './validation.ts';

export async function readSearchAttributesForStates(
  internals: EngineInternals,
  stateBytesList: readonly (Uint8Array | null)[],
  filter: ListFilter | undefined,
): Promise<Map<string, Record<string, SearchAttributeValue> | null>> {
  const searchAttributesByWorkflowId = new Map<
    string,
    Record<string, SearchAttributeValue> | null
  >();
  if (!listFilterHasAttributeFilters(filter)) return searchAttributesByWorkflowId;

  const states = stateBytesList.flatMap((stateBytes) =>
    stateBytes === null ? [] : [decodeWorkflowState(stateBytes)],
  );

  const attributeBytesList = await Promise.all(
    states.map((state) => internals.storage.get(KEYS.attribute(state.id))),
  );
  for (let index = 0; index < states.length; index += 1) {
    searchAttributesByWorkflowId.set(
      states[index]!.id,
      decodeSearchAttributeRecord(attributeBytesList[index] ?? null),
    );
  }
  return searchAttributesByWorkflowId;
}

export async function readSearchAttributesForFilter(
  internals: EngineInternals,
  workflowId: string,
  filter: ListFilter | undefined,
): Promise<Record<string, SearchAttributeValue> | null> {
  if (!listFilterHasAttributeFilters(filter)) return null;
  return decodeSearchAttributeRecord(await internals.storage.get(KEYS.attribute(workflowId)));
}
