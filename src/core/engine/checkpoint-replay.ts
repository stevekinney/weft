import { KEYS, type Storage } from '../../storage/interface.ts';
import { decode } from '../codec.ts';
import { isWorkflowLogEntry } from '../event-log-shared.ts';
import type {
  Checkpoint,
  WorkerReplayOperationFailure,
  WorkerReplayOperationSignature,
} from '../types.ts';
import { WORKER_REPLAY_SIGNATURE_FORMAT } from '../types/checkpoint.ts';

export const CHECKPOINT_REPLAY_PAYLOAD_KEY = '__weftCheckpointReplay';

export type CheckpointReplayPayload = {
  accumulatedResults?: Array<[number, unknown]>;
  workerReplaySignatures?: Array<[number, WorkerReplayOperationSignature]>;
  workerReplayFailures?: Array<[number, WorkerReplayOperationFailure]>;
};

type CheckpointReplayPayloadCarrier = Checkpoint & {
  [CHECKPOINT_REPLAY_PAYLOAD_KEY]?: CheckpointReplayPayload;
};

export type PrunedCheckpointReplayState = {
  checkpoint: Checkpoint;
  replayPayload: CheckpointReplayPayload | undefined;
};

const NO_REPLAY_WATERMARK = -1;

export function pruneCheckpointReplayState(
  checkpoint: Checkpoint,
  pendingOperationStep: number,
): PrunedCheckpointReplayState {
  const checkpointWithoutReplayPayload = stripTransientCheckpointReplayPayload(checkpoint);
  const previousWatermark =
    checkpointWithoutReplayPayload.accumulatedResultReplayWatermark ?? NO_REPLAY_WATERMARK;
  const consumedResults = entriesBeforeStep(
    checkpointWithoutReplayPayload.accumulatedResults,
    pendingOperationStep,
  );
  const consumedSignatures = entriesBeforeStep(
    checkpointWithoutReplayPayload.workerReplaySignatures ?? [],
    pendingOperationStep,
  );
  const consumedFailures = entriesBeforeStep(
    checkpointWithoutReplayPayload.workerReplayFailures ?? [],
    pendingOperationStep,
  );

  const replayPayload = buildReplayPayload({
    accumulatedResults: entriesAfterWatermark(consumedResults, previousWatermark),
    workerReplaySignatures: entriesAfterWatermark(consumedSignatures, previousWatermark),
    workerReplayFailures: entriesAfterWatermark(consumedFailures, previousWatermark),
  });
  const nextWatermark = resolveNextReplayWatermark(previousWatermark, replayPayload);
  const retainedWorkerReplaySignatures = entriesAtOrAfterStep(
    checkpointWithoutReplayPayload.workerReplaySignatures ?? [],
    pendingOperationStep,
  );
  const retainedWorkerReplayFailures = entriesAtOrAfterStep(
    checkpointWithoutReplayPayload.workerReplayFailures ?? [],
    pendingOperationStep,
  );
  const prunedCheckpoint: Checkpoint = {
    ...checkpointWithoutReplayPayload,
    accumulatedResults: entriesAtOrAfterStep(
      checkpointWithoutReplayPayload.accumulatedResults,
      pendingOperationStep,
    ),
    ...(nextWatermark === NO_REPLAY_WATERMARK
      ? {}
      : { accumulatedResultReplayWatermark: nextWatermark }),
    ...optionalEntries('workerReplaySignatures', retainedWorkerReplaySignatures),
    ...optionalEntries('workerReplayFailures', retainedWorkerReplayFailures),
  };

  if (nextWatermark === NO_REPLAY_WATERMARK) {
    delete prunedCheckpoint.accumulatedResultReplayWatermark;
  }
  if (retainedWorkerReplaySignatures.length === 0) {
    delete prunedCheckpoint.workerReplaySignatures;
  }
  if (retainedWorkerReplayFailures.length === 0) {
    delete prunedCheckpoint.workerReplayFailures;
  }

  return {
    checkpoint: prunedCheckpoint,
    replayPayload,
  };
}

