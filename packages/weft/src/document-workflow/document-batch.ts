/**
 * Lockstep rounds over the item generators of a `map` batch, and of a `parallel` step a run began
 * before its branches advanced on their own (see `runParallel` in the interpreter).
 *
 * @module document-workflow/document-batch
 */

import type { ContextOperationRequest } from '../core/context/operation-request.ts';
import { forgetEarlierRoundResults, markRound } from '../core/context/round-results.ts';
import type { WorkflowContext } from '../core/types.ts';

/**
 * A settled round reports a rejection in its durable `{ name, message }` form, on
 * the live run and on a replay alike. Rebuild an `Error` before throwing it into
 * the item's generator so retry policies (`nonRetryableErrors`) and the run's
 * failure see an error, not a plain record.
 */
function rejectionError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const { name, message } = (typeof reason === 'object' && reason !== null ? reason : {}) as {
    name?: unknown;
    message?: unknown;
  };
  const error = new Error(typeof message === 'string' ? message : String(reason));
  if (typeof name === 'string') error.name = name;
  return error;
}

/**
 * Advance every item generator one operation at a time through `ctx.allSettled`, so the items'
 * operations of one round settle together; a rejected operation is thrown into its own item.
 * Returns each item's result, in order.
 */
export function* runMapBatch(
  context: WorkflowContext,
  generators: Generator<ContextOperationRequest, unknown, unknown>[],
): Generator<ContextOperationRequest, unknown[], unknown> {
  const itemResults: unknown[] = Array.from({ length: generators.length });
  let pending: {
    generator: Generator<ContextOperationRequest, unknown, unknown>;
    itemIndex: number;
    resume: { kind: 'next'; value: unknown } | { kind: 'throw'; error: unknown };
  }[] = generators.map((generator, itemIndex) => ({
    generator,
    itemIndex,
    resume: { kind: 'next', value: undefined },
  }));
  while (pending.length > 0) {
    // The items resume below with the outcomes of the round before, and record them under that
    // round's numbers; the round's own entry holds them, so they are forgotten once recorded and
    // a replay asks for every operation again (see `round-results.ts`).
    const mark = markRound(context);
    const nextPending: typeof pending = [];
    const operations: Generator<ContextOperationRequest, unknown, unknown>[] = [];
    for (const entry of pending) {
      const next =
        entry.resume.kind === 'throw'
          ? entry.generator.throw(entry.resume.error)
          : entry.generator.next(entry.resume.value);
      if (next.done) itemResults[entry.itemIndex] = next.value;
      else {
        operations.push(
          (function* (): Generator<ContextOperationRequest, unknown, unknown> {
            return yield next.value;
          })(),
        );
        nextPending.push(entry);
      }
    }
    forgetEarlierRoundResults(context, mark);
    if (operations.length === 0) break;
    const operationResults = yield* context.allSettled(operations) as unknown as Generator<
      ContextOperationRequest,
      unknown[],
      unknown
    >;
    for (let resultIndex = 0; resultIndex < nextPending.length; resultIndex++) {
      const outcome = operationResults[resultIndex] as
        { status: 'fulfilled'; value: unknown } | { status: 'rejected'; reason: unknown };
      nextPending[resultIndex]!.resume =
        outcome.status === 'fulfilled'
          ? { kind: 'next', value: outcome.value }
          : { kind: 'throw', error: rejectionError(outcome.reason) };
    }
    pending = nextPending;
  }
  return itemResults;
}
