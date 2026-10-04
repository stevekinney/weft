/**
 * The one place a start installs the per-run state it holds in memory (COR-1408), reached when the
 * launch adopts its id, and the rollback that takes back exactly what that launch installed.
 */
import { describe, expect, it } from 'bun:test';

import {
  KEYS,
  type BatchOperation,
  type ConditionalBatchCondition,
} from '../../../storage/interface.ts';
import { MemoryStorage } from '../../../storage/memory.ts';
import { createDeferred } from '../../../testing/fake-timers.test-support.ts';
import type { Checkpoint } from '../../types.ts';
import { parkedOnSignal } from '../checkpoint-conflict.test-support.ts';
import { Engine } from '../index.ts';
import { getInternals, type EngineInternals } from '../internals.ts';
import {
  createLaunchAdoption,
  installRunTransientState,
  type RunTransientStateSources,
} from './start-transient-state.ts';

const ID = 'transient-state-unit';

function createCheckpoint(): Checkpoint {
  return { workflowExecutionToken: 'the-generation' } as Checkpoint;
}

async function withEngine(run: (internals: EngineInternals) => void | Promise<void>) {
  await using engine = new Engine({ storage: new MemoryStorage() });
  await run(getInternals(engine));
}

/**
 * Holds the create batch of one workflow, the batch that writes its record, until the test
 * releases it, so the test can dispose the engine while that batch is committing.
 */
class HeldCreateBatchStorage extends MemoryStorage {
  readonly #workflowKey: string;
  readonly #reached = createDeferred();
  readonly #released = createDeferred();
  #holding = true;

  constructor(workflowId: string) {
    super();
    this.#workflowKey = KEYS.workflow(workflowId);
  }

  /** Settles once the create batch is held. */
  get reached(): Promise<void> {
    return this.#reached.promise;
  }

  release(): void {
    this.#released.resolve();
  }

  async #holdCreateBatch(operations: readonly BatchOperation[]): Promise<void> {
    const createsTheRecord = operations.some(
      (operation) => operation.type === 'put' && operation.key === this.#workflowKey,
    );
    if (!this.#holding || !createsTheRecord) return;
    this.#holding = false;
    this.#reached.resolve();
    await this.#released.promise;
  }

  override async batch(operations: BatchOperation[]): Promise<void> {
    await this.#holdCreateBatch(operations);
    return super.batch(operations);
  }

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    await this.#holdCreateBatch(operations);
    return super.conditionalBatch(conditions, operations);
  }
}

/** Every way a start can ask to hold services or join terminal cleanup, and what that installs. */
const installations: readonly {
  label: string;
  sources: RunTransientStateSources;
  services: { value: unknown } | undefined;
  joinsCleanup: boolean;
}[] = [
  {
    label: 'installs services and joins terminal cleanup for a start that asked for services',
    sources: { options: { services: { owner: 'the start' } }, limitsConcurrency: false },
    services: { value: { owner: 'the start' } },
    joinsCleanup: true,
  },
  {
    label: 'installs services a caller handed over, and joins terminal cleanup with them',
    sources: {
      options: undefined,
      limitsConcurrency: false,
      transientState: { services: { value: { owner: 'the occurrence' } } },
    },
    services: { value: { owner: 'the occurrence' } },
    joinsCleanup: true,
  },
  {
    label: 'installs a handed-over services value that is itself undefined',
    sources: {
      options: undefined,
      limitsConcurrency: false,
      transientState: { services: { value: undefined } },
    },
    services: { value: undefined },
    joinsCleanup: true,
  },
  {
    label: 'joins terminal cleanup without services when the caller asks to',
    sources: {
      options: undefined,
      limitsConcurrency: false,
      transientState: { joinTerminalCleanup: true },
    },
    services: undefined,
    joinsCleanup: true,
  },
  {
    label: 'joins terminal cleanup for a type that limits concurrency',
    sources: { options: undefined, limitsConcurrency: true },
    services: undefined,
    joinsCleanup: true,
  },
  {
    label: 'installs nothing for a start that asked for neither',
    sources: { options: {}, limitsConcurrency: false },
    services: undefined,
    joinsCleanup: false,
  },
  {
    label: 'installs nothing for a caller state that asks for neither',
    sources: { options: undefined, limitsConcurrency: false, transientState: {} },
    services: undefined,
    joinsCleanup: false,
  },
  {
    label: 'prefers the start options over the state a caller handed over',
    sources: {
      options: { services: { owner: 'the start' } },
      limitsConcurrency: false,
      transientState: { services: { value: { owner: 'the occurrence' } } },
    },
    services: { value: { owner: 'the start' } },
    joinsCleanup: true,
  },
];

describe('installing the per-run state of a start', () => {
  for (const { label, sources, services, joinsCleanup } of installations) {
    it(label, async () => {
      await withEngine((internals) => {
        installRunTransientState(internals, ID, sources);

        expect(internals.workflowServices.has(ID)).toBe(services !== undefined);
        if (services !== undefined) {
          expect(internals.workflowServices.get(ID)).toEqual(services.value);
        }
        expect(internals.workflowsNeedingTerminalCleanup.has(ID)).toBe(joinsCleanup);
      });
    });
  }

  it('holds the services a caller handed over by identity', async () => {
    await withEngine((internals) => {
      const value = { owner: 'the occurrence' };

      installRunTransientState(internals, ID, {
        options: undefined,
        limitsConcurrency: false,
        transientState: { services: { value } },
      });

      expect(internals.workflowServices.get(ID)).toBe(value);
    });
  });
});

