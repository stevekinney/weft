/**
 * Read-side queries over a workflow's durable checkpoint, event log, and
 * timeline. These are inspection/visibility surfaces (no mutation); the write
 * path lives in `checkpoint-io.ts`.
 *
 * @module core/engine/checkpoint-reads
 */

import { KEYS } from '../../storage/interface.ts';
import { deserializeCheckpoint } from '../checkpoint.ts';
import { decode } from '../codec.ts';
import { sanitizeDebugValueForDisplay } from '../debug-output.ts';
import { EventLog } from '../event-log.ts';
import type {
  CheckpointState,
  CheckpointSummary,
  WorkflowEvent,
  WorkflowReplay,
  WorkflowTimelineEntry,
} from '../types.ts';
import {
  hydrateCheckpointReplayState,
  hydrateCheckpointReplayStateFromEntries,
} from './checkpoint-replay.ts';
import { readEventLogWatermark } from './event-log-compaction.ts';
import type { EngineInternals } from './internals.ts';
import {
  sanitizeCheckpointState,
  sanitizeTimelineSummary,
  sanitizeWorkflowEventPayload,
} from './state-utilities.ts';
import { isWorkflowTimelineEntry } from './validation.ts';

/** Retrieve the event history for a workflow. */
export async function getEvents(
  internals: EngineInternals,
  workflowId: string,
): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  const eventLog = new EventLog(internals.storage, workflowId);

  // Use EventLog.scan() instead of scanning the raw prefix so that the head
  // record (ev:{workflowId}:head) is filtered out by the isWorkflowLogEntry
  // guard inside scan(). Previously this method scanned the raw prefix and
  // returned a spurious entry for the head record on every checkpointed workflow.
  for await (const entry of eventLog.scan()) {
    events.push({
      type: entry.type,
      timestamp: entry.timestamp,
      data: sanitizeWorkflowEventPayload(entry.payload),
    });
  }

  return events;
}

/**
 * List checkpoint history entries for a workflow, newest first.
 * Returns summary metadata only — use getCheckpointAt for full state.
 */
export async function listCheckpoints(
  internals: EngineInternals,
  workflowId: string,
): Promise<CheckpointSummary[]> {
  if (internals.options.checkpointHistory <= 0) return [];

  const prefix = `${KEYS.checkpoint(workflowId)}:`;
  const summaries: CheckpointSummary[] = [];

  for await (const [, value] of internals.storage.scan(prefix, {
    reverse: true,
    limit: internals.options.checkpointHistory,
  })) {
    const checkpoint = deserializeCheckpoint(value);
    summaries.push({
      step: checkpoint.step,
      timestamp: checkpoint.createdAt,
      sizeBytes: value.byteLength,
    });
  }

  return summaries;
}

/** Retrieve the full deserialized checkpoint state at a specific step. */
export async function getCheckpointAt(
  internals: EngineInternals,
  workflowId: string,
  step: number,
): Promise<CheckpointState | null> {
  const bytes = await internals.storage.get(KEYS.checkpointHistory(workflowId, step));
  if (!bytes) return null;

  const checkpoint = await hydrateCheckpointReplayState(
    internals.storage,
    workflowId,
    deserializeCheckpoint(bytes),
  );
  return sanitizeCheckpointState({
    step: checkpoint.step,
    locals: checkpoint.locals,
    searchAttributes: checkpoint.searchAttributes,
    version: checkpoint.version,
    createdAt: checkpoint.createdAt,
  });
}

/** Return the durable per-step execution timeline for a workflow. */
export async function getTimeline(
  internals: EngineInternals,
  workflowId: string,
): Promise<WorkflowTimelineEntry[]> {
  const timeline: WorkflowTimelineEntry[] = [];

  for await (const [, value] of internals.storage.scan(KEYS.timelinePrefix(workflowId))) {
    let decoded: unknown;
    try {
      decoded = decode(value);
    } catch {
      continue;
    }

    if (isWorkflowTimelineEntry(decoded)) {
      timeline.push({
        ...decoded,
        inputSummary: sanitizeTimelineSummary(decoded.inputSummary) ?? decoded.inputSummary,
        ...(decoded.outputSummary !== undefined
          ? {
              outputSummary:
                sanitizeTimelineSummary(decoded.outputSummary) ?? decoded.outputSummary,
            }
          : {}),
      });
    }
  }

  timeline.sort((left, right) => left.step - right.step);
  return timeline;
}

/** Reconstruct workflow state at a historical checkpoint step. */
export async function replayTo(
  internals: EngineInternals,
  workflowId: string,
  step: number,
): Promise<WorkflowReplay | null> {
  const bytes = await internals.storage.get(KEYS.checkpointHistory(workflowId, step));
  if (!bytes) {
    return null;
  }

  const eventLog = new EventLog(internals.storage, workflowId);
  const entries = await eventLog.replay(Math.max(step - 1, -1));
  const checkpoint = hydrateCheckpointReplayStateFromEntries(deserializeCheckpoint(bytes), entries);

  // `replay` reconstructs from sequence 0, so whenever compaction has truncated
  // the early records the `[0, watermark.sequence)` prefix is missing from
  // `events` regardless of the requested step. Surface the boundary so callers
  // can tell an incomplete replay from a complete one.
  const watermark = await readEventLogWatermark(internals.storage, workflowId);

  return {
    checkpoint: sanitizeCheckpointState({
      step: checkpoint.step,
      locals: checkpoint.locals,
      searchAttributes: checkpoint.searchAttributes,
      version: checkpoint.version,
      createdAt: checkpoint.createdAt,
    }),
    accumulatedResults: checkpoint.accumulatedResults.map(([index, value]) => [
      index,
      sanitizeDebugValueForDisplay(value),
    ]),
    events: entries.map((entry) => ({
      type: entry.type,
      timestamp: entry.timestamp,
      data: sanitizeWorkflowEventPayload(entry.payload),
    })),
    ...(watermark !== null ? { compactedBefore: watermark.sequence } : {}),
  };
}
