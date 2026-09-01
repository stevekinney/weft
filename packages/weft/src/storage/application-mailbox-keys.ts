/**
 * Storage key builders for the durable application command mailbox (WFT-84).
 *
 * Spread into `KEYS` in `interface.ts` rather than declared there, so the
 * mailbox keyspace can carry its full rationale without pushing that file past
 * its documented line ceiling. Callers still reach these through `KEYS`, which
 * keeps one import contract for storage keys.
 *
 * Every key is scoped by an opaque `(namespace, resourceId)` pair. Weft never
 * interprets either component, and no key here overlaps the workflow, schedule,
 * or worker-protocol keyspaces.
 *
 * @module storage/application-mailbox-keys
 */

import { encodeStorageKeyComponent, formatSortableStorageTimestamp } from './key-encoding.ts';

/**
 * Mailbox header, command record, FIFO delivery index, idempotency binding, and
 * terminal-retention index keys.
 *
 * Spread into `KEYS`; not intended to be imported directly by mailbox code.
 */
export const APPLICATION_MAILBOX_KEYS = {
  /**
   * The durable mailbox header for one `(namespace, resourceId)` application
   * command mailbox: FIFO sequence allocator plus the open-backlog counter that
   * admission backpressure reads. One key per mailbox, so admission and terminal
   * transitions serialize against each other per mailbox rather than globally.
   */
  applicationMailbox: (namespace: string, resourceId: string) =>
    `appmbx:v1:${encodeStorageKeyComponent(namespace)}:${encodeStorageKeyComponent(resourceId)}`,
  /** Scan prefix for every canonical command record in one mailbox. */
  applicationCommandPrefix: (namespace: string, resourceId: string) =>
    `appcmd:v1:${encodeStorageKeyComponent(namespace)}:${encodeStorageKeyComponent(resourceId)}:`,
  /**
   * The one authoritative record for a command. Every transition proves the
   * expected prior bytes through `storage.conditionalBatch`, so this key is the
   * command's compare-and-swap fence.
   */
  applicationCommand: (namespace: string, resourceId: string, commandId: string) =>
    `appcmd:v1:${encodeStorageKeyComponent(namespace)}:${encodeStorageKeyComponent(resourceId)}:${encodeStorageKeyComponent(commandId)}`,
  /** Scan prefix for a mailbox's FIFO delivery index. */
  applicationCommandReadyPrefix: (namespace: string, resourceId: string) =>
    `appready:v1:${encodeStorageKeyComponent(namespace)}:${encodeStorageKeyComponent(resourceId)}:`,
  /**
   * The FIFO delivery index, keyed by the command's ORIGINAL admission sequence
   * so a redelivered command re-enters at the position it was first admitted to
   * rather than at the back of the queue.
   */
  applicationCommandReady: (namespace: string, resourceId: string, sequence: number) =>
    `appready:v1:${encodeStorageKeyComponent(namespace)}:${encodeStorageKeyComponent(resourceId)}:${formatSortableStorageTimestamp(sequence)}`,
  /**
   * Maps an idempotency key to the command id admitted for it. Written in the
   * same conditional batch as the command record, gated on this key being
   * absent, so concurrent same-key admissions converge on one command. Retained
   * past terminal so a post-terminal retry resolves the original receipt instead
   * of admitting a second command.
   */
  applicationCommandIdempotency: (namespace: string, resourceId: string, key: string) =>
    `appidem:v1:${encodeStorageKeyComponent(namespace)}:${encodeStorageKeyComponent(resourceId)}:${encodeStorageKeyComponent(key)}`,
  /** Scan prefix for a mailbox's terminal-receipt retention index. */
  applicationCommandTerminalPrefix: (namespace: string, resourceId: string) =>
    `appterm:v1:${encodeStorageKeyComponent(namespace)}:${encodeStorageKeyComponent(resourceId)}:`,
  /**
   * Terminal-receipt retention index, sorted by the time the command reached a
   * terminal disposition so retention sweeps delete the oldest bounded batch
   * first.
   */
  applicationCommandTerminal: (
    namespace: string,
    resourceId: string,
    terminalAt: number,
    commandId: string,
  ) =>
    `appterm:v1:${encodeStorageKeyComponent(namespace)}:${encodeStorageKeyComponent(resourceId)}:${formatSortableStorageTimestamp(terminalAt)}:${encodeStorageKeyComponent(commandId)}`,
} as const;
