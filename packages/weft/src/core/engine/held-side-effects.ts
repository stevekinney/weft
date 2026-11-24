/**
 * Side effects a coordinator holds for its own commits instead of the workflow's staged buffer.
 *
 * A wait branch of `ctx.all` or of a document `parallel` step consumes its signal by staging a
 * delete into the next checkpoint. The workflow's staged buffer is flushed by whichever commit runs
 * next, and a coordinator that commits while its branches still run would flush a consume a sibling
 * staged before that sibling's result is in the entry it writes: a restart then finds the signal
 * gone and the branch that took it starting over.
 *
 * So such a coordinator finalizes a branch's envelope into a {@link HeldSideEffects}, records the
 * branch's result, and only then commits the held effects, in a commit that carries nothing from
 * the staged buffer (see `sideEffects` in `checkpoint-io.ts`). What it still holds when it settles
 * goes to the staged buffer, for the commit that settles the operation with every result in it.
 *
 * @module engine/held-side-effects
 */

import type { ContextOperationRequest } from '../context.ts';
import {
  stageAtomicWorkflowCommitSideEffects,
  stageOperationSideEffects,
  type AtomicWorkflowCommitSideEffects,
} from './checkpoint-side-effects.ts';
import type { EngineInternals } from './internals.ts';
import type { CapturedSideEffectSink } from './side-effect-capture.ts';

/**
 * Receives the side effects a consume would have staged, and the execution token it would have
 * bound them to.
 */
export type SideEffectHold = (
  sideEffects: AtomicWorkflowCommitSideEffects,
  workflowExecutionToken: string | undefined,
) => void;

type Held = {
  sideEffects: AtomicWorkflowCommitSideEffects;
  token: string | undefined;
  bound: boolean;
};

export class HeldSideEffects {
  #held: Held[] = [];

  /** Hold a consume's side effects: pass this to `finalizeAndUnwrap`. */
  readonly hold: SideEffectHold = (sideEffects, token) => {
    this.#held.push({ sideEffects, token, bound: true });
  };

  /** Hold an effect a branch operation staged: the sink of its capture (`side-effect-capture.ts`). */
  readonly keep: CapturedSideEffectSink = (sideEffects, token, bound) => {
    this.#held.push({ sideEffects, token, bound });
  };

  /** Move everything held to `target`, which commits it from now on. */
  moveTo(target: HeldSideEffects): void {
    for (const entry of this.#held) target.#held.push(entry);
    this.#held = [];
  }

  /**
   * Run `commit` with everything held, which it writes in its batch (none, possibly). What it took
   * is held again should it throw, and the error rethrown.
   */
  async commitWith(
    commit: (sideEffects: AtomicWorkflowCommitSideEffects) => Promise<void>,
  ): Promise<void> {
    const taken = this.#held;
    this.#held = [];
    try {
      await commit({
        conditions: taken.flatMap((entry) => entry.sideEffects.conditions),
        operations: taken.flatMap((entry) => entry.sideEffects.operations),
      });
    } catch (error) {
      this.#held = [...taken, ...this.#held];
      throw error;
    }
  }

  /**
   * Hand what is still held to the workflow's staged buffer, as it would have been staged, or,
   * given the `operation` that holds it, to the capture a coordinator attached to that operation,
   * which commits it with the operation's result.
   */
  stageRemaining(
    internals: EngineInternals,
    workflowId: string,
    operation?: ContextOperationRequest,
  ): void {
    const remaining = this.#held;
    this.#held = [];
    for (const entry of remaining) {
      if (operation === undefined) {
        stageAtomicWorkflowCommitSideEffects(
          internals,
          workflowId,
          entry.sideEffects,
          entry.token,
          entry.bound,
        );
      } else {
        stageOperationSideEffects(
          internals,
          workflowId,
          operation,
          entry.sideEffects,
          entry.token,
          entry.bound,
        );
      }
    }
  }
}
