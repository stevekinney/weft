import type { BatchOperation } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { encode } from '../codec.ts';
import type { TimerEntry } from '../types.ts';
import { normalizeStorageTimestamp } from './duration.ts';

function isTimerEntryKind(value: unknown): value is TimerEntry['kind'] {
  return (
    value === 'sleep' ||
    value === 'visibility-timeout' ||
    value === 'execution-deadline' ||
    value === 'delayed-start' ||
    value === 'schedule' ||
    value === 'terminal-cleanup' ||
    value === 'teardown' ||
    value === 'wait-condition'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasStringProperty(value: Record<string, unknown>, property: string): boolean {
  return typeof value[property] === 'string';
}

function hasFiniteNumberProperty(value: Record<string, unknown>, property: string): boolean {
  const propertyValue = value[property];
  return typeof propertyValue === 'number' && Number.isFinite(propertyValue);
}

/** Runtime type guard for decoded timer entries. */
export function isTimerEntry(value: unknown): value is TimerEntry {
  return (
    isRecord(value) &&
    hasStringProperty(value, 'id') &&
    hasStringProperty(value, 'workflowId') &&
    hasFiniteNumberProperty(value, 'fireAt') &&
    isTimerEntryKind(value['kind'])
  );
}

/**
 * Build the batch operations needed to persist a durable timer entry.
 * Shared between `Scheduler.schedule()` and `Engine.#buildStartBatchOperations()`
 * so the key format stays in one place.
 */
export function buildTimerBatchOperations(entry: TimerEntry): BatchOperation[] {
  const normalizedEntry: TimerEntry = {
    ...entry,
    fireAt: normalizeStorageTimestamp(entry.fireAt, 'Timer fireAt'),
  };
  if (normalizedEntry.kind === 'terminal-cleanup') {
    return [
      {
        type: 'put',
        key: KEYS.terminalCleanup(normalizedEntry.fireAt, normalizedEntry.id),
        value: encode(normalizedEntry.workflowId),
      },
    ];
  }

  if (normalizedEntry.kind === 'teardown') {
    // Like `terminal-cleanup`, the teardown timer is scanned by its own source
    // (`wf-teardown:`) which re-derives the `teardown` kind, so the stored value
    // is just the workflow id — and it gets no `timer-idx:` reverse entry because
    // teardown is never cancelled out-of-band (reschedule-on-failure rewrites the
    // entry from inside the drive; success consumes the fired timer).
    return [
      {
        type: 'put',
        key: KEYS.teardownTimer(normalizedEntry.fireAt, normalizedEntry.id),
        value: encode(normalizedEntry.workflowId),
      },
    ];
  }

  const deadlineKey =
    normalizedEntry.kind === 'delayed-start'
      ? KEYS.delayedStart(normalizedEntry.fireAt, normalizedEntry.workflowId)
      : normalizedEntry.kind === 'schedule'
        ? KEYS.scheduleTick(normalizedEntry.fireAt, normalizedEntry.workflowId)
        : KEYS.deadline(normalizedEntry.fireAt, normalizedEntry.id);
  const operations: BatchOperation[] = [
    { type: 'put', key: deadlineKey, value: encode(normalizedEntry) },
  ];
  operations.push({
    type: 'put',
    key: `timer-idx:${normalizedEntry.id}`,
    value: encode(deadlineKey),
  });

  return operations;
}
