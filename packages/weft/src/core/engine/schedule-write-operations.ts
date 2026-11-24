/**
 * The operations that write a schedule's record and swap its timer, which a schedule write commits
 * alone (`writeScheduleState`) and a timer tick that starts a run commits in the run's start
 * batch (COR-1925).
 */

import type { BatchOperation } from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import { encode } from '../codec.ts';
import { buildTimerBatchOperations } from '../scheduler.ts';
import type { ScheduleState } from '../types.ts';
import { resolveEffectiveScheduleFireAt } from './schedule-jitter.ts';
import { createScheduleTimerId } from './state-utilities.ts';

function buildPreviousScheduleTimerDeleteOperations(
  previousState: ScheduleState | undefined,
): BatchOperation[] {
  if (previousState?.status !== 'active' || previousState.nextFireAt === null) return [];
  return [
    {
      type: 'delete',
      key: KEYS.scheduleTick(
        resolveEffectiveScheduleFireAt(previousState, previousState.nextFireAt),
        previousState.id,
      ),
    },
  ];
}

function buildNextScheduleTimerOperations(
  state: ScheduleState,
  includeTimer: boolean,
): BatchOperation[] {
  if (!includeTimer || state.status !== 'active' || state.nextFireAt === null) return [];
  return buildTimerBatchOperations({
    id: createScheduleTimerId(state.id),
    workflowId: state.id,
    fireAt: resolveEffectiveScheduleFireAt(state, state.nextFireAt),
    kind: 'schedule',
  });
}

function buildScheduleTimerReplacementOperations(
  state: ScheduleState,
  includeTimer: boolean,
  previousState: ScheduleState | undefined,
): BatchOperation[] {
  const deleteOperations = buildPreviousScheduleTimerDeleteOperations(previousState);
  const nextTimerOperations = buildNextScheduleTimerOperations(state, includeTimer);
  if (nextTimerOperations.length > 0) return [...deleteOperations, ...nextTimerOperations];
  if (previousState === undefined) return deleteOperations;
  return [
    ...deleteOperations,
    { type: 'delete', key: `timer-idx:${createScheduleTimerId(state.id)}` },
  ];
}

/**
 * The operations that write `state` as the schedule's record: the record itself, and the
 * operations that follow it (the timer swap for `includeTimer` / `replaceTimerFrom`, and the
 * caller's `additionalOperations`). Resolves the bytes the record is written as too, which the next
 * write of the same writer is conditioned on.
 * `writeScheduleState` commits them alone; a schedule tick that starts a run commits the
 * same operations in the run's start batch (COR-1925).
 */
export function buildScheduleStateOperations(
  state: ScheduleState,
  options?: {
    includeTimer?: boolean;
    replaceTimerFrom?: ScheduleState;
    additionalOperations?: BatchOperation[];
  },
): { bytes: Uint8Array; record: BatchOperation; following: BatchOperation[] } {
  const bytes = encode(state);
  const includeTimer = options?.includeTimer ?? state.status === 'active';
  return {
    bytes,
    record: { type: 'put', key: KEYS.schedule(state.id), value: bytes },
    following: [
      ...buildScheduleTimerReplacementOperations(state, includeTimer, options?.replaceTimerFrom),
      ...(options?.additionalOperations ?? []),
    ],
  };
}
