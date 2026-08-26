import type { WorkflowResultWaiter } from './engine-internal-types.ts';
import { EngineDisposedError } from './errors.ts';
import { WorkflowHandle } from './handles.ts';
import type { EngineInternals } from './internals.ts';
import { loadWorkflowResult, loadWorkflowState } from './storage-io.ts';
import { confirmWakeOwnership } from './wake-ownership-guard.ts';

export function createWorkflowHandleWithResultPromise(
  internals: EngineInternals,
  workflowId: string,
): WorkflowHandle {
  const handle = new WorkflowHandle(workflowId, internals.engine);
  cacheHandle(internals, workflowId, handle);
  return handle;
}

export function createWorkflowResultWaiter(
  internals: EngineInternals,
  workflowId: string,
): WorkflowResultWaiter {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const waiter = { promise, resolve, reject };
  internals.resultResolvers.set(workflowId, waiter);
  void promise.catch(() => {});
  return waiter;
}

export function getWorkflowResultPromise(
  internals: EngineInternals,
  workflowId: string,
): Promise<unknown> {
  const existingWaiter = internals.resultResolvers.get(workflowId);
  if (existingWaiter) {
    return existingWaiter.promise;
  }

  // A result() call after disposal would otherwise register a fresh waiter in a
  // map the torn-down engine can never settle (the bootstrap returns without
  // resolving for a still-running workflow). Reject up front instead of leaking
  // a promise that never settles. Mirrors disposeEngine rejecting in-flight
  // waiters.
  if (internals.disposed) {
    const rejected = Promise.reject(new EngineDisposedError());
    // Attach a no-op catch so a caller that wires up its own handler in a later
    // microtask (or drops the promise) does not trip an unhandled-rejection
    // warning, matching the guard on waiter promises in createWorkflowResultWaiter.
    void rejected.catch(() => {});
    return rejected;
  }

  const waiter = createWorkflowResultWaiter(internals, workflowId);
  void bootstrapWorkflowResultResolver(internals, workflowId, waiter).then(() =>
    scheduleCrossEngineResultPollIfPending(internals, workflowId, waiter),
  );
  return waiter.promise;
}

/**
 * Result promise for a parent generator parked on `ctx.startChild()`'s
 * default `parentClosePolicy: 'await'` — the ONLY intended caller (see
 * `child-workflow.ts`'s `executeChildWorkflow`, which must call this instead
 * of the plain `childHandle.result()` / `handle.result()` path). Identical to
 * {@link getWorkflowResultPromise} except the waiter this settles is marked
 * generator-owned for `parentWorkflowId`: under `ownership: 'workflow-lease'`
 * a settle attempt first confirms `parentWorkflowId` still holds the claim
 * generation it parked under (`confirmWakeOwnership`, `'child-completion'`),
 * fencing duplicate generator advancement (WFT-79 F1) — see
 * {@link bootstrapWorkflowResultResolver}. Top-level, non-generator callers
 * must keep using {@link getWorkflowResultPromise}, which stays unfenced by
 * design: cross-engine `handle.result()` polling has no generator to
 * duplicate and must remain settleable from durable state alone.
 *
 * If `internals.resultResolvers` already holds a waiter for `workflowId` —
 * e.g. an observational `handle.result()` caller got there first — that
 * SHARED waiter is marked generator-owned too, so the observational caller's
 * promise inherits this fencing. See {@link generatorOwnedWaiters}'s doc for
 * why this mixed-caller case is accepted rather than resolved.
 */
export function getGeneratorOwnedWorkflowResultPromise(
  internals: EngineInternals,
  workflowId: string,
  parentWorkflowId: string,
): Promise<unknown> {
  return fenceResultOnParentGeneration(
    internals,
    parentWorkflowId,
    getWorkflowResultPromise(internals, workflowId),
  );
}

/**
 * Withhold a settled child result from a parent generator that no longer holds
 * the claim generation it parked under.
 *
 * This wraps the SHARED waiter's promise rather than marking the waiter itself.
 * `internals.resultResolvers` dedupes to one waiter per workflow id, so an
 * observational `handle.result()` caller and a parked parent can attach to the
 * same waiter in either order. Marking that shared entry applied the parent's
 * fence to the observer too, and a deposed parent then starved an unrelated
 * caller of a result that was already durable — so the fence lives on the
 * parent's view, and the shared waiter settles normally for everyone else.
 *
 * A discarded parent's promise never settles, matching every other discarded
 * claim-requiring wake: the successor engine replays that parent, and this
 * engine's copy must not advance. Inert under `ownership: 'none'`/`'lease'`,
 * where `confirmWakeOwnership` always proceeds.
 */
