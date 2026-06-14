import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import type { ListFilter, SearchAttributeValue, WorkflowState } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import {
  readSearchAttributesForFilter,
  readSearchAttributesForStates,
} from './search-attribute-records.ts';

function createInternals(storage: MemoryStorage): EngineInternals {
  return { storage } as unknown as EngineInternals;
}

function workflowState(id: string): WorkflowState {
  return {
    id,
    type: 'search-attribute-reader',
    status: 'completed',
    input: null,
    versionTuple: { workflowVersion: 'test' },
    createdAt: 1,
    updatedAt: 1,
  };
}

const attributeFilter: ListFilter = {
  attributes: [{ key: 'segment', value: 'enterprise' }],
};

describe('search attribute record readers', () => {
  it('skips storage reads when the list filter has no attribute predicates', async () => {
    const storage = new MemoryStorage();
    const internals = createInternals(storage);

    await storage.put(KEYS.attribute('workflow-1'), encode({ segment: 'enterprise' }));

    await expect(readSearchAttributesForFilter(internals, 'workflow-1', undefined)).resolves.toBe(
      null,
    );
    await expect(
      readSearchAttributesForStates(internals, [encode(workflowState('workflow-1'))], undefined),
    ).resolves.toEqual(new Map());
  });

  it('reads and decodes attribute records for filtered workflows', async () => {
    const storage = new MemoryStorage();
    const internals = createInternals(storage);

    await storage.put(KEYS.attribute('workflow-1'), encode({ segment: 'enterprise' }));

    await expect(
      readSearchAttributesForFilter(internals, 'workflow-1', attributeFilter),
    ).resolves.toEqual({ segment: 'enterprise' });

    const attributesByWorkflowId = await readSearchAttributesForStates(
      internals,
      [null, encode(workflowState('workflow-1')), encode(workflowState('workflow-2'))],
      attributeFilter,
    );

    expect(attributesByWorkflowId).toEqual(
      new Map<string, Record<string, SearchAttributeValue> | null>([
        ['workflow-1', { segment: 'enterprise' }],
        ['workflow-2', null],
      ]),
    );
  });
});
