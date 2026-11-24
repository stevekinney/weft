/**
 * Storage key builders for the persisted `ctx.log` lines of a workflow run (COR-1811).
 *
 * Spread into `KEYS` in `keys.ts` so callers keep one import contract for storage keys.
 *
 * @module storage/log-keys
 */

import { encodeStorageKeyComponent } from "../embedded/storage/src/index.ts";

/** Width a log sequence number is zero-padded to, so a prefix scan returns lines in write order. */
const LOG_SEQUENCE_WIDTH = 16;

/**
 * The key families of a run's persisted log lines, spread into `KEYS`; not intended to be
 * imported directly by engine code.
 *
 * `log:<runId>:<seq>` holds one line (`seq` zero-padded to 16 digits, so a scan is in write
 * order). `log-counter:<runId>` holds the run's counter record: the next sequence number, the
 * sequence of the oldest retained line, how many lines the cap evicted (`dropped`), and when the
 * run last wrote a line. The counter lives under its own prefix so a scan of a run's lines never
 * meets it and a retention pass can list the runs that hold lines without reading any line.
 *
 * Both families belong to the run: a purge removes them with it. Terminal cleanup does not, so a
 * finished run keeps its lines until the retention window passes.
 */
export const WORKFLOW_LOG_KEYS = {
  /** The prefix every file-workflow event receipt shares. */
  fileWorkflowEventReceiptPrefix: (workflowId: string): string =>
    `file-workflow-receipt:${encodeStorageKeyComponent(workflowId)}:`,
  /** Durable idempotency receipt for one file-workflow lifecycle event key. */
  fileWorkflowEventReceipt: (workflowId: string, eventKey: string): string =>
    `file-workflow-receipt:${encodeStorageKeyComponent(workflowId)}:${encodeStorageKeyComponent(eventKey)}`,
  /** The prefix every line of `workflowId` shares. */
  workflowLogPrefix: (workflowId: string): string =>
    `log:${encodeStorageKeyComponent(workflowId)}:`,
  /** One line of `workflowId`, by its zero-padded sequence number. */
  workflowLog: (workflowId: string, sequence: number): string =>
    `log:${encodeStorageKeyComponent(workflowId)}:${String(sequence).padStart(LOG_SEQUENCE_WIDTH, '0')}`,
  /** The prefix every run's counter record shares. */
  workflowLogCounterPrefix: (): string => 'log-counter:',
  /** The counter record of `workflowId`'s log lines. */
  workflowLogCounter: (workflowId: string): string =>
    `log-counter:${encodeStorageKeyComponent(workflowId)}`,
} as const;