export async function hydrateCheckpointReplayState(
  storage: Storage,
  workflowId: string,
  checkpoint: Checkpoint,
): Promise<Checkpoint> {
  const replayPayloads: CheckpointReplayPayload[] = [];
  const checkpointReplayPayload = readCheckpointReplayPayload(checkpoint);
  if (checkpointReplayPayload !== undefined) {
    replayPayloads.push(checkpointReplayPayload);
  }

  const compactedReplayPayload = await readCompactedCheckpointReplayPayload(storage, workflowId);
  if (compactedReplayPayload !== undefined) {
    replayPayloads.push(compactedReplayPayload);
  }

  for await (const [, entryBytes] of storage.scan(KEYS.eventPrefix(workflowId))) {
    const decoded = decode(entryBytes);
    if (!isWorkflowLogEntry(decoded)) continue;
    const entry = decoded;
    const checkpointStep = getCheckpointEventStep(entry.payload);
    if (checkpointStep === undefined) continue;
    if (checkpointStep > checkpoint.step) break;
    const replayPayload = readCheckpointReplayPayload(entry.payload);
    if (replayPayload === undefined) continue;
    replayPayloads.push(replayPayload);
  }

  return hydrateCheckpointReplayStateFromPayloads(
    stripTransientCheckpointReplayPayload(checkpoint),
    replayPayloads,
  );
}

export function hydrateCheckpointReplayStateFromPayload(
  checkpoint: Checkpoint,
  replayPayload: CheckpointReplayPayload | undefined,
): Checkpoint {
  return hydrateCheckpointReplayStateFromPayloads(
    stripTransientCheckpointReplayPayload(checkpoint),
    replayPayload === undefined ? [] : [replayPayload],
  );
}

function hydrateCheckpointReplayStateFromPayloads(
  checkpoint: Checkpoint,
  replayPayloads: Iterable<CheckpointReplayPayload>,
): Checkpoint {
  const accumulatedResults = new Map<number, unknown>();
  const workerReplaySignatures = new Map<number, WorkerReplayOperationSignature>();
  const workerReplayFailures = new Map<number, WorkerReplayOperationFailure>();

  for (const replayPayload of replayPayloads) {
    mergeReplayPayload(
      {
        accumulatedResults,
        workerReplaySignatures,
        workerReplayFailures,
      },
      replayPayload,
    );
  }

  mergeEntries(accumulatedResults, checkpoint.accumulatedResults);
  mergeEntries(workerReplaySignatures, checkpoint.workerReplaySignatures ?? []);
  mergeEntries(workerReplayFailures, checkpoint.workerReplayFailures ?? []);

  return {
    ...checkpoint,
    accumulatedResults: sortedEntries(accumulatedResults),
    ...optionalEntries('workerReplaySignatures', sortedEntries(workerReplaySignatures)),
    ...optionalEntries('workerReplayFailures', sortedEntries(workerReplayFailures)),
  };
}

export function attachTransientCheckpointReplayPayload(
  checkpoint: Checkpoint,
  replayPayload: CheckpointReplayPayload | undefined,
): Checkpoint {
  if (replayPayload === undefined) return checkpoint;
  const checkpointWithReplayPayload: CheckpointReplayPayloadCarrier = {
    ...checkpoint,
    [CHECKPOINT_REPLAY_PAYLOAD_KEY]: replayPayload,
  };
  return checkpointWithReplayPayload;
}

export function createCheckpointEventPayload(
  checkpointStep: number,
  replayPayload: CheckpointReplayPayload | undefined,
): Record<string, unknown> {
  return replayPayload === undefined
    ? { step: checkpointStep }
    : { step: checkpointStep, [CHECKPOINT_REPLAY_PAYLOAD_KEY]: replayPayload };
}

export function mergeCheckpointReplayPayloads(
  left: CheckpointReplayPayload | undefined,
  right: CheckpointReplayPayload | undefined,
): CheckpointReplayPayload | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return buildReplayPayload({
    accumulatedResults: [...(left.accumulatedResults ?? []), ...(right.accumulatedResults ?? [])],
    workerReplaySignatures: [
      ...(left.workerReplaySignatures ?? []),
      ...(right.workerReplaySignatures ?? []),
    ],
    workerReplayFailures: [
      ...(left.workerReplayFailures ?? []),
      ...(right.workerReplayFailures ?? []),
    ],
  });
}

