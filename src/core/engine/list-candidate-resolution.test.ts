import { describe, expect, it } from 'bun:test';

import { runWorkflowVisibilityBackfill } from '../../../scripts/lib/workflow-visibility-backfill.ts';
import { KEYS, type ScanOptions } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { decode, encode } from '../codec.ts';
import { Engine } from '../engine.ts';
import { buildIndexOperations } from '../search-attributes.ts';
import type { WorkflowState } from '../types.ts';
import { workflow } from '../types/workflow-function.ts';
import { getInternals } from './internals.ts';
import { WORKFLOW_VISIBILITY_INDEX_VERSION } from './workflow-indexes.ts';

const applicationFailureWorkflow = workflow({ name: 'application-failure' }).execute(
  async function* () {
    throw new Error('application failed');
  },
);
const resourceFailureWorkflow = workflow({ name: 'resource-failure' }).execute(async function* () {
  throw resourceFailure();
});
const timeoutFailureWorkflow = workflow({ name: 'timeout-failure' }).execute(async function* () {
  throw timeoutFailure();
});
const visibilityCacheWorkflow = workflow({ name: 'visibility-cache' }).execute(async function* (
  _ctx,
  input: string,
) {
  return input;
});

class ScanCountingStorage extends MemoryStorage {
  readonly getCounts = new Map<string, number>();
  readonly scanCounts = new Map<string, number>();

  override async get(key: string): Promise<Uint8Array | null> {
    this.getCounts.set(key, (this.getCounts.get(key) ?? 0) + 1);
    return super.get(key);
  }

  override async *scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]> {
    this.scanCounts.set(prefix, (this.scanCounts.get(prefix) ?? 0) + 1);
    yield* super.scan(prefix, options);
  }

  resetObservations(): void {
    this.getCounts.clear();
    this.scanCounts.clear();
  }

  countGets(key: string): number {
    return this.getCounts.get(key) ?? 0;
  }

  countScans(prefix: string): number {
    return this.scanCounts.get(prefix) ?? 0;
  }
}

function resourceFailure(): Error {
  const error = new Error('resource exhausted');
  error.name = 'ResourceExhaustedError';
  return error;
}

function timeoutFailure(): Error {
  const error = new Error('timed out');
  error.name = 'TimeoutError';
  return error;
}

async function createFailedWorkflows(engine: Engine): Promise<void> {
  engine.register(applicationFailureWorkflow);
  engine.register(resourceFailureWorkflow);
  engine.register(timeoutFailureWorkflow);

  const applicationHandle = await engine.start('application-failure', null, {
    id: 'application-1',
  });
  await expect(applicationHandle.result()).rejects.toThrow('application failed');

  const resourceHandle = await engine.start('resource-failure', null, { id: 'resource-1' });
  await expect(resourceHandle.result()).rejects.toThrow('resource exhausted');

  const timeoutHandle = await engine.start('timeout-failure', null, { id: 'timeout-1' });
  await expect(timeoutHandle.result()).rejects.toThrow('timed out');
}

