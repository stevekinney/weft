import { decode, encode } from '../core/codec.ts';
import { PersistedDataCorruptError } from '../core/persisted-data-incompatible-error.ts';
import { KEYS, type BatchOperation, type Storage } from '../storage/interface.ts';
import {
  decodeCursor,
  encodeCursor,
  type Cursor,
  type FleetEventEnvelope,
  type FleetEventInput,
} from './workflow-event-feed.ts';

export const REPLAY_PAGE_SIZE = 128;
export const DEFAULT_RETENTION_BATCH_SIZE = 100;

export async function loadTailAuthority(
  storage: Storage,
): Promise<{ tail: number; tailValue: Uint8Array | null } | null> {
  const tailValue = await storage.get(KEYS.fleetEventTail());
  const tail = tailValue === null ? -1 : decodeTailOrThrow(tailValue);
  const highest = await highestFleetEventSequence(storage);
  if (highest > tail) {
    const refreshedTailValue = await storage.get(KEYS.fleetEventTail());
    if (!bytesEqual(refreshedTailValue, tailValue)) return null;
    throw new PersistedDataCorruptError(KEYS.fleetEventTail());
  }
  return { tail, tailValue };
}

export async function loadConsistentReplayPage(
  storage: Storage,
  afterSequence: number,
): Promise<{ floor: number; envelopes: FleetEventEnvelope[] }> {
  for (let attempt = 1; attempt <= 25; attempt += 1) {
    const floorValue = await storage.get(KEYS.fleetEventWatermark());
    const floor = decodeRetentionFloorOrThrow(floorValue);
    const envelopes: FleetEventEnvelope[] = [];
    const scanOptions = {
      ...(afterSequence >= 0 ? { gt: KEYS.fleetEvent(afterSequence) } : {}),
      limit: REPLAY_PAGE_SIZE,
    };
    for await (const [key, value] of storage.scan(KEYS.fleetEventPrefix(), scanOptions)) {
      const sequence = parseFleetEventSequenceFromKey(key);
      if (sequence === null) throw new PersistedDataCorruptError(key);
      if (sequence <= afterSequence) continue;
      const decoded = decodeStorageValue(value, key);
      if (!isFleetEventEnvelope(decoded) || decoded.sequence !== sequence) {
        throw new PersistedDataCorruptError(key);
      }
      envelopes.push(decoded);
    }
    const refreshedFloorValue = await storage.get(KEYS.fleetEventWatermark());
    if (bytesEqual(refreshedFloorValue, floorValue)) return { floor, envelopes };
  }
  throw new Error('Fleet event replay could not obtain a stable retention snapshot.');
}

/**
 * Owner-indexed sibling of `loadConsistentReplayPage`: scans the
 * `fleet-event-by-workflow:<workflowId>:` index instead of the full
 * `fleet-event:` keyspace, then reads each matching sequence's envelope
 * directly by key via `readWorkflowFleetEvent`. Unlike `loadConsistentReplayPage`
 * — which reads a key and its value from the same `storage.scan()` snapshot —
 * the event value here comes from a separate `storage.get()` issued after the
 * index scan, so a legitimate concurrent deletion (by `retain()` or
 * `Engine.purge()`) can land in that window; see `readWorkflowFleetEvent` for
 * how that is told apart from genuine corruption.
 *
 * The floor/watermark stability retry below is unrelated to that: it exists
 * so the `floor` value returned is consistent with what was actually scanned,
 * which only `retain()` affects (`Engine.purge()` never writes
 * `fleetEventWatermark`), keeping this function's gap-detection contract
 * identical to `loadConsistentReplayPage`'s.
 */
