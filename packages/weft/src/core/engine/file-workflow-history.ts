import type { BatchOperation, ConditionalBatchCondition } from "../../embedded/storage/src/index.ts";

import { KEYS } from '../../storage/keys.ts';
import { decode, encode } from '../codec.ts';
import type { ContextOperationRequest } from '../context.ts';
import { EventLog, type EventHeadRecord } from '../event-log.ts';
import {
  addressPayload,
  pendingCompletionEvents,
  type FileWorkflowEvent,
} from './file-workflow-completion-events.ts';
import type { EngineInternals } from './internals.ts';
import { resolveWorkflowSourceForExecution } from './source-resolution.ts';
import { loadWorkflowState } from './storage-io.ts';

const FILE_WORKFLOW_TAG = 'file-workflow';

export type FileWorkflowRunIdentity = Readonly<{
  type: string;
  revision: string | undefined;
  workflowExecutionToken: string | undefined;
  generation: Uint8Array | null;
}>;

type PreparedTerminalHistory = Readonly<{
  identity: FileWorkflowRunIdentity;
  append: (operations: BatchOperation[]) => EventHeadRecord;
  head: () => EventHeadRecord;
  condition: () => ConditionalBatchCondition;
}>;

function isTaggedFileWorkflow(definition: unknown): boolean {
  if (typeof definition !== 'object' || definition === null || !('tags' in definition)) {
    return false;
  }
  return Array.isArray(definition.tags) && definition.tags.includes(FILE_WORKFLOW_TAG);
}

async function workflowIdentity(
  internals: EngineInternals,
  workflowId: string,
): Promise<{ type: string; revision: string | undefined } | undefined> {
  const cached = internals.workflowTypeByWorkflowId?.get(workflowId);
  if (cached !== undefined) return cached;
  const bytes = await internals.storage.get(KEYS.workflow(workflowId));
  if (bytes === null) return undefined;
  const state = decode(bytes) as { type?: string; revision?: string };
  return state.type === undefined ? undefined : { type: state.type, revision: state.revision };
}

async function resolvePinnedWorkflowDefinition(
  internals: EngineInternals,
  identity: { type: string; revision: string },
): Promise<unknown> {
  const resolved = internals.sources.resolved.get(identity.type);
  const exact = resolved?.get(identity.revision);
  if (exact !== undefined) return exact.definition;
  if (!internals.sources.byName.get(identity.type)?.has(identity.revision)) return undefined;
  const engine = internals.engine as Parameters<typeof resolveWorkflowSourceForExecution>[0];
  await resolveWorkflowSourceForExecution(engine, identity.type, identity.revision);
  return internals.sources.resolved.get(identity.type)?.get(identity.revision)?.definition;
}

async function fileWorkflowDefinition(
  internals: EngineInternals,
  identity: { type: string; revision?: string | undefined },
): Promise<unknown> {
  const resolved = internals.sources.resolved.get(identity.type);
  if (identity.revision !== undefined) {
    const pinned = await resolvePinnedWorkflowDefinition(internals, {
      type: identity.type,
      revision: identity.revision,
    });
    if (pinned !== undefined) return pinned;
    if (resolved !== undefined) return undefined;
  }
  if (resolved?.size === 1) return [...resolved.values()][0]?.definition;
  return internals.workflowDefinitionsByName.get(identity.type);
}

async function isFileWorkflow(
  internals: EngineInternals,
  workflowId: string,
  surfaceSourceErrors = false,
): Promise<boolean> {
  const cached = internals.workflowTypeByWorkflowId?.get(workflowId);
  if (
    cached !== undefined &&
    !internals.sources.byName.has(cached.type) &&
    !internals.sources.resolved.has(cached.type)
  ) {
    return isTaggedFileWorkflow(internals.workflowDefinitionsByName.get(cached.type));
  }
  const identity = await workflowIdentity(internals, workflowId);
  if (identity === undefined) return false;
  try {
    return isTaggedFileWorkflow(await fileWorkflowDefinition(internals, identity));
  } catch (error) {
    if (surfaceSourceErrors) throw error;
    return false;
  }
}