describe('resolveListCandidateIds', () => {
  it('caches visibility watermark reads across list and aggregate until backfill invalidates it', async () => {
    const storage = new ScanCountingStorage();
    const engine = new Engine({ storage });
    try {
      engine.register(visibilityCacheWorkflow);
      const firstHandle = await engine.start('visibility-cache', 'first', {
        id: 'visibility-cache-a',
      });
      const secondHandle = await engine.start('visibility-cache', 'second', {
        id: 'visibility-cache-b',
      });
      await firstHandle.result();
      await secondHandle.result();

      storage.resetObservations();

      await engine.list({ status: 'completed' });
      await engine.aggregate({ status: 'completed' }, { groupBy: 'status' });

      expect(storage.countGets(KEYS.workflowVisibilityMetaVersion())).toBe(1);
      expect(storage.countScans('wf:')).toBe(2);

      const report = await runWorkflowVisibilityBackfill(storage, {
        onWatermarkWritten: () => {
          getInternals(engine).workflowVisibilityWatermark = undefined;
        },
      });
      expect(report.watermarkWritten).toBe(true);

      const workflowScansAfterBackfill = storage.countScans('wf:');
      await engine.list({ status: 'completed' });

      expect(storage.countGets(KEYS.workflowVisibilityMetaVersion())).toBe(2);
      expect(storage.countScans('wf:')).toBe(workflowScansAfterBackfill);
      expect(storage.countScans('wf-idx-status:completed:')).toBe(1);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('reuses a current visibility watermark after the first indexed query', async () => {
    const storage = new ScanCountingStorage();
    const engine = new Engine({ storage });
    try {
      engine.register(visibilityCacheWorkflow);
      const handle = await engine.start('visibility-cache', 'first', {
        id: 'visibility-cache-current',
      });
      await handle.result();
      await storage.put(
        KEYS.workflowVisibilityMetaVersion(),
        encode(WORKFLOW_VISIBILITY_INDEX_VERSION),
      );

      storage.resetObservations();

      await engine.list({ status: 'completed' });
      await engine.aggregate({ status: 'completed' }, { groupBy: 'status' });

      expect(storage.countGets(KEYS.workflowVisibilityMetaVersion())).toBe(1);
      expect(storage.countScans('wf:')).toBe(0);
      expect(storage.countScans('wf-idx-status:completed:')).toBe(2);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('uses the failureCategory search-attribute index for scalar list filters', async () => {
    const storage = new ScanCountingStorage();
    const engine = new Engine({ storage });
    try {
      await createFailedWorkflows(engine);
      storage.resetObservations();

      const result = await engine.list({ failureCategory: 'application' });

      expect(result.items.map((item) => item.id)).toEqual(['application-1']);
      expect(storage.countScans('wf:')).toBe(0);
      expect(storage.countScans('idx:failureCategory:s:application:')).toBe(1);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('unions failureCategory search-attribute candidates for array list filters', async () => {
    const storage = new ScanCountingStorage();
    const engine = new Engine({ storage });
    try {
      await createFailedWorkflows(engine);
      storage.resetObservations();

      const result = await engine.list({ failureCategory: ['application', 'resource'] });

      expect(new Set(result.items.map((item) => item.id))).toEqual(
        new Set(['application-1', 'resource-1']),
      );
      expect(storage.countScans('wf:')).toBe(0);
      expect(storage.countScans('idx:failureCategory:s:application:')).toBe(1);
      expect(storage.countScans('idx:failureCategory:s:resource:')).toBe(1);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('intersects failureCategory and idPrefix candidates while the visibility watermark is stale', async () => {
    const storage = new ScanCountingStorage();
    const engine = new Engine({ storage });
    try {
      await createFailedWorkflows(engine);
      storage.resetObservations();

      const result = await engine.list({
        failureCategory: 'application',
        idPrefix: 'application-',
      });

      expect(result.items.map((item) => item.id)).toEqual(['application-1']);
      expect(storage.countScans('wf:')).toBe(0);
      expect(storage.countScans('wf:application-')).toBe(1);
      expect(storage.countScans('idx:failureCategory:s:application:')).toBe(1);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('does not use previous failureCategory index names for top-level list filters', async () => {
    const storage = new ScanCountingStorage();
    const engine = new Engine({ storage });
    try {
      await createFailedWorkflows(engine);
      const stateBytes = await storage.get(KEYS.workflow('application-1'));
      expect(stateBytes).not.toBeNull();

      const state = decode(stateBytes!) as WorkflowState;
      state.failureCategory = 'planning' as never;
      await storage.put(KEYS.workflow('application-1'), encode(state));
      await storage.put(KEYS.attribute('application-1'), encode({ failureCategory: 'planning' }));
      await storage.batch(
        buildIndexOperations(
          'application-1',
          { failureCategory: 'application' },
          { failureCategory: 'planning' },
        ),
      );
      storage.resetObservations();

      const result = await engine.list(
        { failureCategory: 'application' },
        { includeFailureCategory: true },
      );

      expect(result.items).toEqual([]);
      expect(storage.countScans('wf:')).toBe(0);
      expect(storage.countScans('idx:failureCategory:s:application:')).toBe(1);
      expect(storage.countScans('idx:failureCategory:s:planning:')).toBe(0);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('post-filters stale search-attribute index candidates against stored attributes', async () => {
    const storage = new ScanCountingStorage();
    const engine = new Engine({ storage });
    const waitWorkflow = workflow({ name: 'attribute-post-filter' }).execute(async function* (ctx) {
      yield* ctx.waitForSignal('stop');
      return 'done';
    });
    engine.register(waitWorkflow);

    try {
      await engine.start('attribute-post-filter', null, {
        id: 'attribute-post-filter-selected',
        searchAttributes: { region: 'us-east' },
      });
      await engine.start('attribute-post-filter', null, {
        id: 'attribute-post-filter-stale-index',
        searchAttributes: { region: 'eu-west' },
      });

      await storage.batch(
        buildIndexOperations(
          'attribute-post-filter-stale-index',
          { region: 'eu-west' },
          { region: 'us-east' },
        ),
      );
      storage.resetObservations();

      const result = await engine.list({
        attributes: [{ key: 'region', value: 'us-east' }],
      });

      expect(result.items.map((item) => item.id)).toEqual(['attribute-post-filter-selected']);
      expect(storage.countScans('idx:region:s:us-east:')).toBe(1);
      expect(storage.countGets(KEYS.attribute('attribute-post-filter-selected'))).toBe(1);
      expect(storage.countGets(KEYS.attribute('attribute-post-filter-stale-index'))).toBe(1);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('returns the same attribute any-of matches when visibility indexes are current or stale', async () => {
    const storage = new ScanCountingStorage();
    const engine = new Engine({ storage });
    const waitWorkflow = workflow({ name: 'attribute-visibility-parity' }).execute(
      async function* (ctx) {
        yield* ctx.waitForSignal('stop');
        return 'done';
      },
    );
    engine.register(waitWorkflow);

    try {
      await engine.start('attribute-visibility-parity', null, {
        id: 'attribute-visibility-east',
        searchAttributes: { region: 'us-east' },
      });
      await engine.start('attribute-visibility-parity', null, {
        id: 'attribute-visibility-west',
        searchAttributes: { region: 'eu-west' },
      });
      await engine.start('attribute-visibility-parity', null, {
        id: 'attribute-visibility-south',
        searchAttributes: { region: 'ap-south' },
      });
      await storage.put(
        KEYS.workflowVisibilityMetaVersion(),
        encode(WORKFLOW_VISIBILITY_INDEX_VERSION),
      );

      const filter = {
        status: 'running' as const,
        attributes: [{ key: 'region', value: ['us-east', 'eu-west'] }],
      };

      getInternals(engine).workflowVisibilityWatermark = undefined;
      const currentResult = await engine.list(filter);
      const currentAggregate = await engine.aggregate(filter, { groupBy: 'status' });

      await storage.delete(KEYS.workflowVisibilityMetaVersion());
      getInternals(engine).workflowVisibilityWatermark = undefined;
      const staleResult = await engine.list(filter);
      const staleAggregate = await engine.aggregate(filter, { groupBy: 'status' });

      const expectedIds = ['attribute-visibility-east', 'attribute-visibility-west'];
      expect(currentResult.items.map((item) => item.id).toSorted()).toEqual(expectedIds);
      expect(staleResult.items.map((item) => item.id).toSorted()).toEqual(expectedIds);
      expect(staleAggregate).toEqual(currentAggregate);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('uses indexed failureCategory candidates for aggregate filters', async () => {
    const storage = new ScanCountingStorage();
    const engine = new Engine({ storage });
    try {
      await createFailedWorkflows(engine);
      storage.resetObservations();

      const result = await engine.aggregate(
        { failureCategory: ['application', 'resource'] },
        { groupBy: 'failureCategory' },
      );

      expect(result).toEqual({
        total: 2,
        groups: [
          { key: 'application', count: 1 },
          { key: 'resource', count: 1 },
        ],
        truncated: false,
      });
      expect(storage.countScans('wf:')).toBe(0);
      expect(storage.countScans('idx:failureCategory:s:application:')).toBe(1);
      expect(storage.countScans('idx:failureCategory:s:resource:')).toBe(1);
    } finally {
      engine[Symbol.dispose]();
    }
  });
});