function fenceResultOnParentGeneration(
  internals: EngineInternals,
  parentWorkflowId: string,
  promise: Promise<unknown>,
): Promise<unknown> {
  const gate = Promise.withResolvers<unknown>();
  void promise
    .then(
      async (value) => {
        if (await parentStillOwnsGeneration(internals, parentWorkflowId)) gate.resolve(value);
      },
      async (error: unknown) => {
        if (await parentStillOwnsGeneration(internals, parentWorkflowId)) gate.reject(error);
      },
    )
    .catch(() => {
      // Unreachable in practice: `parentStillOwnsGeneration` swallows its own
      // failures. Present so a future edit cannot turn a stray rejection into
      // an unhandled one.
    });
  return gate.promise;
}

async function parentStillOwnsGeneration(
  internals: EngineInternals,
  parentWorkflowId: string,
): Promise<boolean> {
  try {
    return (
      (await confirmWakeOwnership(internals, parentWorkflowId, 'child-completion')) === 'proceed'
    );
  } catch {
    // A thrown pre-check is not a confirmed loss of the claim, and this fence
    // is only a cheap guard — the epoch-conditioned durable write the parent
    // makes next is the real backstop. Proceeding matches
    // `confirmWakeOwnership`'s own documented thrown-read policy; swallowing
    // the throw into a withheld result would strand the parent permanently on
    // a transient blip.
    return true;
  }
}

/**
 * Closes the cross-engine parent/child completion gap ADR 0002 § Open
 * questions names as a blocking correctness gap: `WorkflowHandle.result()`
 * (the sole production path here, per `[HANDLE_RESULT_PROMISE]` in
 * `index.ts` — used for BOTH top-level handles and `ctx.startChild()`'s
 * default `parentClosePolicy: 'await'`) settles purely through the in-memory
 * `resultResolvers` map, which only `termination/complete.ts`'s terminal
 * paths on the OWNING engine ever resolve. Under `ownership: 'workflow-lease'`
 * a workflow can terminate on a DIFFERENT engine than the one holding this
 * waiter — e.g. a parent's owner crashes mid-await (an in-flight
 * `ctx.startChild()` await is never checkpointed, so nothing marks it
 * "parked"; replay re-runs it from scratch) and a successor engine takes over
 * the parent while some other engine independently takes over the still-
 * running child. That successor's in-memory map is never touched by the
 * child's eventual termination, so the parent would hang forever without
 * this poll.
 *
 * This is ADR 0002's "durable child-terminal notification the parent's owner
 * can observe" option, realized as owner-side polling of the child's own
 * persisted `WorkflowState` — the same accepted shape the ADR already uses
 * for cross-engine signal delivery (`owner-side-signal-poll.ts`) — rather
 * than the alternative "child always claimed by its parent's owner" rule.
 * The latter is only true by construction at LAUNCH time (the engine driving
 * the parent's turn is the one that calls `start()` for the child); it is
 * NOT preserved across an independent crash-and-reclaim of parent versus
 * child, and enforcing that through takeover lives in the claim-registry/
 * renewal-task machinery this stage does not own. Polling needs none of
 * that: it only re-reads the already-durable terminal state any workflow's
 * own termination commit already writes, using the EXISTING, idempotent
 * {@link bootstrapWorkflowResultResolver} as its re-check — no new durable
 * record, no new `EngineInternals` field (state lives in this closure, not
 * on `internals`), and no `index.ts`/`internals.ts`/renewal-task changes.
 *
 * WFT-79 F2: terminal delivery for a workflow this engine currently owns
 * normally runs through `termination/complete.ts`'s own ordering —
 * `completeWorkflow()` commits state, then (after concurrency-slot release)
 * `notifyCompletionWaiters()` resolves this same waiter and dispatches
 * completion events. A poll tick that observed the just-committed terminal
 * state and settled the waiter itself, ahead of that ordering, would let
 * `handle.result()` or a parked parent generator observe completion before
 * `notifyCompletionWaiters()`'s in-memory cleanup and event dispatch have
 * run. This function still reads storage on every tick regardless of local
 * claim ownership (see the deliberate choice above) — the race is instead
 * closed inside {@link bootstrapWorkflowResultResolver} via
 * `deferToLocalTerminalDeliveryIfPending`, which gives an in-flight
 * `notifyCompletionWaiters()` one macrotask to resolve+remove this exact
 * waiter before this poll would settle it itself. Skipping the read outright
 * whenever the claim is locally held (an earlier version of this fix) is
 * UNSOUND: local claim ownership does not guarantee THIS engine's own
 * `notifyCompletionWaiters()` will ever run for `workflowId` — e.g. a
 * different, non-claim-holding engine's still-live in-memory generator
 * (started before a claim was ever contested) can independently drive the
 * same workflow to completion first, in which case `completeWorkflow()` on
 * THIS engine finds the state already non-`'running'` and returns without
 * ever calling `notifyCompletionWaiters()` — permanently orphaning this
 * waiter if the poll always deferred to "local ownership implies delivery".
 * (Confirmed by reproduction: `handle-result.test.ts`'s
 * "resolves a pending waiter once the awaited workflow terminates on a
 * DIFFERENT engine" test hangs forever under a skip-the-read version of this
 * fix, because the `seedEngine` in that test keeps a stale in-memory
 * generator racing the claim-holding `engineOwner`.)
 *
 * The only stop conditions for rescheduling are the waiter settling or being
 * replaced (`internals.resultResolvers.get(workflowId) !== waiter`) or being
 * permanently discarded (see {@link discardedGeneratorOwnedWaiters}) — which
 * also covers engine disposal for free: {@link disposeEngine} is fully
 * synchronous and rejects+clears every `resultResolvers` entry before any
 * other code can run, so no separate `internals.disposed` check can ever
 * observe disposal without this map check already having caught it too.
 * Inert under `ownership: 'none'`/`'lease'`, where no claim registry is
 * installed at all.
 */
