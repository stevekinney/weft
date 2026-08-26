/**
 * Owner-side signal polling, specified in
 * [ADR 0002 § Entry point classification](../../../documentation/contributing/architecture-decisions/0002-multiengine-per-workflow-ownership.md)
 * (the paragraph beginning "Signal delivery needs more than a
 * classification").
 *
 * **The problem.** Weft has no cross-engine RPC. A signal sent to any engine
 * is durably buffered — but under `ownership: 'workflow-lease'`, only the
 * engine that owns a workflow inspects its in-memory waiters when a signal
 * arrives. If the signal lands on a NON-owning engine, the durable buffer is
 * written and nobody wakes the owner: a workflow parked on
 * `waitForSignal()` (including a `waitForSignal` branch inside `ctx.race()`)
 * hangs until something unrelated happens to drive it.
 *
 * **The fix.** The owning engine re-checks the durable signal buffer for its
 * OWN parked workflows on the same cadence it renews their claims, and wakes
 * any whose awaited signal has since been buffered — by any engine. This
 * bounds cross-engine signal delivery latency at one renewal interval rather
 * than leaving it unbounded. Owner-side polling is the accepted mechanism;
 * real cross-engine notification would be a later latency optimization, not
 * a correctness fix.
 *
 * **Scope and independence.** This module is the poll pass alone: given a
 * list of this engine's parked signal waits, probe the durable buffer for
 * each, and wake the ones that are ready. It does not read
 * `src/core/engine/signals.ts` or `src/core/engine/inline-parking.ts`
 * directly — the dependencies below are small structural types this module
 * owns, so it stays independent of those modules' concrete shapes. Each
 * type's doc comment names the existing function it satisfies. This module
 * is also NOT a recurring task by itself (compare
 * `workflow-claim-renewal-task.ts`) — it is production-wired by
 * `ownership-bootstrap.ts`'s {@link buildOwnerSideSignalPollTarget}, which
 * composes {@link OwnerSideSignalPollSources} (from `EngineInternals` and
 * `inline-parking.ts`) into a real {@link OwnerSideSignalPollTarget}, and by
 * `workflow-claim-renewal-task.ts`, which calls {@link runOwnerSideSignalPoll}
 * against that target from the same lifecycle cadence that drives claim
 * renewal.
 *
 * @module core/engine/owner-side-signal-poll
 */

/** One workflow parked on `waitForSignal(signalName)` (or a `ctx.race()` branch awaiting it), that this engine owns. */
export type ParkedSignalWait = {
  workflowId: string;
  signalName: string;
};

/**
 * The minimal structural shape this poll needs. Satisfied in production by
 * `ownership-bootstrap.ts`'s `buildOwnerSideSignalPollTarget`, composed from
 * `EngineInternals` and `signals.ts` / `inline-parking.ts` — without this
 * module importing either.
 */
export type OwnerSideSignalPollTarget = {
  /**
   * Every signal wait this engine's currently-parked workflows are awaiting.
   * Read fresh at the start of every pass — implementations may return a
   * live or a defensive-copy array; this poll never mutates it and takes its
   * own snapshot before iterating.
   *
   * Expected to be satisfied by deriving from `EngineInternals.signalWaiters`
   * (a `Map<string, () => void>` keyed by `` `${workflowId}:${signalName}` ``,
   * the same format `src/core/engine/signals.ts`'s `deliverBufferedSignals`
   * reads), splitting each key back into its `workflowId`/`signalName` pair.
   */
  listParkedSignalWaits(): readonly ParkedSignalWait[];
  /**
   * Probe whether `signalName` has already been durably buffered for
   * `workflowId`, without consuming it — this poll only decides WHETHER to
   * wake, never consumes the signal itself, so a losing `ctx.race()` branch
   * is never silently dropped.
   *
   * Expected to be satisfied by `hasBufferedSignal` from
   * `src/core/engine/signals.ts`.
   */
  hasBufferedSignal(workflowId: string, signalName: string): Promise<boolean>;
  /**
   * Wake `workflowId` so it re-evaluates its parked state and, ultimately,
   * consumes the buffered signal and resumes its generator. Resolves once
   * the wake attempt has been dispatched; rejects on failure, which this
   * poll catches and records without stopping the remaining wakes in the
   * pass.
   *
   * Expected to be satisfied by `resumeParkedInlineWorkflow` from
   * `src/core/engine/inline-parking.ts` (already surfaced to callers today
   * through `SignalCallbacks.resumeParkedInlineWorkflow` in `signals.ts`).
   * The real implementation is expected to perform its own
   * `wakeOwnershipCheck` immediately before driving the generator, per the
   * ADR — that check is this poll's sibling module, not this poll's
   * responsibility.
   */
  wakeWorkflow(workflowId: string): Promise<void>;
};

/** One parked signal wait's outcome within a single poll pass. */
export type OwnerSideSignalPollOutcome =
  | { workflowId: string; signalName: string; status: 'woken' }
  | { workflowId: string; signalName: string; status: 'not-buffered' }
  | { workflowId: string; signalName: string; status: 'wake-failed'; error: unknown };

/** The result of one full owner-side signal poll pass ({@link runOwnerSideSignalPoll}). */
export type OwnerSideSignalPollResult = {
  /** `getNow()` read at the start of the pass, before any probe. */
  startedAt: number;
  /** `getNow()` read after every probe/wake has settled. */
  finishedAt: number;
  /** One entry per parked signal wait the pass attempted, in iteration order. */
  outcomes: OwnerSideSignalPollOutcome[];
  /** `outcomes.filter(o => o.status === 'woken').length`, precomputed for observability consumers. */
  wokenCount: number;
};

/** Options for {@link runOwnerSideSignalPoll}. */
export type OwnerSideSignalPollOptions = {
  target: OwnerSideSignalPollTarget;
  /** Wall-clock source (ms), injected so tests never depend on real time. */
  getNow: () => number;
};

/**
 * Run exactly one owner-side signal poll pass: snapshot this engine's
 * currently-parked signal waits, probe the durable buffer for each, and wake
 * the ones that are ready. A wake failure for one parked workflow is
 * captured as a `'wake-failed'` outcome and never stops the remaining
 * parked workflows in the same pass from being probed and, where ready,
 * woken.
 */
export async function runOwnerSideSignalPoll(
  options: OwnerSideSignalPollOptions,
): Promise<OwnerSideSignalPollResult> {
  const { target, getNow } = options;
  const startedAt = getNow();

  const parkedWaits = target.listParkedSignalWaits();
  const outcomes: OwnerSideSignalPollOutcome[] = [];

  for (const { workflowId, signalName } of parkedWaits) {
    const buffered = await target.hasBufferedSignal(workflowId, signalName);
    if (!buffered) {
      outcomes.push({ workflowId, signalName, status: 'not-buffered' });
      continue;
    }
    try {
      await target.wakeWorkflow(workflowId);
      outcomes.push({ workflowId, signalName, status: 'woken' });
    } catch (error) {
      outcomes.push({ workflowId, signalName, status: 'wake-failed', error });
    }
  }

  const finishedAt = getNow();
  return {
    startedAt,
    finishedAt,
    outcomes,
    wokenCount: outcomes.filter((outcome) => outcome.status === 'woken').length,
  };
}
