import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { rejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { KEYS } from '../../storage/keys.ts';
import { decode } from '../codec.ts';
import {
  workflow,
  type BulkOperationDryRunResult,
  type PurgeResult,
  type WorkflowContext,
} from '../types.ts';
import { BulkOperationConfirmationError } from './errors.ts';
import { Engine } from './index.ts';

async function storeContents(storage: MemoryStorage): Promise<[string, string][]> {
  const entries: [string, string][] = [];
  for await (const [key, value] of storage.scan('')) {
    entries.push([key, Buffer.from(value).toString('base64')]);
  }
  return entries.toSorted(([left], [right]) => (left < right ? -1 : 1));
}

/** Refuses the commit that deletes one run, once armed, as a storage that fails for that run alone would. */
class PurgeFailingStorage extends MemoryStorage {
  failingWorkflowId: string | undefined;

  override conditionalBatch(
    ...[conditions, operations]: Parameters<MemoryStorage['conditionalBatch']>
  ): ReturnType<MemoryStorage['conditionalBatch']> {
    const failingKey =
      this.failingWorkflowId === undefined ? undefined : KEYS.workflow(this.failingWorkflowId);
    if (failingKey !== undefined && conditions.some((condition) => condition.key === failingKey)) {
      return Promise.reject(new Error('disk full'));
    }
    return super.conditionalBatch(conditions, operations);
  }
}

async function engineWithCompletedRuns(
  ids: readonly string[],
  storage: MemoryStorage = new MemoryStorage(),
) {
  const engine = new Engine({ storage });
  engine.register(
    workflow({ name: 'echo' }).execute(async function* (_ctx: WorkflowContext, input: unknown) {
      yield* [];
      return input;
    }),
  );
  for (const id of ids) {
    const handle = await engine.start('echo', id, { id });
    await handle.result();
  }
  return { engine, storage };
}

describe('engine.purge with options (COR-2521)', () => {
  it('a dry run returns the bulk dry-run result and writes nothing', async () => {
    const { engine, storage } = await engineWithCompletedRuns(['a', 'b', 'c']);
    await using _engine = engine;
    const before = await storeContents(storage);

    const preview = await engine.purge({ status: 'completed' }, { dryRun: true });

    expect(preview).toMatchObject({
      dryRun: true,
      action: 'purge',
      matched: 3,
      sampleWorkflowIds: ['a', 'b', 'c'],
      confirmationTokenVersion: 1,
    });
    expect(preview.confirmationToken).toStartWith('bulk:');
    expect(preview.scope).toMatchObject({ matched: 3, statuses: ['completed'] });
    expect(await storeContents(storage)).toEqual(before);
  });

  it('commits exactly the previewed runs with the token, and reports an audit event', async () => {
    const { engine } = await engineWithCompletedRuns(['a', 'b']);
    await using _engine = engine;
    const preview = await engine.purge(undefined, { dryRun: true, requestId: 'purge-request' });

    const result = await engine.purge(undefined, {
      confirmationToken: preview.confirmationToken,
      requestId: 'purge-request',
    });

    expect(result.deleted).toBe(2);
    expect(result.auditEvent).toMatchObject({
      action: 'purge',
      requestId: 'purge-request',
      affectedCount: 2,
      confirmationToken: preview.confirmationToken,
    });
    expect(await engine.get('a')).toBeNull();
    expect(await engine.get('b')).toBeNull();
  });

  it('refuses a token the filter no longer produces, and deletes nothing', async () => {
    const { engine, storage } = await engineWithCompletedRuns(['a', 'b']);
    await using _engine = engine;
    const preview = await engine.purge({ status: 'completed' }, { dryRun: true });
    const late = await engine.start('echo', 'late', { id: 'late' });
    await late.result();
    const before = await storeContents(storage);

    const refusal = await rejectionOf(
      engine.purge({ status: 'completed' }, { confirmationToken: preview.confirmationToken }),
    );

    expect(refusal).toBeInstanceOf(BulkOperationConfirmationError);
    expect(await storeContents(storage)).toEqual(before);
  });

  it('a token from another filter is refused', async () => {
    const { engine } = await engineWithCompletedRuns(['a']);
    await using _engine = engine;
    const preview = await engine.purge({ type: 'echo' }, { dryRun: true });

    const refusal = await rejectionOf(
      engine.purge({ type: 'other' }, { confirmationToken: preview.confirmationToken }),
    );

    expect(refusal).toBeInstanceOf(BulkOperationConfirmationError);
    expect(await engine.get('a')).not.toBeNull();
  });

  it('previews what a purge would remove: terminal runs past the offset and within the limit', async () => {
    const { engine } = await engineWithCompletedRuns(['a', 'b', 'c', 'd']);
    await using _engine = engine;
    engine.register(
      workflow({ name: 'parked' }).execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.waitForSignal('go');
      }),
    );
    await engine.start('parked', null, { id: 'still-running' });

    const everything = await engine.purge(undefined, { dryRun: true });
    expect(everything.matched).toBe(4);
    expect(everything.sampleWorkflowIds).not.toContain('still-running');

    const window = await engine.purge({ offset: 1, limit: 2 }, { dryRun: true });
    expect(window.matched).toBe(2);
    const committed = await engine.purge(
      { offset: 1, limit: 2 },
      { confirmationToken: window.confirmationToken },
    );
    expect(committed.deleted).toBe(2);
    // Not terminal, so no purge may take it: it is still starting or parked.
    const stillRunning = await engine.get('still-running');
    expect(['pending', 'running']).toContain(stillRunning?.status ?? 'gone');
    // The two the window named are gone, and the two outside it remain.
    const states = await Promise.all(['a', 'b', 'c', 'd'].map((id) => engine.get(id)));
    expect(states.filter((state) => state !== null)).toHaveLength(2);
  });

  it('skips a run that owes a finalizer, as the immediate purge does', async () => {
    const { engine, storage } = await engineWithCompletedRuns(['a', 'b']);
    await using _engine = engine;
    await storage.put(KEYS.teardownOwed('a'), new Uint8Array([1]));

    const preview: BulkOperationDryRunResult = await engine.purge(undefined, { dryRun: true });

    expect(preview.matched).toBe(1);
    expect(preview.sampleWorkflowIds).toEqual(['b']);
  });

  it('writes the audit event of the deletes that committed, with the failure on it, before it throws', async () => {
    const storage = new PurgeFailingStorage();
    const { engine } = await engineWithCompletedRuns(['a', 'b'], storage);
    await using _engine = engine;
    const preview = await engine.purge(undefined, { dryRun: true, requestId: 'partial' });
    storage.failingWorkflowId = 'b';

    const failure = await rejectionOf(
      engine.purge(undefined, {
        confirmationToken: preview.confirmationToken,
        requestId: 'partial',
        principal: { method: 'api-key', subject: 'operator' },
      }),
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe(
      'Purge failed for 1 workflow(s) after deleting 1 workflow(s)',
    );
    expect(await engine.get('a')).toBeNull();
    expect(await engine.get('b')).not.toBeNull();
    const audits: Record<string, unknown>[] = [];
    for await (const [, value] of storage.scan(KEYS.bulkOperationAuditPrefix())) {
      audits.push(decode(value) as Record<string, unknown>);
    }
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      type: 'bulk-operation:audit',
      action: 'purge',
      requestId: 'partial',
      principal: { method: 'api-key', subject: 'operator' },
      affectedCount: 1,
      failedCount: 1,
      errors: [{ id: 'b', error: 'disk full' }],
      confirmationToken: preview.confirmationToken,
    });
  });

  it('writes no failure fields on the audit event of a purge that fully succeeds', async () => {
    const storage = new MemoryStorage();
    const { engine } = await engineWithCompletedRuns(['a'], storage);
    await using _engine = engine;
    const preview = await engine.purge(undefined, { dryRun: true });

    const result = await engine.purge(undefined, {
      confirmationToken: preview.confirmationToken,
    });

    expect(Object.hasOwn(result.auditEvent ?? {}, 'failedCount')).toBe(false);
    expect(Object.hasOwn(result.auditEvent ?? {}, 'errors')).toBe(false);
  });

  it('with no options purges at once, as before', async () => {
    const { engine } = await engineWithCompletedRuns(['a', 'b']);
    await using _engine = engine;

    const result: PurgeResult = await engine.purge({ status: 'completed' });

    expect(result).toEqual({ deleted: 2 });
  });
});
