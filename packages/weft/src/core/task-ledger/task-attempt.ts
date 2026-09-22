/**
 * Durable per-attempt provenance record — public surface for this subsystem
 * (COR-205). Barrel re-exporting the record type, storage keys, and codec
 * split across `task-attempt-types.ts`, `task-attempt-keys.ts`, and
 * `task-attempt-codec.ts`, matching `task-ledger.ts`'s identical precedent.
 * Server-internal only — not re-exported from `src/index.ts`.
 *
 * @module server/task-attempt
 */

export {
  decodeTaskAttemptRecord,
  encodeTaskAttemptRecord,
  isTaskAttemptRecord,
} from './task-attempt-codec.ts';
export { taskAttemptKey, taskAttemptPrefix } from './task-attempt-keys.ts';
export { TASK_ATTEMPT_RECORD_VERSION } from './task-attempt-types.ts';
export type { TaskAttemptDisposition, TaskAttemptRecord } from './task-attempt-types.ts';