export function readCheckpointReplayPayload(payload: unknown): CheckpointReplayPayload | undefined {
  if (!isRecord(payload)) return undefined;
  const replayPayload = payload[CHECKPOINT_REPLAY_PAYLOAD_KEY];
  if (!isRecord(replayPayload)) return undefined;
  return readCheckpointReplayPayloadRecord(replayPayload);
}

export function stripInternalCheckpointReplayPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const { [CHECKPOINT_REPLAY_PAYLOAD_KEY]: _internalReplayPayload, ...publicPayload } = payload;
  return publicPayload;
}

function buildReplayPayload(payload: CheckpointReplayPayload): CheckpointReplayPayload | undefined {
  const replayPayload: CheckpointReplayPayload = {};
  const accumulatedResults = payload.accumulatedResults;
  const workerReplaySignatures = payload.workerReplaySignatures;
  const workerReplayFailures = payload.workerReplayFailures;
  if (accumulatedResults !== undefined && accumulatedResults.length > 0) {
    replayPayload.accumulatedResults = accumulatedResults;
  }
  if (workerReplaySignatures !== undefined && workerReplaySignatures.length > 0) {
    replayPayload.workerReplaySignatures = workerReplaySignatures;
  }
  if (workerReplayFailures !== undefined && workerReplayFailures.length > 0) {
    replayPayload.workerReplayFailures = workerReplayFailures;
  }
  return Object.keys(replayPayload).length === 0 ? undefined : replayPayload;
}

function resolveNextReplayWatermark(
  previousWatermark: number,
  replayPayload: CheckpointReplayPayload | undefined,
): number {
  if (replayPayload === undefined) return previousWatermark;
  let nextWatermark = previousWatermark;
  for (const entries of [
    replayPayload.accumulatedResults ?? [],
    replayPayload.workerReplaySignatures ?? [],
    replayPayload.workerReplayFailures ?? [],
  ]) {
    for (const [step] of entries) {
      nextWatermark = Math.max(nextWatermark, step);
    }
  }
  return nextWatermark;
}

function entriesBeforeStep<T>(entries: Array<[number, T]>, step: number): Array<[number, T]> {
  return entries.filter(([entryStep]) => entryStep < step);
}

function entriesAtOrAfterStep<T>(entries: Array<[number, T]>, step: number): Array<[number, T]> {
  return entries.filter(([entryStep]) => entryStep >= step);
}

function entriesAfterWatermark<T>(
  entries: Array<[number, T]>,
  watermark: number,
): Array<[number, T]> {
  return entries.filter(([entryStep]) => entryStep > watermark);
}

function optionalEntries<TKey extends 'workerReplaySignatures' | 'workerReplayFailures', TValue>(
  key: TKey,
  entries: Array<[number, TValue]>,
): Partial<Record<TKey, Array<[number, TValue]>>> {
  return entries.length === 0 ? {} : ({ [key]: entries } as Record<TKey, Array<[number, TValue]>>);
}

function stripTransientCheckpointReplayPayload(checkpoint: Checkpoint): Checkpoint {
  const checkpointWithReplayPayload: CheckpointReplayPayloadCarrier = checkpoint;
  const { [CHECKPOINT_REPLAY_PAYLOAD_KEY]: _replayPayload, ...checkpointWithoutReplayPayload } =
    checkpointWithReplayPayload;
  return checkpointWithoutReplayPayload;
}

function sortedEntries<TValue>(entries: Map<number, TValue>): Array<[number, TValue]> {
  return [...entries.entries()].toSorted(([leftStep], [rightStep]) => leftStep - rightStep);
}

function mergeEntries<TValue>(target: Map<number, TValue>, entries: Array<[number, TValue]>): void {
  for (const [step, value] of entries) {
    target.set(step, value);
  }
}

