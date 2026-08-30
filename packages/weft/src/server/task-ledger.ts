/**
 * Durable remote task ledger — public surface for this subsystem (WFT-25).
 *
 * Barrel re-exporting the record types, storage key, and codec split across
 * `task-ledger-types.ts`, `task-ledger-limits.ts`, `task-ledger-keys.ts`, and
 * `task-ledger-codec.ts` so callers (and `task-ledger.test.ts`, named by the
 * project's verification gate) import from one module. Server-internal only
 * — not re-exported from `src/index.ts`. See `task-ledger-transitions.ts`
 * for the pure conditional-transition precondition functions.
 *
 * @module server/task-ledger
 */

export {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  isRemoteTaskCancelling,
  isRemoteTaskCompleting,
  isRemoteTaskDeadLettered,
  isRemoteTaskLeased,
  isRemoteTaskQueued,
  isRemoteTaskRecord,
  isRemoteTaskTerminal,
  isRemoteTaskTerminalCancelled,
  isRemoteTaskTerminalResolved,
  isRemoteTaskTerminalRetryExhausted,
  isValidTaskHeaders,
} from './task-ledger-codec.ts';
export { taskLedgerKey } from './task-ledger-keys.ts';
export {
  MAX_TASK_HEADER_COUNT,
  MAX_TASK_HEADER_VALUE_BYTES,
  MAX_TASK_IDENTIFIER_BYTES,
  MAX_TASK_REASON_BYTES,
  utf8ByteLength,
} from './task-ledger-limits.ts';
export { REMOTE_TASK_RECORD_VERSION } from './task-ledger-types.ts';
export type {
  RemoteTaskAttemptFields,
  RemoteTaskBase,
  RemoteTaskCancelling,
  RemoteTaskCompleting,
  RemoteTaskDeadLettered,
  RemoteTaskLeased,
  RemoteTaskQueued,
  RemoteTaskRecord,
  RemoteTaskTerminal,
  RemoteTaskTerminalCancelled,
  RemoteTaskTerminalDisposition,
  RemoteTaskTerminalResolved,
  RemoteTaskTerminalRetryExhausted,
  WorkerExecutionRequirementInput,
} from './task-ledger-types.ts';
