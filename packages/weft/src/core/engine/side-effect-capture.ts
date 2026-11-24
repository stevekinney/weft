/**
 * Which branch operation of a running coordinator staged a side effect for the next checkpoint.
 *
 * A coordinator that commits while its branches still run (`ctx.all` committing a settled slot, a
 * document `parallel` committing a branch's step) must write each side effect a branch's operation
 * staged (a child's cancellation link, an activity's reconciliation receipt) in the commit that
 * records that operation's result: not earlier, where a crash would leave the effect without its
 * result, and not later, where it would leave the result without its effect. The workflow's staged
 * buffer is one per workflow, so the coordinator attaches a capture to each branch operation it
 * runs, and the code that stages an effect for an operation ({@link stageOperationSideEffects} in
 * `checkpoint-side-effects.ts`) hands it to that operation's capture instead of the buffer.
 *
 * The capture travels with the operation request itself, explicitly: a coordinator nested in a
 * branch passes it on to the operations it runs. Nothing depends on an ambient async context, so
 * the guarantee is the same in a runtime without `node:async_hooks` (a Web Worker, say).
 *
 * @module engine/side-effect-capture
 */

import type { BatchOperation, ConditionalBatchCondition } from "../../embedded/storage/src/index.ts";

import type { ContextOperationRequest } from '../context.ts';

type SideEffects = { conditions: ConditionalBatchCondition[]; operations: BatchOperation[] };

/** Receives an effect staged for a captured operation: what it would have staged, and how. */
export type CapturedSideEffectSink = (
  sideEffects: SideEffects,
  workflowExecutionToken: string | undefined,
  bindToExecutionGeneration: boolean,
) => void;

type Capture = { readonly sink: CapturedSideEffectSink; open: boolean };

const CAPTURES = new WeakMap<ContextOperationRequest, Capture>();

/**
 * Catch what `request`, a branch operation about to run, stages for the checkpoint, for `sink`.
 * Returns the function that ends the capture once the operation has settled: an effect staged
 * for it after that goes to the workflow's staged buffer, for the commit that settles the step.
 */
export function captureSideEffects(
  request: ContextOperationRequest,
  sink: CapturedSideEffectSink,
): () => void {
  const capture: Capture = { sink, open: true };
  CAPTURES.set(request, capture);
  return () => {
    capture.open = false;
  };
}

/** Give each of `children`, the operations `parent` runs, the capture `parent` has, if any. */
export function inheritSideEffectCapture(
  parent: ContextOperationRequest,
  children: readonly ContextOperationRequest[],
): void {
  const capture = CAPTURES.get(parent);
  if (capture === undefined) return;
  for (const child of children) {
    if (CAPTURES.get(child)?.open !== true) CAPTURES.set(child, capture);
  }
}

/** The sink of `request`'s open capture, if a coordinator attached one. */
export function capturedSideEffectSinkOf(
  request: ContextOperationRequest,
): CapturedSideEffectSink | undefined {
  const capture = CAPTURES.get(request);
  return capture?.open === true ? capture.sink : undefined;
}
