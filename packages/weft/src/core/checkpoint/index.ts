export type { CheckpointDivergence, CheckpointValidationResult } from './interfaces.ts';
export { advanceCheckpoint, checkpointSizeBytes, createCheckpoint } from './lifecycle.ts';
export { deserializeCheckpoint, serializeCheckpoint } from './serialization.ts';
export { validateCheckpointRoundTrip } from './validation.ts';
