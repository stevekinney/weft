import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { principalFromApiKey } from '../principal.ts';
import { listSchedulesOperation, listSchedulesRestBinding } from './list-schedules.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

export function createListSchedulesTestEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register(echoWorkflow);
  return engine;
}

export function createListSchedulesApiKeyAuthContext() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({ subject: 'test', scopes: [] }),
    },
  };
}

export const listSchedulesTestRegistry = createOperationRegistry([listSchedulesOperation]);
export const listSchedulesTestRestBindings = [listSchedulesRestBinding];