describe('adopting an id', () => {
  it('installs the run state the launch asked for in the step that installs its checkpoint', async () => {
    await withEngine((internals) => {
      const services = { owner: 'the launch' };

      createLaunchAdoption(internals, ID).adopt(createCheckpoint(), new Uint8Array(), {
        options: { services },
        limitsConcurrency: false,
      });

      expect(internals.checkpoints.has(ID)).toBe(true);
      expect(internals.workflowServices.get(ID)).toBe(services);
      expect(internals.workflowsNeedingTerminalCleanup.has(ID)).toBe(true);
    });
  });

  it('installs the state a caller handed over', async () => {
    await withEngine((internals) => {
      const services = { owner: 'the occurrence' };

      createLaunchAdoption(internals, ID).adopt(createCheckpoint(), new Uint8Array(), {
        options: undefined,
        limitsConcurrency: false,
        transientState: { joinTerminalCleanup: true, services: { value: services } },
      });

      expect(internals.workflowServices.get(ID)).toBe(services);
      expect(internals.workflowsNeedingTerminalCleanup.has(ID)).toBe(true);
    });
  });

  it('installs nothing for a launch that asked for neither services nor terminal cleanup', async () => {
    await withEngine((internals) => {
      createLaunchAdoption(internals, ID).adopt(createCheckpoint(), new Uint8Array(), {
        options: {},
        limitsConcurrency: false,
      });

      expect(internals.checkpoints.has(ID)).toBe(true);
      expect(internals.workflowServices.has(ID)).toBe(false);
      expect(internals.workflowsNeedingTerminalCleanup.has(ID)).toBe(false);
    });
  });
});

describe('rolling back a launch', () => {
  it('removes the services and cleanup membership the launch installed when it adopted a checkpoint', async () => {
    await withEngine((internals) => {
      const launch = createLaunchAdoption(internals, ID);
      launch.adopt(createCheckpoint(), new Uint8Array(), {
        options: undefined,
        limitsConcurrency: false,
        transientState: { joinTerminalCleanup: true, services: { value: { owner: 'launch' } } },
      });

      launch.rollback();

      expect(internals.workflowServices.has(ID)).toBe(false);
      expect(internals.workflowsNeedingTerminalCleanup.has(ID)).toBe(false);
      expect(internals.checkpoints.has(ID)).toBe(false);
    });
  });

  it('leaves a live run its services and cleanup membership when the launch never adopted a checkpoint', async () => {
    await withEngine((internals) => {
      const live = { owner: 'the live run' };
      createLaunchAdoption(internals, ID).adopt(createCheckpoint(), new Uint8Array(), {
        options: { services: live },
        limitsConcurrency: false,
      });

      createLaunchAdoption(internals, ID).rollback();

      expect(internals.workflowServices.get(ID)).toBe(live);
      expect(internals.workflowsNeedingTerminalCleanup.has(ID)).toBe(true);
      expect(internals.checkpoints.has(ID)).toBe(true);
    });
  });
});

describe('installing on a disposed engine', () => {
  // Disposal clears the services an engine holds so that a credential-bearing closure is not
  // stranded past it, so a launch that was in flight when the engine was disposed installs nothing.
  for (const { label, sources } of installations.filter(({ joinsCleanup }) => joinsCleanup)) {
    it(`installs nothing once the engine is disposed (${label})`, async () => {
      const engine = new Engine({ storage: new MemoryStorage() });
      const internals = getInternals(engine);
      await engine[Symbol.asyncDispose]();

      installRunTransientState(internals, ID, sources);

      expect(internals.workflowServices.has(ID)).toBe(false);
      expect(internals.workflowsNeedingTerminalCleanup.has(ID)).toBe(false);
    });

    it(`adopts nothing and installs nothing once the engine is disposed (${label})`, async () => {
      const engine = new Engine({ storage: new MemoryStorage() });
      const internals = getInternals(engine);
      await engine[Symbol.asyncDispose]();

      createLaunchAdoption(internals, ID).adopt(createCheckpoint(), new Uint8Array(), sources);

      expect(internals.checkpoints.has(ID)).toBe(false);
      expect(internals.workflowServices.has(ID)).toBe(false);
      expect(internals.workflowsNeedingTerminalCleanup.has(ID)).toBe(false);
    });
  }
});

describe('a start whose engine is disposed while its create batch commits', () => {
  // The launch installed its run state when it adopted the id, before the batch was held. Disposal
  // releases the services an engine holds so that a credential-bearing closure is not stranded past
  // it, and the start that outlives the engine installs nothing again. Disposal does not clear the
  // cleanup membership of a run the engine holds, so the cells say nothing about it.
  const services = { owner: 'the start' };

  it('holds no services for engine.start once the batch commits', async () => {
    const storage = new HeldCreateBatchStorage(ID);
    const engine = await Engine.create({ storage, recover: false });
    engine.register(parkedOnSignal(ID));
    const internals = getInternals(engine);

    const starting = engine.start(ID, null, { id: ID, services });
    await storage.reached;
    expect(internals.workflowServices.get(ID)).toBe(services);
    await engine[Symbol.asyncDispose]();
    storage.release();
    await Promise.allSettled([starting]);

    expect(internals.workflowServices.has(ID)).toBe(false);
    expect(internals.checkpoints.has(ID)).toBe(false);
  });

  it('holds no services for engine.prepare once the batch commits', async () => {
    const storage = new HeldCreateBatchStorage(ID);
    const engine = await Engine.create({ storage, recover: false });
    engine.register(parkedOnSignal(ID));
    const internals = getInternals(engine);

    const preparing = engine.prepare(ID, null, { id: ID, services });
    await storage.reached;
    expect(internals.workflowServices.get(ID)).toBe(services);
    await engine[Symbol.asyncDispose]();
    storage.release();
    await Promise.allSettled([preparing]);

    expect(internals.workflowServices.has(ID)).toBe(false);
    expect(internals.checkpoints.has(ID)).toBe(false);
  });
});
