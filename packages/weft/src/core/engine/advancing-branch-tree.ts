/**
 * What the advancing parallel steps of one top-level step share (see `advancing-branches.ts`): one
 * chain their sections run on, the consumes they hold, and the operations every branch has open at
 * any depth, so a step nested in a branch commits through the top-level step and sees every wait
 * open in the tree.
 *
 * @module engine/advancing-branch-tree
 */

import type { ContextOperationRequest } from '../context.ts';
import type { ParallelOperationCacheEntry } from '../context/parallel-cache-entry.ts';
import { HeldSideEffects } from './held-side-effects.ts';

/**
 * What every advancing step nested in one top-level step shares with it: the chain its sections
 * run on, the consumes it holds, and the operations every branch has open, at any depth.
 */
export type BranchTree = {
  /** Run `section` after every section of the tree before it. A section never rejects. */
  inOrder: <Result>(section: () => Promise<Result>) => Promise<Result>;
  held: HeldSideEffects;
  /** The operation each branch of the tree has open, by run and branch. */
  open: Map<string, ContextOperationRequest>;
  /** The nested steps whose runs have begun, which register their own branches' operations. */
  started: WeakSet<ContextOperationRequest>;
  /** Resolves the next time a branch of the tree closes an operation. */
  changed: () => Promise<void>;
  notifyChanged: () => void;
  nextRunId: number;
};

export function createBranchTree(): BranchTree {
  let chain: Promise<void> = Promise.resolve();
  let changed = Promise.withResolvers<void>();
  return {
    inOrder: (section) => {
      const result = chain.then(section);
      chain = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    held: new HeldSideEffects(),
    open: new Map(),
    started: new WeakSet(),
    changed: () => changed.promise,
    notifyChanged: () => {
      const previous = changed;
      changed = Promise.withResolvers<void>();
      previous.resolve();
    },
    nextRunId: 0,
  };
}

/**
 * How an advancing step nested in a branch of another reports to it: through the tree they share,
 * by writing its progress under its own step number in the branch's results, and by committing
 * through the step that owns the branch.
 */
export type NestedLink = {
  tree: BranchTree;
  /** Keep `entry`, the nested step's progress, in the results of the branch it is a step of. */
  record: (entry: ParallelOperationCacheEntry) => void;
  /** Commit the owning step's progress, which now carries the nested step's. Runs in a section. */
  commit: () => Promise<void>;
};

const NESTED_LINKS = new WeakMap<ContextOperationRequest, NestedLink>();

/** Link `request`, an advancing step a branch is about to run, to the step that owns the branch. */
export function linkNestedStep(request: ContextOperationRequest, link: NestedLink): void {
  NESTED_LINKS.set(request, link);
}

/** The link of an advancing step a branch of another runs, or `undefined` for any other. */
export function nestedLinkOf(request: ContextOperationRequest): NestedLink | undefined {
  return NESTED_LINKS.get(request);
}

/** Add to `names` every signal `request` waits on, through every coordinator it holds. */
export function collectWaitNames(
  request: ContextOperationRequest,
  started: WeakSet<ContextOperationRequest>,
  names: Set<string>,
): void {
  if (request.type === 'wait-signal') {
    names.add(request.signalName);
    return;
  }
  if (request.type !== 'race' && request.type !== 'parallel') return;
  // A nested step whose run has begun has its branches' operations open in the tree itself; its
  // own operations are only the first of each.
  if (started.has(request)) return;
  for (const operation of request.operations) collectWaitNames(operation, started, names);
}

/** Abort `controller` when `parentSignal` does; returns the function that stops following it. */
export function followParentSignal(
  parentSignal: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (parentSignal === undefined) return () => undefined;
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abortFromParent();
  parentSignal.addEventListener('abort', abortFromParent, { once: true });
  return () => parentSignal.removeEventListener('abort', abortFromParent);
}