export async function captureFileWorkflowRunIdentity(
  internals: EngineInternals,
  workflowId: string,
): Promise<FileWorkflowRunIdentity | undefined> {
  const state = await loadWorkflowState(internals, workflowId);
  if (state === null) return undefined;
  let generation: Uint8Array | null;
  try {
    generation = await internals.storage.get(KEYS.workflowGeneration(workflowId));
  } catch {
    // A remote terminator can still commit the state transition when the optional
    // generation read is unavailable; terminal teardown will fail closed without it.
    return undefined;
  }
  return {
    type: state.type,
    revision: state.revision,
    workflowExecutionToken: state.workflowExecutionToken,
    generation,
  };
}

function sameFileWorkflowRun(
  expected: FileWorkflowRunIdentity,
  current: FileWorkflowRunIdentity | undefined,
): boolean {
  if (current === undefined) return false;
  if (
    current.type !== expected.type ||
    current.revision !== expected.revision ||
    current.workflowExecutionToken !== expected.workflowExecutionToken
  ) {
    return false;
  }
  if (current.generation === null || expected.generation === null) {
    return current.generation === expected.generation;
  }
  const expectedGeneration = expected.generation;
  const currentGeneration = current.generation;
  return (
    currentGeneration.length === expectedGeneration.length &&
    currentGeneration.every((byte, index) => byte === expectedGeneration[index])
  );
}

function eventKey(event: FileWorkflowEvent): string {
  if (event.type === 'file-workflow:run-terminal') return event.type;
  return `${event.type}:${String(event.payload['stepAddress'] ?? event.payload['step'])}`;
}

function stepKind(
  operation: ContextOperationRequest,
): 'activity' | 'await-signal' | 'sleep' | undefined {
  const kinds: Record<
    ContextOperationRequest['type'],
    'activity' | 'await-signal' | 'sleep' | undefined
  > = {
    activity: 'activity',
    'wait-signal': 'await-signal',
    sleep: 'sleep',
    'wait-update': undefined,
  } as Record<ContextOperationRequest['type'], 'activity' | 'await-signal' | 'sleep' | undefined>;
  return kinds[operation.type];
}

function stepIndex(operation: ContextOperationRequest, fallback: number): number {
  return (
    (operation as ContextOperationRequest & { documentStep?: number }).documentStep ??
    (operation.type === 'activity' ? operation.step : undefined) ??
    fallback
  );
}

function stepAddress(operation: ContextOperationRequest, fallback: number): string {
  return (
    (operation as ContextOperationRequest & { documentStepAddress?: string }).documentStepAddress ??
    String(stepIndex(operation, fallback))
  );
}

async function existingFileWorkflowEvents(
  internals: EngineInternals,
  workflowId: string,
): Promise<Set<string>> {
  const keys = new Set<string>();
  for await (const [, bytes] of internals.storage.scan(
    KEYS.fileWorkflowEventReceiptPrefix(workflowId),
  )) {
    const receipt = decode(bytes) as { eventKey?: string };
    if (receipt.eventKey !== undefined) keys.add(receipt.eventKey);
  }
  return keys;
}

const RESTARTED_EVENT_PREFIXES = [
  'file-workflow:step-started:',
  'file-workflow:activity-started:',
  'file-workflow:signal-waiting:',
] as const;
const COMPLETED_EVENT_PREFIX = 'file-workflow:step-completed:';

/**
 * The deletes that let a failed run reactivated from its checkpoint record what it does again.
 * A history event is written once per receipt, so without these the step the run failed at would
 * start again with nothing recorded, and its second end would be dropped as a repeat of the first.
 * A step that completed keeps its receipts (it never runs again); the receipts of every step that
 * started and did not complete, and of the run's end, are removed, so the events of the retry
 * follow the failure in the history: the step starts again, completes, and the run ends again.
 */
