import type { FailureCategory } from './types.ts';
import type { WorkflowLogRecord } from './types/workflow-log.ts';
import type { WorkerExecutionStrategyOptions } from './worker-execution-strategy-options.ts';
import {
  deliverForwardedWorkerLog,
  type ForwardedWorkerLogOutcome,
} from './worker-message-helpers.ts';
import type { WorkerLogMessageCandidate } from './worker-protocol-log.ts';
import {
  DEFAULT_FORWARDED_LOG_FLOOD_THRESHOLD,
  DEFAULT_FORWARDED_LOG_FLOOD_WINDOW_MS,
  FORWARDED_LOG_STRIKE_THRESHOLD,
} from './worker-protocol.ts';

/**
 * The verdict the abuse counter returns after recording one forwarded-log outcome:
 * whether the strategy should DISCARD the sending worker for sustained abuse. A
 * `false` verdict means "tolerate this occurrence" — a single anomaly or an
 * in-budget burst never discards. A `true` verdict means a threshold was crossed
 * (flood within the window, or accumulated lifetime strikes) and the worker should
 * be discarded as the hardened-worker threat model prescribes.
 */
export type WorkerLogAbuseVerdict = 'tolerate' | 'discard';

/**
 * Configuration for {@link WorkerLogAbuseCounter}. All three thresholds are internal:
 * the engine fixes them to generous defaults rather than exposing operator tuning,
 * because a false discard fails a real user's in-flight workflows (an asymmetric harm).
 * The flood window/threshold are large so honest high-log workflows never trip them; the
 * strike threshold is a small constant because oversize/invalid records are never produced
 * by a well-behaved logger, so a handful in a worker's lifetime already signals abuse.
 */
export interface WorkerLogAbuseCounterOptions {
  /** Sliding window length in milliseconds for the flood budget. */
  readonly floodWindowMs: number;
  /**
   * Maximum forwarded-log ARRIVALS tolerated per worker within `floodWindowMs`
   * before the worker is discarded. Counts every `type:'log'` arrival for a worker
   * — valid, oversize, invalid, or wrong-owner — because the host paid the clone
   * cost on receipt regardless of the record's fate.
   */
  readonly floodThreshold: number;
  /**
   * Maximum cumulative anomalous (oversize OR invalid) records tolerated over a
   * worker's whole lifetime before discard. NOT window-scoped and NOT reset, so a
   * worker cannot evade by spacing anomalies across windows.
   */
  readonly strikeThreshold: number;
  /** Monotonic-enough wall clock (ms), injected so tests advance time deterministically. */
  readonly getNow: () => number;
}

interface WorkerAbuseState {
  /** Start of the current flood window (ms, from the injected clock). */
  windowStartedAt: number;
  /** Forwarded-log arrivals counted in the current window. */
  arrivalsInWindow: number;
  /** Cumulative lifetime anomalous (oversize/invalid) records. */
  lifetimeStrikes: number;
}

/**
 * Per-worker forwarded-log abuse accounting for the hardened worker path (#545).
 *
 * The #529 host-sink routing forwards a worker's `ctx.log` records to the engine's
 * `EngineOptions.onLog` sink through a deliberately LENIENT lane that bypasses the
 * strict turn watchdog, so a single malformed/oversize/wrong-owner log drops the
 * record without discarding the worker. That leniency leaves two availability gaps
 * a compromised or buggy worker can exploit:
 *
 * 1. **Flooding** — unlimited valid, in-budget logs apply host CPU / sink-buffer
 *    pressure without ever tripping the watchdog.
 * 2. **Repeat oversize/invalid** — each forwarded log is structured-cloned by the
 *    runtime on receipt (a platform-inherent cost paid before any handler runs), so
 *    a worker can repeatedly force large/garbage allocations that the lenient lane
 *    then drops.
 *
 * This counter closes both by keeping per-worker state (keyed by the {@link Worker}
 * reference in a {@link WeakMap}, so a discarded/GC'd worker's state is reclaimed
 * automatically). It exposes two record paths the strategy calls and returns a
 * {@link WorkerLogAbuseVerdict} telling the strategy whether to discard:
 *
 * - {@link recordArrival} is called for EVERY `type:'log'` message a worker sends,
 *   at the top of the log branch BEFORE the ownership gate — so a worker flooding
 *   logs for workflows it does not own is still counted (the host paid the clone
 *   cost). It drives the windowed flood budget.
 * - {@link recordOutcome} is called after the ownership gate, with the delivery
 *   {@link ForwardedWorkerLogOutcome}, to drive the lifetime strike bucket on
 *   anomalous (oversize/invalid) records.
 *
 * Granularity is per-worker (not per-workflow): a pooled worker runs many workflows
 * over its lifetime, the remediation ({@link Worker} discard) is worker-scoped, and
 * the threat model treats the whole worker as the adversary, so per-worker both
 * matches the remediation and defeats spreading abuse thin across many workflows.
 */