function scheduleCrossEngineResultPollIfPending(
  internals: EngineInternals,
  workflowId: string,
  waiter: WorkflowResultWaiter,
): void {
  const registry = internals.workflowClaimRegistry;
  if (registry === null) return;
  if (internals.resultResolvers.get(workflowId) !== waiter) return;
  // `backgroundTasks: 'manual'` is documented to start no timers at all; that
  // mode drives this through an awaited `runMaintenance()` instead.
  if (internals.options.backgroundTaskMode !== 'automatic') return;
  const handle = setTimeout(() => {
    void bootstrapWorkflowResultResolver(internals, workflowId, waiter).then(() =>
      scheduleCrossEngineResultPollIfPending(internals, workflowId, waiter),
    );
  }, internals.options.workflowClaimRenewIntervalMs);
  // Never let a pending cross-engine poll hold an otherwise-idle process open,
  // matching the renewal task's own interval handling.
  (handle as { unref?: () => void }).unref?.();
}

/**
 * Settle result waiters for workflows this engine does not own, whose terminal
 * transition lands on another engine and so never touches this engine's
 * in-memory resolver map.
 *
 * Exported for `backgroundTasks: 'manual'`, where no timer runs and the host
 * drives every background step through an awaited `runMaintenance()`.
 */
export async function pollPendingCrossEngineResultWaiters(
  internals: EngineInternals,
): Promise<void> {
  const registry = internals.workflowClaimRegistry;
  if (registry === null) return;

  // Snapshot first: settling a waiter deletes it from the live map, and
  // mutating a Map mid-iteration can skip entries.
  const pending = Array.from(internals.resultResolvers.entries());
  for (const [workflowId, waiter] of pending) {
    // WFT-79 F2: give this engine's own in-flight `notifyCompletionWaiters()`
    // one macrotask to settle the waiter before this poll would, so normal
    // terminal-delivery ordering wins. This must NOT be a bare
    // `currentEpoch(workflowId) !== null` skip: holding the claim does not
    // guarantee this engine's `notifyCompletionWaiters()` ever runs, so an
    // unconditional skip orphans the waiter for as long as the claim is held.
    // The automatic poll uses the same helper for the same reason; the two
    // paths disagreeing is what produced this finding.
    if (await deferToLocalTerminalDeliveryIfPending(internals, workflowId, waiter)) continue;
    try {
      await bootstrapWorkflowResultResolver(internals, workflowId, waiter);
    } catch {
      // Best effort: one unreadable workflow must not stop the others from
      // settling on this tick, and the next tick retries it.
    }
  }
}

