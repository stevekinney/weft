/**
 * COR-1283: `registerOnRuntimeEngine` — the documented escape hatch for
 * registering a workflow definition on a runtime-typed engine view, bypassing
 * the compile-time `WorkflowAlreadyRegistered` parameter-position guard.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../storage/memory.ts';
import { Engine } from './engine.ts';
import { registerOnRuntimeEngine, runtimeWorkflowEngine } from './runtime-workflow-engine.ts';
import { workflow } from './types.ts';

describe('registerOnRuntimeEngine', () => {
  it('registers a workflow definition through the runtime-typed engine view', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const runtimeEngine = runtimeWorkflowEngine(engine);

    registerOnRuntimeEngine(
      runtimeEngine,
      workflow({ name: 'runtime-registered' }).execute(async function* () {
        return 'ok';
      }),
    );

    const handle = await engine.start('runtime-registered', null);
    expect(await handle.result()).toBe('ok');
  });
});