export class WorkerLogAbuseCounter {
  readonly #floodWindowMs: number;
  readonly #floodThreshold: number;
  readonly #strikeThreshold: number;
  readonly #getNow: () => number;
  readonly #stateByWorker = new WeakMap<Worker, WorkerAbuseState>();

  constructor(options: WorkerLogAbuseCounterOptions) {
    this.#floodWindowMs = options.floodWindowMs;
    this.#floodThreshold = options.floodThreshold;
    this.#strikeThreshold = options.strikeThreshold;
    this.#getNow = options.getNow;
  }

  /**
   * Record one forwarded-log ARRIVAL for `worker` and return whether the worker
   * should be discarded for flooding. Called for every `type:'log'` message before
   * the ownership gate. This is a fixed/anchored window (not a true rolling window): an
   * arrival at or beyond `floodWindowMs` after the window's start anchors a fresh window
   * (count resets to 1). Within a window, the verdict is `discard` once arrivals exceed
   * `floodThreshold`. A backwards clock jump (`now < windowStartedAt`, e.g. an NTP step
   * when `getNow` is wall-clock) also re-anchors the window, so clock regression can never
   * hold a window open and accumulate toward a premature discard.
   */
  recordArrival(worker: Worker): WorkerLogAbuseVerdict {
    const now = this.#getNow();
    const state = this.#stateFor(worker);
    const elapsed = now - state.windowStartedAt;
    if (elapsed >= this.#floodWindowMs || elapsed < 0) {
      state.windowStartedAt = now;
      state.arrivalsInWindow = 0;
    }
    state.arrivalsInWindow += 1;
    return state.arrivalsInWindow > this.#floodThreshold ? 'discard' : 'tolerate';
  }

  /**
   * Record the delivery `outcome` for one forwarded log from `worker` and return
   * whether the worker should be discarded for accumulated anomalies. An
   * `accepted-valid` outcome is a no-op (valid logs are accounted only by the flood
   * budget). An oversize or invalid outcome adds one lifetime strike; the verdict is
   * `discard` once lifetime strikes reach `strikeThreshold`. The `switch` is exhaustive
   * (the `never` default) so that adding a future non-strike dropped outcome forces the
   * strike-vs-no-strike policy decision to be made here rather than defaulting to a strike.
   */
  recordOutcome(worker: Worker, outcome: ForwardedWorkerLogOutcome): WorkerLogAbuseVerdict {
    switch (outcome) {
      case 'accepted-valid':
        return 'tolerate';
      case 'dropped-oversize':
      case 'dropped-invalid': {
        const state = this.#stateFor(worker);
        state.lifetimeStrikes += 1;
        return state.lifetimeStrikes >= this.#strikeThreshold ? 'discard' : 'tolerate';
      }
      default: {
        const exhaustive: never = outcome;
        throw new Error(`Unknown forwarded-log outcome: ${String(exhaustive)}`);
      }
    }
  }

  /** Drop a worker's accounting (called when the worker is discarded/forgotten). */
  forget(worker: Worker): void {
    this.#stateByWorker.delete(worker);
  }

  #stateFor(worker: Worker): WorkerAbuseState {
    let state = this.#stateByWorker.get(worker);
    if (!state) {
      state = { windowStartedAt: this.#getNow(), arrivalsInWindow: 0, lifetimeStrikes: 0 };
      this.#stateByWorker.set(worker, state);
    }
    return state;
  }
}

/**
 * Narrow construction config for {@link ForwardedLogGate} — decoupled from
 * `WorkerExecutionStrategyOptions` so the gate names only what it consumes. The
 * threshold fields are `| undefined` (the gate applies each default); build this from
 * a strategy's options with {@link forwardedLogGateFromStrategyOptions}.
 */
export interface ForwardedLogGateOptions {
  readonly onLog: ((record: WorkflowLogRecord) => void) | undefined;
  readonly maxProtocolMessageBytes: number | undefined;
  readonly getNow: (() => number) | undefined;
  readonly floodWindowMs: number | undefined;
  readonly floodThreshold: number | undefined;
  readonly strikeThreshold: number | undefined;
}

/**
 * The complete forwarded-log lane for the hardened worker path: #529 delivery
 * orchestration plus the #545 per-worker abuse counter. Extracted from
 * `WorkerExecutionStrategy` so the strategy's message branch is a one-line delegate
 * and this whole concern — counting policy, ownership-gated delivery, discard
 * decisions — lives in one focused, independently tested module.
 *
 * {@link handle} is the single entry point. It counts EVERY arrival toward the flood
 * budget BEFORE the ownership gate (a worker flooding logs for workflows it does not
 * own is still counted — the host already paid the structured-clone cost on receipt),
 * applies the trust-boundary ownership gate (a worker may forward logs only for a
 * workflow it owns, checked by the injected `ownedByWorker` predicate), delivers
 * owned records to the sink, and feeds the delivery outcome to the lifetime strike
 * bucket. It returns a human-readable discard reason when sustained abuse (flooding
 * OR repeated anomalies) crosses a threshold, or `null` to tolerate. The caller owns
 * the actual worker discard; this gate only decides.
 */
