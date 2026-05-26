import { hashString } from '../../runtime/portable.ts';
import { WeftError } from '../weft-error.ts';

/**
 * Durable effect log for replay deduplication.
 *
 * When workflow code is restored from a checkpoint, a non-idempotent external
 * effect can be requested again while the outcome of the original request is
 * still unknown. Without a durability fence at the effect boundary, payments,
 * state mutations, or single-use token presentations can execute twice.
 *
 * This module solves the problem with an effect log keyed by a *semantic hash*
 * of each effect call's intent-critical fields. Before executing an effect,
 * callers consult the log:
 *
 * - **committed** → replay the stored result; skip the effect entirely.
 * - **in-flight** → the previous run crashed mid-execution; throw
 *   {@link EffectReplayConflictError} so the caller can escalate.
 * - **absent** → record as `in-flight`, execute the effect, then
 *   {@link EffectLog.commit} or {@link EffectLog.abort}.
 *
 * The log is backed by the {@link Storage} interface (any KV adapter).
 * Records are scoped to `(workflowId, operationId)` so parallel branches do not
 * collide.
 *
 * @see arXiv 2603.20625 ("ACRFence") for the threat model and experimental
 *   evidence that motivated this design.
 *
 * @module core/effect-log
 */

import type { Storage } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { decode, encode } from '../codec.ts';
import { isJSONValue, normalizeJSONValue, type JSONValue } from '../json.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * An effect record stored in the log. The `status` field drives deduplication.
 *
 * @example Inspect the record returned by EffectLog.lookup
 * ```ts
 * import type { EffectRecord } from 'weft';
 *
 * function describeRecord(record: EffectRecord): string {
 *   switch (record.status) {
 *     case 'in-flight': return `${record.effectName} started at ${record.recordedAt}`;
 *     case 'committed': return `${record.effectName} -> ${JSON.stringify(record.output)}`;
 *     case 'aborted':   return `${record.effectName} failed: ${record.reason}`;
 *   }
 * }
 * ```
 */
export type EffectRecord =
  | { status: 'in-flight'; effectName: string; recordedAt: number }
  | { status: 'committed'; effectName: string; output: JSONValue; completedAt: number }
  | { status: 'aborted'; effectName: string; reason: string; completedAt: number };

/**
 * Public contract callers rely on when deduplicating effect calls.
 *
 * This narrower type keeps tests honest without forcing them to construct a
 * full {@link EffectLog} instance when they only need the runtime-facing
 * methods and counter.
 *
 * @example
 * ```ts
 * import type { EffectLogLike } from 'weft';
 *
 * async function dedupe(log: EffectLogLike, hash: string): Promise<boolean> {
 *   const existing = await log.lookup(hash);
 *   return existing !== null;
 * }
 * ```
 */
export type EffectLogLike = Pick<
  EffectLog,
  'lookup' | 'recordReplay' | 'record' | 'commit' | 'abort' | 'duplicatesPrevented'
>;

// ---------------------------------------------------------------------------
// EffectReplayConflictError
// ---------------------------------------------------------------------------

/**
 * Thrown when a caller detects a lingering `in-flight` record during a
 * checkpoint-restore cycle. This indicates the process crashed between
 * recording the in-flight intent and receiving the effect
 * result — the outcome of the original call is unknown.
 *
 * Callers should escalate (e.g. human review) rather than silently
 * re-executing a potentially non-idempotent tool.
 *
 * @example Catch a replay conflict and route to human review
 * ```ts
 * import { EffectReplayConflictError } from 'weft';
 *
 * try {
 *   // ... effect execution
 * } catch (error) {
 *   if (error instanceof EffectReplayConflictError) {
 *     console.error(
 *       `Conflict for effect "${error.effectName}" (hash ${error.semanticHash}).`,
 *       'Route to human review before retrying.',
 *     );
 *   }
 * }
 * ```
 */
export class EffectReplayConflictError extends WeftError<'EffectReplayConflictError'> {
  readonly effectName: string;
  readonly semanticHash: string;

  constructor(semanticHash: string, effectName: string) {
    super(
      'EffectReplayConflictError',
      `Effect replay conflict: "${effectName}" (semantic hash ${semanticHash}) ` +
        `was in-flight when the process crashed. The outcome of the original call ` +
        `is unknown — re-executing a non-idempotent effect may cause duplicate effects. ` +
        `Inspect the effect log or route to human review before retrying.`,
    );
    this.effectName = effectName;
    this.semanticHash = semanticHash;
  }
}

// ---------------------------------------------------------------------------
// Semantic hash
// ---------------------------------------------------------------------------

/**
 * Compute a stable 16-character hex semantic hash of an arbitrary input
 * value. Keys within objects are sorted recursively so that
 * `{a:1,b:2}` and `{b:2,a:1}` produce the same hash.
 *
 * Callers may override this default by hashing only the intent-critical fields
 * before recording an effect, ignoring fields whose variance does not affect
 * the observable effect (retry counters, timestamps, nonces).
 *
 * @example Hash only the fields that determine a payment's observable effect
 * ```ts
 * import { computeSemanticHash } from 'weft';
 *
 * const hash = computeSemanticHash({ recipient: 'alice', amount: 100 });
 * // Key order is irrelevant — same hash regardless of property insertion order.
 * const sameHash = computeSemanticHash({ amount: 100, recipient: 'alice' });
 * console.log(hash === sameHash); // true
 * ```
 */
export function computeSemanticHash(input: unknown): string {
  const canonical = canonicalize(input);
  return hashString(canonical);
}

