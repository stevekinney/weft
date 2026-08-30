import { validateCloneable } from '../codec.ts';
import type { Checkpoint, Serializer } from '../types.ts';
import { compareValues } from './comparison.ts';
import type { CheckpointDivergence, CheckpointValidationResult } from './interfaces.ts';
import { deserializeCheckpoint, serializeCheckpoint } from './serialization.ts';

/** Development mode: validate checkpoint round-trips cleanly through serialization. */
export function validateCheckpointRoundTrip(
  checkpoint: Checkpoint,
  serializer?: Serializer,
): CheckpointValidationResult {
  // First, check for non-cloneable values
  const cloneResult = validateCloneable(checkpoint);
  if (!cloneResult.valid) {
    const divergences: CheckpointDivergence[] = cloneResult.errors.map((error) => ({
      path: error.path,
      original: error.value,
      deserialized: undefined,
      suggestion: error.suggestion,
    }));

    // Still compute size if possible, but use 0 if serialization would fail
    let sizeBytes = 0;
    try {
      sizeBytes = serializeCheckpoint(checkpoint, serializer).byteLength;
    } catch {
      // Serialization failed due to non-cloneable values; size stays 0
    }

    return { valid: false, divergences, sizeBytes };
  }

  // Serialize and deserialize
  const bytes = serializeCheckpoint(checkpoint, serializer);
  const restored = deserializeCheckpoint(bytes, serializer);

  // Deep compare
  const divergences: CheckpointDivergence[] = [];
  compareValues(checkpoint, restored, '', divergences);

  return {
    valid: divergences.length === 0,
    divergences,
    sizeBytes: bytes.byteLength,
  };
}
