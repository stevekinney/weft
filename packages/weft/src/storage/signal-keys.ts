/**
 * Storage key builders for buffered workflow signals and their accepted-response
 * records.
 *
 * These are spread into `KEYS` in `interface.ts` rather than declared there, so
 * the signal keyspace can carry its full rationale without pushing that file's
 * documented line ceiling. Callers still reach them through `KEYS`, which keeps
 * one import contract for storage keys.
 *
 * @module storage/signal-keys
 */

import { encodeStorageKeyComponent } from './key-encoding.ts';

// Leading sort-class digit for a buffered-signal key. `consumeSignal` scans the
// `sig:<workflowId>:<name>:` prefix with `limit: 1` and takes the lexically-first
// key, so a `startOrSignal` start-signal — which must be consumed before any
// signal that arrives later in the same tick, before the workflow's first park —
// gets class `0` and every other signal gets class `1`. `'0'` < `'1'` under raw
// byte sort, so the start-signal always sorts first regardless of how the two id
// namespaces (explicit signalId vs `anonymous:<seq>:<uuid>`) compare (issue #458).
const SIGNAL_SORT_CLASS_START = '0';
const SIGNAL_SORT_CLASS_NORMAL = '1';

// `name` is encoded (like `id` and `workflowId`) so a name containing the `:`
// separator cannot prefix-collide with another name on the `consumeSignal` scan
// path; the consume/peek/has scan prefixes in `signals.ts` encode `name` to match.
const signalStorageKey = (
  workflowId: string,
  name: string,
  id: string,
  sortClass: string,
): string =>
  `sig:${encodeStorageKeyComponent(workflowId)}:${encodeStorageKeyComponent(name)}:${sortClass}:${encodeStorageKeyComponent(id)}`;

/**
 * Buffered workflow signal keys plus their accepted-response records.
 *
 * Spread into `KEYS`; not intended to be imported directly by engine code.
 */
export const SIGNAL_KEYS = {
  signal: (workflowId: string, name: string, id: string) =>
    signalStorageKey(workflowId, name, id, SIGNAL_SORT_CLASS_NORMAL),
  startSignal: (workflowId: string, name: string, id: string) =>
    signalStorageKey(workflowId, name, id, SIGNAL_SORT_CLASS_START),
  signalSequence: (workflowId: string) => `sigseq:v1:${encodeStorageKeyComponent(workflowId)}`,
  signalAcceptedResponsePrefix: (workflowId: string) =>
    `sigres:v1:${encodeStorageKeyComponent(workflowId)}:`,
  signalAcceptedResponse: (workflowId: string, name: string, signalId: string) =>
    `sigres:v1:${encodeStorageKeyComponent(workflowId)}:${encodeStorageKeyComponent(name)}:${encodeStorageKeyComponent(signalId)}`,
} as const;