/**
 * Sentinel for `undefined` in the canonical form.
 *
 * Starts with a NUL byte so it cannot collide with any output of
 * `JSON.stringify` — JSON strings are always quoted, and no other
 * canonicalize branch emits a NUL-prefixed token. In particular, this
 * distinguishes `undefined` from the literal string `"undefined"`.
 */
const UNDEFINED_SENTINEL = '\u0000undefined';

/**
 * Recursively sort object keys to produce a canonical string representation.
 *
 * Object keys whose values are `undefined` are omitted entirely, matching
 * `JSON.stringify` semantics. This means `{ a: undefined }` canonicalizes
 * the same as `{}`, while still remaining distinct from
 * `{ a: 'undefined' }` (which serializes as `{"a":"undefined"}`).
 *
 * Top-level and array-element `undefined` values cannot be omitted without
 * losing positional/identity information, so they serialize to
 * {@link UNDEFINED_SENTINEL} — a NUL-prefixed token that no other branch
 * can produce.
 */
function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return UNDEFINED_SENTINEL;
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const record = value as Record<string, unknown>;
  const sorted = Object.keys(record)
    .toSorted()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
  return '{' + sorted.join(',') + '}';
}

// ---------------------------------------------------------------------------
// Runtime type guard
// ---------------------------------------------------------------------------

/** Narrow an unknown decoded value to `EffectRecord`. Used in {@link EffectLog.lookup}. */
function isEffectRecord(value: unknown): value is EffectRecord {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj['status'] !== 'string' || typeof obj['effectName'] !== 'string') return false;
  const status = obj['status'];
  if (status === 'in-flight') return typeof obj['recordedAt'] === 'number';
  if (status === 'committed')
    return isJSONValue(obj['output']) && typeof obj['completedAt'] === 'number';
  if (status === 'aborted')
    return typeof obj['reason'] === 'string' && typeof obj['completedAt'] === 'number';
  return false;
}

// ---------------------------------------------------------------------------
// EffectLog
// ---------------------------------------------------------------------------

/**
 * Per-operation effect log.
 *
 * Scoped to a `(workflowId, operationId)` pair so that concurrent branches do
 * not share hash space.
 *
 * `operationId` should be stable across checkpoint-restore cycles for any
 * operation that wants deterministic effect replay.
 *
 * @example Create and use an EffectLog for durable deduplication
 * ```ts
 * import { EffectLog, computeSemanticHash } from 'weft';
 * import { MemoryStorage } from 'weft/storage/memory';
 *
 * const storage = new MemoryStorage();
 * const log = new EffectLog(storage, 'workflow-abc', 'operation-1');
 *
 * const hash = computeSemanticHash({ recipient: 'alice', amount: 100 });
 * await log.record(hash, 'charge');
 * await log.commit(hash, 'charge', { success: true });
 *
 * const record = await log.lookup(hash);
 * console.log(record?.status); // 'committed'
 * ```
 */
export class EffectLog {
  readonly #storage: Storage;
  readonly #workflowId: string;
  readonly #operationId: string;
  #duplicatesPrevented = 0;

  constructor(storage: Storage, workflowId: string, operationId: string) {
    this.#storage = storage;
    this.#workflowId = workflowId;
    this.#operationId = operationId;
  }

  /** Number of committed-replay short-circuits recorded during this instance's lifetime. */
  get duplicatesPrevented(): number {
    return this.#duplicatesPrevented;
  }

  /**
   * Increment the duplicate-prevention counter.
   * Called each time a committed replay short-circuits an effect invocation.
   * Separated from {@link lookup} so callers control when they count a replay.
   */
  recordReplay(): void {
    this.#duplicatesPrevented++;
  }

  /**
   * Look up the effect record for a given semantic hash.
   * Returns `null` when no record exists.
   */
  async lookup(semanticHash: string): Promise<EffectRecord | null> {
    const key = KEYS.toolEffect(this.#workflowId, this.#operationId, semanticHash);
    const bytes = await this.#storage.get(key);
    if (!bytes) return null;
    const decoded = decode(bytes);
    if (!isEffectRecord(decoded)) return null;
    return decoded;
  }

  /**
   * Record an effect call as `in-flight`.
   *
   * Call this **before** invoking the effect so that a crash between this
   * write and the effect response is detectable on restore.
   */
  async record(semanticHash: string, effectName: string): Promise<void> {
    const record: EffectRecord = {
      status: 'in-flight',
      effectName,
      recordedAt: Date.now(),
    };
    await this.#put(semanticHash, record);
  }

  /**
   * Mark the call as `committed` and store the effect output.
   *
   * Call this after the effect has returned successfully so that a subsequent
   * restore will replay this output instead of re-executing.
   */
  async commit(semanticHash: string, effectName: string, output: unknown): Promise<void> {
    const record: EffectRecord = {
      status: 'committed',
      effectName,
      output: normalizeJSONValue(output),
      completedAt: Date.now(),
    };
    await this.#put(semanticHash, record);
  }

  /**
   * Mark the call as `aborted` with a reason string.
   *
   * Call this when an effect fails and that failure should not be replayed
   * from the effect log. On restore the caller can re-execute the effect rather
   * than replaying the error, so only use this for failures where a future retry
   * is safe and desired.
   */
  async abort(semanticHash: string, effectName: string, reason: string): Promise<void> {
    const record: EffectRecord = {
      status: 'aborted',
      effectName,
      reason,
      completedAt: Date.now(),
    };
    await this.#put(semanticHash, record);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  async #put(semanticHash: string, record: EffectRecord): Promise<void> {
    const key = KEYS.toolEffect(this.#workflowId, this.#operationId, semanticHash);
    await this.#storage.put(key, encode(record));
  }
}
