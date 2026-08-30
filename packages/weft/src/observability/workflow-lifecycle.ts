import {
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowTimedOutEvent,
} from '../core/events';
import type { ObservabilityState } from './types';

const WORKFLOW_SPAN_TTL_MS = 60 * 60 * 1000;
const WORKFLOW_SPAN_MAX_SIZE = 10_000;
const DEFAULT_STALE_SPAN_MAX_AGE_MS = 60 * 60 * 1000;

export function evictStaleWorkflowSpans(state: ObservabilityState): void {
  const now = Date.now();

  for (const [id, entry] of state.workflowSpans) {
    if (now - entry.createdAt > WORKFLOW_SPAN_TTL_MS) {
      entry.span.end();
      state.workflowSpans.delete(id);
    }
  }

  if (state.workflowSpans.size > WORKFLOW_SPAN_MAX_SIZE) {
    const excess = state.workflowSpans.size - WORKFLOW_SPAN_MAX_SIZE;
    let removed = 0;
    for (const [id, entry] of state.workflowSpans) {
      if (removed >= excess) break;
      entry.span.end();
      state.workflowSpans.delete(id);
      removed++;
    }
  }
}

export function endAndRemoveWorkflowSpan(state: ObservabilityState, workflowId: string): void {
  const entry = state.workflowSpans.get(workflowId);
  if (entry) {
    entry.span.end();
    state.workflowSpans.delete(workflowId);
  }
}

export function createWorkflowLifecycle(state: ObservabilityState): {
  endWorkflowSpan: (workflowId: string, status: 'ok' | 'error', message?: string) => void;
  evictStaleSpans: (maxAgeMs?: number) => number;
  dispose: () => void;
} {
  function endWorkflowSpan(workflowId: string, status: 'ok' | 'error', message?: string): void {
    const entry = state.workflowSpans.get(workflowId);
    if (!entry) return;
    if (status === 'error') {
      entry.span.setStatus({
        code: state.SpanStatusCode.ERROR,
        ...(message ? { message } : {}),
      });
    } else {
      entry.span.setStatus({ code: state.SpanStatusCode.OK });
    }
    entry.span.end();
    state.workflowSpans.delete(workflowId);
  }

  const onWorkflowCompleted = (event: Event): void => {
    if (!(event instanceof WorkflowCompletedEvent)) return;
    endWorkflowSpan(event.workflowId, 'ok');
  };

  const onWorkflowFailed = (event: Event): void => {
    if (!(event instanceof WorkflowFailedEvent)) return;
    endWorkflowSpan(event.workflowId, 'error', event.error.message);
    state.metrics.increment('weft.dpmo.defects');
  };

  const onWorkflowCancelled = (event: Event): void => {
    if (!(event instanceof WorkflowCancelledEvent)) return;
    endWorkflowSpan(event.workflowId, 'error', 'Workflow cancelled');
  };

  const onWorkflowTimedOut = (event: Event): void => {
    if (!(event instanceof WorkflowTimedOutEvent)) return;
    endWorkflowSpan(
      event.workflowId,
      'error',
      `Workflow timed out (${event.timeoutType}) after ${event.elapsed}ms`,
    );
    state.metrics.increment('weft.dpmo.defects');
  };

  if (state.eventTarget) {
    state.eventTarget.addEventListener(WorkflowCompletedEvent.type, onWorkflowCompleted);
    state.eventTarget.addEventListener(WorkflowFailedEvent.type, onWorkflowFailed);
    state.eventTarget.addEventListener(WorkflowCancelledEvent.type, onWorkflowCancelled);
    state.eventTarget.addEventListener(WorkflowTimedOutEvent.type, onWorkflowTimedOut);
  }

  function evictStaleSpans(maxAgeMs: number = DEFAULT_STALE_SPAN_MAX_AGE_MS): number {
    const cutoff = Date.now() - maxAgeMs;
    let evicted = 0;
    for (const [workflowId, entry] of state.workflowSpans) {
      if (entry.createdAt <= cutoff) {
        entry.span.setStatus({
          code: state.SpanStatusCode.ERROR,
          message: 'span evicted (stale)',
        });
        entry.span.end();
        state.workflowSpans.delete(workflowId);
        evicted++;
      }
    }
    return evicted;
  }

  function dispose(): void {
    if (state.eventTarget) {
      state.eventTarget.removeEventListener(WorkflowCompletedEvent.type, onWorkflowCompleted);
      state.eventTarget.removeEventListener(WorkflowFailedEvent.type, onWorkflowFailed);
      state.eventTarget.removeEventListener(WorkflowCancelledEvent.type, onWorkflowCancelled);
      state.eventTarget.removeEventListener(WorkflowTimedOutEvent.type, onWorkflowTimedOut);
    }

    for (const entry of state.workflowSpans.values()) {
      entry.span.setStatus({ code: state.SpanStatusCode.ERROR, message: 'Observability disposed' });
      entry.span.end();
    }
    state.workflowSpans.clear();
  }

  return { endWorkflowSpan, evictStaleSpans, dispose };
}
