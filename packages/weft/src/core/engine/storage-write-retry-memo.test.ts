/**
 * COR-1626: the checkpoint a `durableActivity()` persists for its retry sleep goes through the
 * data-operation persist (`persistCheckpointForDataOperation`, the memo's operation path), which is
 * retried like every other checkpoint batch. When every attempt is refused the helper's promise
 * rejects with `CheckpointCommitFailedError` and nothing abandons the run: whether the run then
 * fails is up to the workflow, and one that catches the rejection keeps running.
 */
import { expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { durableActivity } from '../context/durable-activity.ts';
import { Engine } from '../engine.ts';
import { activity, workflow, type WorkflowContext } from '../types.ts';
import { CheckpointCommitFailedError } from './checkpoint-commit-failed-error.ts';
import { abandonedExecutionAttemptCount } from './execution-attempts.ts';
import { getInternals } from './internals.ts';
import { createRefusingStorage, putsCheckpoint } from './storage-write-refusal.test-support.ts';

const ATTEMPTS = 5;

it('retries the retry sleep checkpoint five times, then rejects the helper and leaves the run alone', async () => {
  const refusing = createRefusingStorage(new MemoryStorage());
  const caught: unknown[] = [];
  const flakyTool = activity({
    name: 'flakyTool',
    retry: { maxAttempts: 2, initialBackoff: 5_000, backoffMultiplier: 1, maxBackoff: 5_000 },
    execute: async (tool: string) => {
      // The first attempt fails, so the helper persists a checkpoint for its retry sleep next:
      // refuse exactly that one commit, and let everything after it through.
      refusing.arm();
      refusing.refuse({ matches: putsCheckpoint('memo-retry-sleep'), times: ATTEMPTS });
      throw new Error(`transient failure of ${tool}`);
    },
    verify: (_result, context) =>
      context?.phase === 'pre-dispatch-reconciliation' ? 'not-completed' : true,
  });
  const definition = workflow({ name: 'memo-retry-sleep-refused' })
    .activities({ flakyTool })
    .execute(async function* (ctx: WorkflowContext) {
      return yield* ctx.memo('step-0', async () => {
        try {
          return await durableActivity(flakyTool, 'lookup', { idempotencyKey: 'retry:lookup' });
        } catch (error) {
          caught.push(error);
          return 'the workflow caught the rejection';
        }
      });
    });
  await using engine = new Engine({
    storage: refusing.storage,
    backgroundTasks: 'manual',
  });
  engine.register(definition);
  getInternals(engine).storageWriteRetryDelaysForTesting = [0, 0, 0, 0];

  const handle = await engine.start(definition.name, null, { id: 'memo-retry-sleep' });

  expect(await handle.result()).toBe('the workflow caught the rejection');
  expect(caught).toHaveLength(1);
  expect(caught[0]).toBeInstanceOf(CheckpointCommitFailedError);
  expect((caught[0] as CheckpointCommitFailedError).write).toBe('checkpoint');
  expect((caught[0] as CheckpointCommitFailedError).attempts).toBe(ATTEMPTS);
  expect(
    refusing.attemptsMatching(putsCheckpoint('memo-retry-sleep')).slice(0, ATTEMPTS),
  ).toSatisfy((attempts: readonly { outcome: string }[]) =>
    attempts.every((attempt) => attempt.outcome === 'refused'),
  );
  // The data-operation persist abandons a run for a lost race only, never for a refused write.
  expect(abandonedExecutionAttemptCount(getInternals(engine))).toBe(0);
});