export async function loadConsistentWorkflowReplayPage(
  storage: Storage,
  workflowId: string,
  afterSequence: number,
): Promise<{ floor: number; envelopes: FleetEventEnvelope[]; scannedIndexEntries: number }> {
  for (let attempt = 1; attempt <= 25; attempt += 1) {
    const floorValue = await storage.get(KEYS.fleetEventWatermark());
    const floor = decodeRetentionFloorOrThrow(floorValue);
    const candidateSequences: number[] = [];
    const scanOptions = {
      ...(afterSequence >= 0 ? { gt: KEYS.fleetEventByWorkflow(workflowId, afterSequence) } : {}),
      limit: REPLAY_PAGE_SIZE,
    };
    for await (const [key] of storage.scan(
      KEYS.fleetEventByWorkflowPrefix(workflowId),
      scanOptions,
    )) {
      const sequence = parseFleetEventByWorkflowSequenceFromKey(workflowId, key);
      if (sequence === null) throw new PersistedDataCorruptError(key);
      if (sequence <= afterSequence) continue;
      candidateSequences.push(sequence);
    }
    const envelopes: FleetEventEnvelope[] = [];
    for (const sequence of candidateSequences) {
      const envelope = await readWorkflowFleetEvent(storage, workflowId, sequence);
      // A `null` here already went through readWorkflowFleetEvent's own
      // legitimacy check — it is a confirmed benign concurrent deletion, not
      // a signal that this page needs retrying, so it is just left out.
      if (envelope !== null) envelopes.push(envelope);
    }
    const refreshedFloorValue = await storage.get(KEYS.fleetEventWatermark());
    if (bytesEqual(refreshedFloorValue, floorValue)) {
      return { floor, envelopes, scannedIndexEntries: candidateSequences.length };
    }
  }
  throw new Error('Fleet event replay could not obtain a stable retention snapshot.');
}

/**
 * Read one workflow-indexed fleet event by sequence, tolerating a benign
 * concurrent deletion. `retain()` and `Engine.purge()`
 * (`addWorkflowLinkedFleetEventDeleteKeys` in `core/engine/bulk-operations-purge.ts`)
 * are each the sole writer of their own atomic batch that deletes a
 * `fleet-event:<sequence>` record together with its
 * `fleet-event-by-workflow:` index entry for the same sequence — `retain()`
 * via `storageConditionalBatch`, purge via `commitFencedEngineWrite`, both
 * documented as committing their operations atomically. So if the event
 * record is missing, the index entry for that exact sequence is either also
 * already gone (an ordinary concurrent deletion by either of them — those
 * two are the only callers that ever delete these keys, so nothing else
 * could explain it) or it is still present, meaning the pair was torn apart
 * by something that is not one of those atomic batches: genuine corruption.
 * This check does not depend on `fleetEventWatermark`, since purge never
 * writes it — only `retain()` does.
 */
export async function readWorkflowFleetEvent(
  storage: Storage,
  workflowId: string,
  sequence: number,
): Promise<FleetEventEnvelope | null> {
  const eventKey = KEYS.fleetEvent(sequence);
  const value = await storage.get(eventKey);
  if (value === null) {
    const indexValue = await storage.get(KEYS.fleetEventByWorkflow(workflowId, sequence));
    if (indexValue === null) return null;
    throw new PersistedDataCorruptError(eventKey);
  }
  const decoded = decodeStorageValue(value, eventKey);
  if (
    !isFleetEventEnvelope(decoded) ||
    decoded.sequence !== sequence ||
    decoded.workflowId !== workflowId
  ) {
    // Immutable data disagreeing with its own index entry can never be a
    // benign concurrent deletion — sequences are append-only and a
    // committed envelope's `workflowId` never changes — so this is always
    // genuine corruption, unlike a missing record.
    throw new PersistedDataCorruptError(eventKey);
  }
  return decoded;
}

export function decodeCursorOrThrow(cursor: Cursor): number {
  const sequence = decodeCursor(cursor);
  if (sequence === null) throw new Error('Invalid cursor');
  return sequence;
}

export function createGapEnvelope(
  sequence: number,
  requestedCursor: Cursor,
  firstRetainedSequence: number,
): FleetEventEnvelope {
  return {
    kind: 'fleet:gap',
    sequence,
    cursor: encodeCursor(sequence),
    emittedAtMs: 0,
    payload: { requestedCursor, firstRetainedSequence },
  };
}

export function bytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

export function createFleetEventEnvelope(
  event: FleetEventInput,
  sequence: number,
): FleetEventEnvelope {
  return {
    kind: event.kind,
    sequence,
    cursor: encodeCursor(sequence),
    emittedAtMs: event.emittedAtMs,
    ...(event.workflowId === undefined ? {} : { workflowId: event.workflowId }),
    payload: event.payload,
  };
}

export function createFleetEventOperations(
  envelope: FleetEventEnvelope,
  callerOperations: readonly BatchOperation[],
): BatchOperation[] {
  return [
    ...callerOperations,
    { type: 'put', key: KEYS.fleetEvent(envelope.sequence), value: encode(envelope) },
    { type: 'put', key: KEYS.fleetEventTail(), value: encode({ sequence: envelope.sequence }) },
    ...(envelope.workflowId === undefined
      ? []
      : [
          {
            type: 'put' as const,
            key: KEYS.fleetEventByWorkflow(envelope.workflowId, envelope.sequence),
            value: new Uint8Array(),
          },
        ]),
  ];
}

