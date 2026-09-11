/**
 * Pure codec for the durable per-workflow-id generation counter
 * (`wf-gen:<id>`, WFT-153).
 *
 * Reuses `lease-codec.ts`'s `encodeEpoch`/`decodeEpoch` under
 * generation-specific names rather than reimplementing them: both are
 * permanently-retained monotonic uint64 counters minted the same way
 * (`(observed ?? 0) + 1`, never a literal), so sharing one encoder/decoder
 * keeps their on-disk representation byte-identical and their validity range
 * ([1, MAX_SAFE_INTEGER)) — fail-closed on corruption — in lockstep by
 * construction rather than by convention.
 *
 * @module core/engine/generation-codec
 */

import { decodeEpoch, encodeEpoch } from './lease-codec.ts';

/** Encode an 8-byte big-endian uint64 generation. See `lease-codec.ts#encodeEpoch`. */
export const encodeGeneration = encodeEpoch;

/**
 * Decode an 8-byte big-endian uint64 generation, or `null` when the stored
 * value is not a usable generation. See `lease-codec.ts#decodeEpoch`.
 */
export const decodeGeneration = decodeEpoch;
