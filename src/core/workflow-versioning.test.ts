import { describe, expect, it } from 'bun:test';

import { KEYS, type BatchOperation, type ConditionalBatchCondition } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { waitForCondition } from '../testing/fake-timers.test-support.ts';
import { deserializeCheckpoint } from './checkpoint/serialization.ts';
import { decode } from './codec.ts';
import { Engine } from './engine.ts';
import type { WorkflowTimelineEntry } from './types.ts';
import { workflow } from './types/workflow-function.ts';

type VersionConfiguration = {
  minSupported: number;
  maxSupported: number;
};

function createVersionedWorkflow(configuration: VersionConfiguration) {
  return workflow({ name: 'versioned-patching' }).execute(async function* (ctx) {
    const version = yield* ctx.getVersion(
      'shipping-v2',
      configuration.minSupported,
      configuration.maxSupported,
    );
    const signal = yield* ctx.waitForSignal<string>('continue');
    return {
      branch: version === 1 ? 'old' : 'new',
      signal,
      version,
    };
  });
}

class CrashAfterGetVersionCheckpointStorage extends MemoryStorage {
  crashed = false;

  override async batch(operations: BatchOperation[]): Promise<void> {
    await super.batch(operations);
    this.throwAfterCommittedGetVersionCheckpoint(operations);
  }

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    const committed = await super.conditionalBatch(conditions, operations);
    if (committed) {
      this.throwAfterCommittedGetVersionCheckpoint(operations);
    }
    return committed;
  }

  throwAfterCommittedGetVersionCheckpoint(operations: BatchOperation[]): void {
    if (this.crashed) return;
    if (!operations.some(isGetVersionTimelinePut)) return;

    this.crashed = true;
    throw new Error('simulated crash after get-version checkpoint commit');
  }
}

function isGetVersionTimelinePut(operation: BatchOperation): boolean {
  if (operation.type !== 'put') return false;
  if (!operation.key.includes(':timeline:')) return false;

  try {
    const entry = decode(operation.value) as WorkflowTimelineEntry;
    return entry.operationType === 'get-version';
  } catch {
    return false;
  }
}

async function readPinnedVersion(storage: MemoryStorage, workflowId: string): Promise<unknown> {
  const checkpointBytes = await storage.get(KEYS.checkpoint(workflowId));
  expect(checkpointBytes).not.toBeNull();
  const checkpoint = deserializeCheckpoint(checkpointBytes!);
  return checkpoint.locals['version:shipping-v2'];
}

describe('ctx.getVersion workflow patching', () => {
  it('keeps old in-flight workflows on their pinned branch while new starts take the new branch', async () => {
    const storage = new MemoryStorage();
    const configuration: VersionConfiguration = { minSupported: 1, maxSupported: 1 };

    const firstEngine = new Engine({ storage });
    firstEngine.register(createVersionedWorkflow(configuration));
    await firstEngine.start('versioned-patching', null, {
      id: 'versioned-old',
    });
    await waitForCondition(() => readPinnedVersion(storage, 'versioned-old').then((v) => v === 1), {
      label: 'old workflow version pin',
    });
    firstEngine[Symbol.dispose]();

    configuration.maxSupported = 2;
    const recoveredEngine = new Engine({ storage });
    recoveredEngine.register(createVersionedWorkflow(configuration));
    const recoveredHandles = await recoveredEngine.recoverAll();
    expect(recoveredHandles.map((handle) => handle.id)).toEqual(['versioned-old']);

    await recoveredEngine.signal('versioned-old', 'continue', 'old-signal');
    await expect(recoveredHandles[0]!.result()).resolves.toEqual({
      branch: 'old',
      signal: 'old-signal',
      version: 1,
    });

    const newHandle = await recoveredEngine.start('versioned-patching', null, {
      id: 'versioned-new',
    });
    await recoveredEngine.signal('versioned-new', 'continue', 'new-signal');
    await expect(newHandle.result()).resolves.toEqual({
      branch: 'new',
      signal: 'new-signal',
      version: 2,
    });

    recoveredEngine[Symbol.dispose]();
  });

  it('fails actionably when recovered code no longer supports a pinned version', async () => {
    const storage = new MemoryStorage();
    const configuration: VersionConfiguration = { minSupported: 1, maxSupported: 1 };

    const firstEngine = new Engine({ storage });
    firstEngine.register(createVersionedWorkflow(configuration));
    await firstEngine.start('versioned-patching', null, { id: 'unsupported-version' });
    await waitForCondition(
      () => readPinnedVersion(storage, 'unsupported-version').then((version) => version === 1),
      { label: 'unsupported workflow version pin' },
    );
    firstEngine[Symbol.dispose]();

    configuration.minSupported = 2;
    configuration.maxSupported = 2;
    const recoveredEngine = new Engine({ storage });
    recoveredEngine.register(createVersionedWorkflow(configuration));
    const recoveredHandles = await recoveredEngine.recoverAll();
    expect(recoveredHandles).toHaveLength(1);

    await expect(recoveredHandles[0]!.result()).rejects.toThrow(
      'Workflow version patch "shipping-v2" is pinned to version 1, below the minimum supported version 2',
    );

    recoveredEngine[Symbol.dispose]();
  });

  it('recovers when a crash lands after the version pin checkpoint but before the next step', async () => {
    const storage = new CrashAfterGetVersionCheckpointStorage();
    const configuration: VersionConfiguration = { minSupported: 1, maxSupported: 2 };

    const firstEngine = new Engine({ storage });
    firstEngine.register(createVersionedWorkflow(configuration));
    const crashedHandle = await firstEngine.start('versioned-patching', null, {
      id: 'version-crash-window',
    });
    crashedHandle.result().catch(() => {});
    await waitForCondition(() => storage.crashed, {
      label: 'simulated crash after get-version checkpoint',
    });
    expect(await readPinnedVersion(storage, 'version-crash-window')).toBe(2);
    firstEngine[Symbol.dispose]();

    const recoveredEngine = new Engine({ storage });
    recoveredEngine.register(createVersionedWorkflow(configuration));
    const recoveredHandles = await recoveredEngine.recoverAll();
    expect(recoveredHandles).toHaveLength(1);

    await recoveredEngine.signal('version-crash-window', 'continue', 'after-crash');
    await expect(recoveredHandles[0]!.result()).resolves.toEqual({
      branch: 'new',
      signal: 'after-crash',
      version: 2,
    });

    recoveredEngine[Symbol.dispose]();
  });
});