/**
 * Outcome of one {@link bootstrapWorkflowResultResolver} attempt, used by
 * this file's callers to decide whether to keep polling:
 *
 * - `'settled'`: the waiter was resolved or rejected.
 * - `'pending'`: no terminal result yet (still running, a transient read
 *   failure under a guaranteed-retry ownership mode, or a discarded
 *   generator-owned waiter's parent — see WFT-79 F1). Keep polling.
 * - `'discarded'`: a generator-owned waiter's parent generation was
 *   confirmed lost; the waiter is deliberately left unsettled forever (see
 *   {@link discardedGeneratorOwnedWaiters}). Callers must stop rescheduling.
 */
type ResultResolutionOutcome = 'settled' | 'pending' | 'discarded';

/**
 * WFT-79 F3: policy shared by both durable reads this function performs
 * (`loadWorkflowState` and `loadWorkflowResult`) for a read failure that says
 * nothing about whether the awaited workflow is actually terminal. Under
 * `ownership: 'workflow-lease'` a guaranteed periodic retry already exists
 * (the `setTimeout` loop in `scheduleCrossEngineResultPollIfPending`, or the
 * host's `runMaintenance()` under `backgroundTasks: 'manual'` driving
 * `pollPendingCrossEngineResultWaiters`), so leave the waiter pending for
 * that retry instead of permanently failing `handle.result()` — including a
 * parked cross-engine parent — on a transient storage blip. Under
 * `ownership: 'none'`/`'lease'` there is no such retry — this bootstrap call
 * is the only chance for either read — so reject immediately there, matching
 * today's behavior.
 */
function settleOrRetryOnTransientReadFailure(
  internals: EngineInternals,
  workflowId: string,
  waiter: WorkflowResultWaiter,
  error: unknown,
): ResultResolutionOutcome {
  if (internals.workflowClaimRegistry === null) {
    clearResultWaiter(internals, workflowId, waiter);
    waiter.reject(error);
    return 'settled';
  }
  return 'pending';
}

/**
 * WFT-79 F2: closes the ordering race described on
 * {@link scheduleCrossEngineResultPollIfPending} without reintroducing the
 * unsound "skip the read whenever locally claimed" version of the fix (see
 * that function's JSDoc for the reproduction that ruled it out). Called only
 * once this function has already decided `waiter` is about to settle from a
 * terminal read. When `workflowId`'s claim is NOT currently held by this
 * engine, there is no ordering race to avoid — proceed immediately (`false`).
 * When it IS held, an in-flight `completeWorkflow()` → `notifyCompletionWaiters()`
 * on THIS engine may be about to resolve+remove this exact waiter; yield one
 * macrotask (`setTimeout(0)`, well past the microtask gap between
 * `completeWorkflow()`'s `releaseWorkflowConcurrencySlot` await and its
 * `notifyCompletionWaiters()` call) to let that happen first, then re-check:
 * a waiter that changed identity or is no longer registered was already
 * settled by that normal path — defer to it (`true`), and the caller must not
 * settle it again. A waiter that is STILL the exact same object was never
 * going to be settled by local terminal delivery (e.g. a different, non-
 * claim-holding engine's stale in-memory generator completed the workflow
 * first — `completeWorkflow()` on THIS engine then found the state already
 * non-`'running'` and returned without ever calling
 * `notifyCompletionWaiters()`); this function's caller is the only path left
 * and must settle it now (`false`).
 */
