// ---------------------------------------------------------------------------
// Payload-size cap policy
// ---------------------------------------------------------------------------

/**
 * Operator-configured upper bound on the serialized size of individual
 * payloads. Large payloads — workflow input, signal payloads, activity results
 * — are encoded into per-yield checkpoints and event-log entries, so an
 * oversized value inflates every durable write and is re-deserialized on every
 * replay. `maxBytes` caps the codec-boundary size (the codec-encoded byte
 * length of the bare value, not the final on-disk record size) and rejects
 * oversized payloads at admission, before any storage write. Pass via
 * {@link EngineOptions.payloadSize}.
 *
 * Thresholds are operator config only — there are no baked-in defaults. Omit
 * the policy (or set `maxBytes` to `0`/`null`) to disable the cap entirely;
 * when disabled, no extra encode is performed, so the unconfigured path has
 * zero added cost.
 *
 * The cap measures the codec-encoded byte length of the payload value before
 * any storage-layer compression or record-envelope wrapping, and is an
 * admission-time check: it rejects new oversized payloads but does not
 * retroactively invalidate data already persisted under a larger (or disabled)
 * limit, which remains replayable.
 *
 * @example
 * ```ts
 * import { Engine, type PayloadSizePolicy } from '@lostgradient/weft';
 *
 * const payloadSize: PayloadSizePolicy = { maxBytes: 1_048_576 };
 * const engine = new Engine({ payloadSize });
 * void engine;
 * ```
 */
export interface PayloadSizePolicy {
  /**
   * Maximum serialized (codec-encoded) byte length a single payload may have.
   * A payload whose encoded size is exactly `maxBytes` is allowed; one byte
   * larger is rejected with `PayloadSizeExceededError`. Must be a positive safe
   * integer. `0`, `null`, omitted, or `undefined` disables the cap.
   */
  maxBytes?: number | null;
}

/**
 * Payload-size policy after validation and normalisation. `maxBytes` is either
 * a positive safe integer (cap active) or `null` (disabled). Used internally by
 * the engine; callers configure via {@link PayloadSizePolicy}.
 */
export interface NormalizedPayloadSizePolicy {
  maxBytes: number | null;
}