export async function fileWorkflowRetryReceiptResets(
  internals: EngineInternals,
  workflowId: string,
): Promise<BatchOperation[]> {
  const receipts: { key: string; eventKey: string }[] = [];
  for await (const [key, bytes] of internals.storage.scan(
    KEYS.fileWorkflowEventReceiptPrefix(workflowId),
  )) {
    const receipt = decode(bytes) as { eventKey?: string };
    if (receipt.eventKey !== undefined) receipts.push({ key, eventKey: receipt.eventKey });
  }
  const completed = new Set(
    receipts
      .filter((receipt) => receipt.eventKey.startsWith(COMPLETED_EVENT_PREFIX))
      .map((receipt) => receipt.eventKey.slice(COMPLETED_EVENT_PREFIX.length)),
  );
  return receipts
    .filter(
      (receipt) =>
        receipt.eventKey === 'file-workflow:run-terminal' ||
        RESTARTED_EVENT_PREFIXES.some(
          (prefix) =>
            receipt.eventKey.startsWith(prefix) &&
            !completed.has(receipt.eventKey.slice(prefix.length)),
        ),
    )
    .map((receipt): BatchOperation => ({ type: 'delete', key: receipt.key }));
}

function appendEvents(
  internals: EngineInternals,
  workflowId: string,
  operations: BatchOperation[],
  events: readonly FileWorkflowEvent[],
  existing: ReadonlySet<string>,
  initialHead: EventHeadRecord,
): EventHeadRecord {
  const log = new EventLog(internals.storage, workflowId, internals.options.getNow);
  let head = initialHead;
  const appended = new Set<string>();
  for (const event of events) {
    const key = eventKey(event);
    if (existing.has(key) || appended.has(key)) continue;
    head = log.appendToBatch(event, operations, head).newHead;
    operations.push({
      type: 'put',
      key: KEYS.fileWorkflowEventReceipt(workflowId, key),
      value: encode({ eventKey: key, type: event.type, payload: event.payload }),
    });
    appended.add(key);
  }
  return head;
}

function startEvents(operation: ContextOperationRequest, step: number): FileWorkflowEvent[] {
  if (operation.type === 'parallel' || operation.type === 'race') {
    // Each child is its own document step: it carries its own index and address.
    return operation.operations.flatMap((child) => startEvents(child, stepIndex(child, step)));
  }
  const documentStep = (operation as ContextOperationRequest & { documentStep?: number })
    .documentStep;
  if (documentStep === undefined && operation.type !== 'activity') return [];
  const kind = stepKind(operation);
  if (kind === undefined) return [];
  const events: FileWorkflowEvent[] = [
    {
      type: 'file-workflow:step-started',
      payload: { step, ...addressPayload(stepAddress(operation, step), step), kind },
    },
  ];
  if (kind === 'activity') {
    events.push({
      type: 'file-workflow:activity-started',
      payload: {
        step,
        ...addressPayload(stepAddress(operation, step), step),
        handler: operation.type === 'activity' ? operation.activityName : '',
      },
    });
  } else if (kind === 'await-signal') {
    events.push({
      type: 'file-workflow:signal-waiting',
      payload: {
        step,
        ...addressPayload(stepAddress(operation, step), step),
        signal: operation.type === 'wait-signal' ? operation.signalName : '',
      },
    });
  }
  return events;
}

export async function appendFileWorkflowCheckpointEvents(
  internals: EngineInternals,
  workflowId: string,
  operation: ContextOperationRequest,
  pendingStepIndex: number,
  operations: BatchOperation[],
  initialHead: EventHeadRecord,
  settledEvents: readonly FileWorkflowEvent[] = [],
): Promise<EventHeadRecord> {
  if (!(await isFileWorkflow(internals, workflowId))) return initialHead;
  const existing = await existingFileWorkflowEvents(internals, workflowId);
  const pending = internals.pendingTimelineEntries.get(workflowId)?.entry;
  // `settledEvents` are the completions a commit made while its coordinator is still running
  // reports for the steps it has settled so far (an advancing parallel step's branches).
  const events = [
    ...pendingCompletionEvents(pending),
    ...settledEvents,
    ...startEvents(operation, stepIndex(operation, pendingStepIndex)),
  ];
  return appendEvents(internals, workflowId, operations, events, existing, initialHead);
}