export class ForwardedLogGate {
  readonly #counter: WorkerLogAbuseCounter;
  readonly #onLog: ((record: WorkflowLogRecord) => void) | undefined;
  readonly #maxProtocolMessageBytes: number | undefined;

  /**
   * Construct from a narrow gate-local config (decoupled from the strategy). Defaults
   * are applied here so this is the one place every forwarded-log default lives: `getNow`
   * → `Date.now`, flood window/threshold → the generous worker-protocol constants, strike
   * threshold → the small non-configurable constant. Build it from a strategy's options
   * with {@link forwardedLogGateFromStrategyOptions}.
   */
  constructor(config: ForwardedLogGateOptions) {
    this.#onLog = config.onLog;
    this.#maxProtocolMessageBytes = config.maxProtocolMessageBytes;
    this.#counter = new WorkerLogAbuseCounter({
      floodWindowMs: config.floodWindowMs ?? DEFAULT_FORWARDED_LOG_FLOOD_WINDOW_MS,
      floodThreshold: config.floodThreshold ?? DEFAULT_FORWARDED_LOG_FLOOD_THRESHOLD,
      strikeThreshold: config.strikeThreshold ?? FORWARDED_LOG_STRIKE_THRESHOLD,
      getNow: config.getNow ?? Date.now,
    });
  }

  /** Whether a host `onLog` sink is installed (drives the worker's `hostHasLogSink` flag). */
  get hasSink(): boolean {
    return this.#onLog !== undefined;
  }

  /**
   * Process one forwarded `log` from `worker`. `ownedByWorker` reports whether the
   * sending worker owns `message.workflowId` (active or parked) — the strategy's
   * ownership state stays the source of truth. Returns ready-to-use discard options on
   * sustained abuse (the strategy passes them straight to its worker-discard path), or
   * `null` to tolerate this occurrence.
   */
  handle(
    worker: Worker,
    message: WorkerLogMessageCandidate,
    ownedByWorker: (workflowId: string) => boolean,
  ): LogAbuseDiscardOptions | null {
    if (this.#counter.recordArrival(worker) === 'discard') {
      return discardForLogAbuse('forwarded-log flooding');
    }

    if (typeof message.workflowId !== 'string' || !ownedByWorker(message.workflowId)) {
      // Wrong-owner logs count toward the flood budget (above) but are never a strike:
      // a between-turns self-log for a just-terminated workflow is benign mistiming.
      return null;
    }

    const outcome = deliverForwardedWorkerLog(message, this.#onLog, this.#maxProtocolMessageBytes);
    if (this.#counter.recordOutcome(worker, outcome) === 'discard') {
      return discardForLogAbuse('repeated oversize/invalid forwarded logs');
    }
    return null;
  }

  /** Drop a worker's accounting (called when the worker is discarded/forgotten). */
  forget(worker: Worker): void {
    this.#counter.forget(worker);
  }
}

/**
 * The discard options {@link ForwardedLogGate.handle} returns for an abusive worker —
 * a `system`-category discard whose target and other failures carry the same reason.
 * Structurally a subset of the strategy's worker-discard options, so the strategy
 * passes it straight through.
 */
export interface LogAbuseDiscardOptions {
  readonly targetCategory: FailureCategory;
  readonly targetError: string;
  readonly otherCategory: FailureCategory;
  readonly otherError: string;
}

function discardForLogAbuse(reason: string): LogAbuseDiscardOptions {
  const error = `Worker discarded for log abuse: ${reason}`;
  return {
    targetCategory: 'system',
    targetError: error,
    otherCategory: 'system',
    otherError: error,
  };
}

/**
 * Build a {@link ForwardedLogGate} from a strategy's options. This is the one place that
 * names {@link WorkerExecutionStrategyOptions} (type-only), so the gate class itself stays
 * decoupled from the broader strategy surface. `maxProtocolMessageBytes` is passed
 * separately because the strategy also consumes it for its protocol guard.
 */
export function forwardedLogGateFromStrategyOptions(
  options: WorkerExecutionStrategyOptions | undefined,
  maxProtocolMessageBytes: number | undefined,
): ForwardedLogGate {
  return new ForwardedLogGate({
    onLog: options?.onLog,
    maxProtocolMessageBytes,
    getNow: options?.getNow,
    floodWindowMs: options?.forwardedLogFloodWindowMs,
    floodThreshold: options?.forwardedLogFloodThreshold,
    strikeThreshold: options?.forwardedLogStrikeThreshold,
  });
}