function mergeReplayPayload(
  target: {
    accumulatedResults: Map<number, unknown>;
    workerReplaySignatures: Map<number, WorkerReplayOperationSignature>;
    workerReplayFailures: Map<number, WorkerReplayOperationFailure>;
  },
  replayPayload: CheckpointReplayPayload,
): void {
  mergeEntries(target.accumulatedResults, replayPayload.accumulatedResults ?? []);
  mergeEntries(target.workerReplaySignatures, replayPayload.workerReplaySignatures ?? []);
  mergeEntries(target.workerReplayFailures, replayPayload.workerReplayFailures ?? []);
}

function getCheckpointEventStep(payload: unknown): number | undefined {
  if (!isRecord(payload)) return undefined;
  const step = payload['step'];
  return typeof step === 'number' && Number.isSafeInteger(step) && step >= 0 ? step : undefined;
}

function readCheckpointReplayPayloadRecord(
  replayPayload: Record<string, unknown>,
): CheckpointReplayPayload | undefined {
  const accumulatedResults = readUnknownEntries(replayPayload['accumulatedResults']);
  const workerReplaySignatures = readWorkerReplaySignatureEntries(
    replayPayload['workerReplaySignatures'],
  );
  const workerReplayFailures = readWorkerReplayFailureEntries(
    replayPayload['workerReplayFailures'],
  );
  return buildReplayPayload({
    ...(accumulatedResults === undefined ? {} : { accumulatedResults }),
    ...(workerReplaySignatures === undefined ? {} : { workerReplaySignatures }),
    ...(workerReplayFailures === undefined ? {} : { workerReplayFailures }),
  });
}

async function readCompactedCheckpointReplayPayload(
  storage: Storage,
  workflowId: string,
): Promise<CheckpointReplayPayload | undefined> {
  const watermarkBytes = await storage.get(KEYS.eventWatermark(workflowId));
  if (watermarkBytes === null) return undefined;
  const watermark = decode(watermarkBytes);
  if (!isRecord(watermark)) return undefined;
  const replayPayload = watermark['checkpointReplay'];
  return isRecord(replayPayload) ? readCheckpointReplayPayloadRecord(replayPayload) : undefined;
}

function readUnknownEntries(value: unknown): Array<[number, unknown]> | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: Array<[number, unknown]> = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || !isReplayStep(entry[0])) continue;
    entries.push([entry[0], entry[1]]);
  }
  return entries;
}

function readWorkerReplaySignatureEntries(
  value: unknown,
): Array<[number, WorkerReplayOperationSignature]> | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: Array<[number, WorkerReplayOperationSignature]> = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || !isReplayStep(entry[0])) continue;
    if (!isWorkerReplaySignature(entry[1])) continue;
    entries.push([entry[0], entry[1]]);
  }
  return entries;
}

function readWorkerReplayFailureEntries(
  value: unknown,
): Array<[number, WorkerReplayOperationFailure]> | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: Array<[number, WorkerReplayOperationFailure]> = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || !isReplayStep(entry[0])) continue;
    if (!isWorkerReplayFailure(entry[1])) continue;
    entries.push([entry[0], entry[1]]);
  }
  return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isReplayStep(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isWorkerReplaySignature(value: unknown): value is WorkerReplayOperationSignature {
  if (!isRecord(value)) return false;
  return (
    value['format'] === WORKER_REPLAY_SIGNATURE_FORMAT &&
    typeof value['operationType'] === 'string' &&
    typeof value['stableFieldsDigest'] === 'string' &&
    isReplayStep(value['stableFieldsByteLength'])
  );
}

function isWorkerReplayFailure(value: unknown): value is WorkerReplayOperationFailure {
  if (!isRecord(value)) return false;
  const failureCategory = value['failureCategory'];
  return (
    value['status'] === 'failed' &&
    typeof value['error'] === 'string' &&
    (value['errorName'] === undefined || typeof value['errorName'] === 'string') &&
    (failureCategory === undefined ||
      failureCategory === 'application' ||
      failureCategory === 'cancellation' ||
      failureCategory === 'resource' ||
      failureCategory === 'system' ||
      failureCategory === 'timeout')
  );
}