export async function prepareFileWorkflowTerminalHistory(
  internals: EngineInternals,
  workflowId: string,
  status: 'completed' | 'failed' | 'cancelled' | 'timed-out',
  expectedRun?: FileWorkflowRunIdentity,
): Promise<PreparedTerminalHistory | undefined> {
  const run =
    expectedRun ??
    ((await isFileWorkflow(internals, workflowId, status === 'cancelled' || status === 'timed-out'))
      ? await captureFileWorkflowRunIdentity(internals, workflowId)
      : undefined);
  if (run === undefined) return undefined;
  const currentRun = await captureFileWorkflowRunIdentity(internals, workflowId);
  if (!sameFileWorkflowRun(run, currentRun)) return undefined;
  if (!(await isTerminalFileWorkflow(internals, run, status))) return undefined;
  const initialHead = await new EventLog(
    internals.storage,
    workflowId,
    internals.options.getNow,
  ).loadHead();
  const existing = await existingFileWorkflowEvents(internals, workflowId);
  const pending = internals.pendingTimelineEntries.get(workflowId)?.entry;
  const terminal: FileWorkflowEvent = {
    type: 'file-workflow:run-terminal',
    payload: {
      status,
      ...(status === 'failed' ? { message: 'Workflow run failed.' } : {}),
      ...(status === 'timed-out' ? { message: 'Workflow run timed out.' } : {}),
    },
  };
  const events = [...pendingCompletionEvents(pending), terminal];
  let lastHead = initialHead;
  return {
    identity: run,
    append: (operations) => {
      lastHead = appendEvents(internals, workflowId, operations, events, existing, initialHead);
      return lastHead;
    },
    head: () => lastHead,
    condition: () => ({
      key: KEYS.eventHead(workflowId),
      expectedValue: initialHead.sequence < 0 ? null : encode(initialHead),
    }),
  };
}

async function isTerminalFileWorkflow(
  internals: EngineInternals,
  run: FileWorkflowRunIdentity,
  status: 'completed' | 'failed' | 'cancelled' | 'timed-out',
): Promise<boolean> {
  try {
    return isTaggedFileWorkflow(
      await fileWorkflowDefinition(internals, { type: run.type, revision: run.revision }),
    );
  } catch (error) {
    if (status === 'cancelled' || status === 'timed-out') throw error;
    return false;
  }
}

export function recordFileWorkflowTerminalHistory(
  internals: EngineInternals,
  workflowId: string,
  prepared: PreparedTerminalHistory | undefined,
): void {
  if (prepared !== undefined) internals.eventLogHeads.set(workflowId, prepared.head());
}

export function fileWorkflowTerminalOperations(
  prepared: PreparedTerminalHistory | undefined,
): BatchOperation[] {
  const operations: BatchOperation[] = [];
  prepared?.append(operations);
  return operations;
}

export async function fileWorkflowHistoryHeadChanged(
  internals: EngineInternals,
  workflowId: string,
  prepared: PreparedTerminalHistory,
): Promise<boolean> {
  const current = await new EventLog(
    internals.storage,
    workflowId,
    internals.options.getNow,
  ).loadHead();
  const expected = prepared.condition().expectedValue;
  if (expected === null) return current.sequence >= 0;
  const actual = encode(current);
  if (actual.length !== expected.length) return true;
  return actual.some((byte, index) => byte !== expected[index]);
}

export async function shouldRetryFileWorkflowTermination(
  internals: EngineInternals,
  workflowId: string,
  prepared: PreparedTerminalHistory | undefined,
  attempt: number,
): Promise<boolean> {
  return prepared !== undefined && attempt < 10
    ? fileWorkflowHistoryHeadChanged(internals, workflowId, prepared)
    : false;
}