async function deferToLocalTerminalDeliveryIfPending(
  internals: EngineInternals,
  workflowId: string,
  waiter: WorkflowResultWaiter,
): Promise<boolean> {
  if (internals.workflowClaimRegistry?.currentEpoch(workflowId) == null) {
    return false;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return internals.resultResolvers.get(workflowId) !== waiter;
}

/**
 * Combines the two settle-time guards every terminal-outcome branch of
 * {@link bootstrapWorkflowResultResolver} needs (WFT-79 F1 and F2) into one
 * call, keeping that function's cyclomatic complexity down. Returns
 * `'proceed'` when the caller should go ahead and settle `waiter` itself;
 * otherwise returns the {@link ResultResolutionOutcome} the caller must
 * return immediately without touching `waiter` again.
 */
async function prepareToSettleTerminalWaiter(
  internals: EngineInternals,
  workflowId: string,
  waiter: WorkflowResultWaiter,
): Promise<'proceed' | Extract<ResultResolutionOutcome, 'discarded' | 'settled'>> {
  if (await deferToLocalTerminalDeliveryIfPending(internals, workflowId, waiter)) {
    return 'settled';
  }
  return 'proceed';
}

export async function bootstrapWorkflowResultResolver(
  internals: EngineInternals,
  workflowId: string,
  waiter: WorkflowResultWaiter,
): Promise<ResultResolutionOutcome> {
  let state;
  try {
    state = await loadWorkflowState(internals, workflowId);
  } catch (error) {
    return settleOrRetryOnTransientReadFailure(internals, workflowId, waiter, error);
  }

  if (linkToReplacementWaiter(internals, workflowId, waiter)) {
    return 'settled';
  }

  if (!state) {
    const outcome = await prepareToSettleTerminalWaiter(internals, workflowId, waiter);
    if (outcome !== 'proceed') return outcome;
    internals.resultResolvers.delete(workflowId);
    waiter.reject(new Error(`Workflow "${workflowId}" not found in storage`));
    return 'settled';
  }

  // A suspended workflow has not produced a result and will be resumed later,
  // so the waiter must stay pending — same as running/pending. (For a waiter
  // created before suspend, the existing-waiter branch above already keeps it
  // pending; this covers a fresh result() call made while suspended.)
  if (state.status === 'running' || state.status === 'pending' || state.status === 'suspended') {
    return 'pending';
  }

  const outcome = await prepareToSettleTerminalWaiter(internals, workflowId, waiter);
  if (outcome !== 'proceed') return outcome;

  try {
    const result = await loadWorkflowResult(internals, workflowId);
    clearResultWaiter(internals, workflowId, waiter);
    waiter.resolve(result);
    return 'settled';
  } catch (error) {
    return settleTerminalResultReadFailure(internals, workflowId, waiter, error, state.status);
  }
}

/**
 * Decide what a throw from `loadWorkflowResult()` means for an already-terminal
 * workflow.
 *
 * That helper THROWS the persisted terminal error for `failed`, `cancelled` and
 * `timed-out` — the throw IS the result there, not a read failure. Retrying it
 * leaves the waiter pending forever (re-reading throws again every time), so a
 * parent awaiting a failed child never gets its rejection and hangs.
 * `terminalStatus` is the discriminator: only `completed` reaching here means a
 * genuine storage problem worth retrying.
 *
 * A blip while reading a non-`completed` workflow therefore rejects with the
 * blip rather than the persisted error — deliberate, since rejection is the
 * correct disposition either way and a vaguer error beats a hang.
 */
function settleTerminalResultReadFailure(
  internals: EngineInternals,
  workflowId: string,
  waiter: WorkflowResultWaiter,
  error: unknown,
  terminalStatus: string,
): ResultResolutionOutcome {
  if (terminalStatus !== 'completed') {
    clearResultWaiter(internals, workflowId, waiter);
    waiter.reject(error);
    return 'settled';
  }
  return settleOrRetryOnTransientReadFailure(internals, workflowId, waiter, error);
}

function linkToReplacementWaiter(
  internals: EngineInternals,
  workflowId: string,
  waiter: WorkflowResultWaiter,
): boolean {
  const currentWaiter = internals.resultResolvers.get(workflowId);
  if (currentWaiter === undefined || currentWaiter === waiter) {
    return false;
  }

  void currentWaiter.promise.then(waiter.resolve, waiter.reject);
  return true;
}

function clearResultWaiter(
  internals: EngineInternals,
  workflowId: string,
  waiter: WorkflowResultWaiter,
): void {
  if (internals.resultResolvers.get(workflowId) === waiter) {
    internals.resultResolvers.delete(workflowId);
  }
}

export function cacheHandle(
  internals: EngineInternals,
  workflowId: string,
  handle: WorkflowHandle,
): void {
  const existing = internals.handleCache.get(workflowId);
  if (existing) {
    internals.finalizationRegistry.unregister(existing.unregisterToken);
  }
  const unregisterToken = {};
  internals.handleCache.set(workflowId, {
    ref: new WeakRef(handle),
    unregisterToken,
  });
  internals.finalizationRegistry.register(handle, workflowId, unregisterToken);
}
