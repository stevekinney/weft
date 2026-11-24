import { describe, expect, it, spyOn } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { throwingRejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { workflowSource } from '../source/index.ts';
import { workflow, type WorkflowDefinition } from '../types.ts';
import { deriveWorkflowDefinitionRevision } from './definition-revision.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { activateRegisteredSourceRevision } from './source-activation.ts';

function versioned(version: string): WorkflowDefinition {
  return workflow({ name: 'deployed', version }).execute(async function* () {
    return version;
  });
}

async function register(engine: Engine, definition: WorkflowDefinition): Promise<string> {
  const revision = await deriveWorkflowDefinitionRevision(definition);
  engine.registerSource(
    workflowSource(
      { name: 'deployed', location: `./${revision}.ts`, exportName: 'w', revision },
      async () => ({ w: definition }),
    ),
  );
  return revision;
}

describe('activateRegisteredSourceRevision()', () => {
  it('moves the active revision across a workflowVersion change that the guarded activation refuses', async () => {
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    const first = await register(engine, versioned('1.0.0'));
    const second = await register(engine, versioned('2.0.0'));
    await activateRegisteredSourceRevision(engine, 'deployed', first);

    await engine.workflows.preload('deployed', second);
    const guarded = await engine.workflows.activate('deployed', second, {
      expectedGeneration: 1,
      policy: { requireExactRevision: false },
    });
    expect(guarded).toMatchObject({ applied: false, reason: 'incompatible' });

    const pointer = await activateRegisteredSourceRevision(engine, 'deployed', second);

    expect(pointer).toMatchObject({ revision: second, generation: 2 });
    const run = await engine.start('deployed', null);
    expect(await run.result()).toBe('2.0.0');
  });

  it('is a no-op for the revision that is already active', async () => {
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    const revision = await register(engine, versioned('1.0.0'));

    const first = await activateRegisteredSourceRevision(engine, 'deployed', revision);
    const again = await activateRegisteredSourceRevision(engine, 'deployed', revision);

    expect(again).toEqual(first);
  });

  it('fails loudly when a resolved source leaves no local definition', async () => {
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    const revision = await register(engine, versioned('1.0.0'));
    spyOn(getInternals(engine).sources.resolved, 'get').mockReturnValue(undefined);

    expect(
      await throwingRejectionOf(activateRegisteredSourceRevision(engine, 'deployed', revision)),
    ).toThrow('resolved without a local definition');
  });

  it('rejects a revision that was never registered as a source', async () => {
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });

    expect(
      await throwingRejectionOf(activateRegisteredSourceRevision(engine, 'deployed', 'missing')),
    ).toThrow('deployed');
  });
});