export function validateRetentionOptions(options: {
  beforeSequence: number;
  limit?: number;
}): void {
  if (!Number.isSafeInteger(options.beforeSequence) || options.beforeSequence < 0) {
    throw new RangeError('Fleet event retention sequence must be a non-negative safe integer.');
  }
  const limit = options.limit ?? DEFAULT_RETENTION_BATCH_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('Fleet event retention limit must be positive.');
  }
}

export async function collectRetentionRecords(
  storage: Storage,
  target: number,
  limit: number,
): Promise<Array<{ key: string; sequence: number; workflowId?: string }>> {
  const records: Array<{ key: string; sequence: number; workflowId?: string }> = [];
  for await (const [key, value] of storage.scan(KEYS.fleetEventPrefix(), {
    lt: KEYS.fleetEvent(target),
    limit,
  })) {
    const sequence = parseFleetEventSequenceFromKey(key);
    if (sequence === null) throw new PersistedDataCorruptError(key);
    if (sequence < target) {
      const envelope = decodeStorageValue(value, key);
      if (!isFleetEventEnvelope(envelope) || envelope.sequence !== sequence) {
        throw new PersistedDataCorruptError(key);
      }
      records.push({
        key,
        sequence,
        ...(envelope.workflowId === undefined ? {} : { workflowId: envelope.workflowId }),
      });
    }
  }
  return records;
}

export function decodeRetentionFloorOrThrow(value: Uint8Array | null): number {
  if (value === null) return 0;
  const decoded = decodeStorageValue(value, KEYS.fleetEventWatermark());
  if (!isFloorRecord(decoded)) throw new PersistedDataCorruptError(KEYS.fleetEventWatermark());
  return decoded.firstRetainedSequence;
}

export function decodeStorageValue(value: Uint8Array, key: string): unknown {
  try {
    return decode(value);
  } catch {
    throw new PersistedDataCorruptError(key);
  }
}

export function decodeTailOrThrow(value: Uint8Array): number {
  const decoded = decodeStorageValue(value, KEYS.fleetEventTail());
  if (!isTailRecord(decoded)) throw new PersistedDataCorruptError(KEYS.fleetEventTail());
  return decoded.sequence;
}

export async function highestFleetEventSequence(storage: Storage): Promise<number> {
  for await (const [key] of storage.scan(KEYS.fleetEventPrefix(), { reverse: true, limit: 1 })) {
    const sequence = parseFleetEventSequenceFromKey(key);
    if (sequence === null) throw new PersistedDataCorruptError(key);
    return sequence;
  }
  return -1;
}

export function parseFleetEventSequenceFromKey(key: string): number | null {
  if (!key.startsWith(KEYS.fleetEventPrefix())) return null;
  const rawSequence = key.slice(KEYS.fleetEventPrefix().length);
  if (!/^\d+$/.test(rawSequence)) return null;
  const sequence = Number(rawSequence);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

export function parseFleetEventByWorkflowSequenceFromKey(
  workflowId: string,
  key: string,
): number | null {
  const prefix = KEYS.fleetEventByWorkflowPrefix(workflowId);
  if (!key.startsWith(prefix)) return null;
  const rawSequence = key.slice(prefix.length);
  if (!/^\d+$/.test(rawSequence)) return null;
  const sequence = Number(rawSequence);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

export function isTailRecord(value: unknown): value is { sequence: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'sequence' in value &&
    Number.isSafeInteger(value.sequence)
  );
}

export function isFloorRecord(value: unknown): value is { firstRetainedSequence: number } {
  if (typeof value !== 'object' || value === null) return false;
  const firstRetainedSequence = (value as Record<string, unknown>)['firstRetainedSequence'];
  return Number.isSafeInteger(firstRetainedSequence) && (firstRetainedSequence as number) >= 0;
}

export function isFleetEventEnvelope(value: unknown): value is FleetEventEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['kind'] === 'string' &&
    Number.isSafeInteger(record['sequence']) &&
    typeof record['cursor'] === 'string' &&
    decodeCursor(record['cursor']) === record['sequence'] &&
    Number.isFinite(record['emittedAtMs']) &&
    (record['workflowId'] === undefined || typeof record['workflowId'] === 'string') &&
    Object.hasOwn(record, 'payload')
  );
}
