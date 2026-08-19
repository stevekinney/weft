/**
 * Semantic bounds applied to a {@link RemoteTaskRecord} before it is decoded
 * or admitted to storage (WFT-25).
 *
 * These bound the *semantic* shape a persisted or wire-derived task record
 * may assert — operation/workflow identity strings, header counts and sizes,
 * retry fields — independent of any transport-level frame ceiling. Server
 * policy brief: "Bound operation IDs, workflow IDs, names, queues, header
 * counts, header bytes, retry fields, and payload sizes before storage
 * writes."
 *
 * @module server/task-ledger-limits
 */

const textEncoder = new TextEncoder();

/** UTF-8 byte length of `value`. */
export function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

/** Maximum UTF-8 byte length of any single identifier-shaped ledger string. */
export const MAX_TASK_IDENTIFIER_BYTES = 512;

/** Maximum number of header entries a single task record may carry. */
export const MAX_TASK_HEADER_COUNT = 64;

/** Maximum UTF-8 byte length of a single header name or value. */
export const MAX_TASK_HEADER_VALUE_BYTES = 4096;

/** Maximum UTF-8 byte length of a single free-text reason/error string. */
export const MAX_TASK_REASON_BYTES = 4096;
