import type { BatchOperation } from '../../storage/interface.ts';
import {
  KEYS,
  SIGNAL_SORT_CLASS_NORMAL,
  encodeStorageKeyComponent,
  requireStorageCapability,
  storageConditionalBatch,
} from '../../storage/interface.ts';
import { decode, encode } from '../codec.ts';
import { encodePayloadWithinLimit } from '../payload-size.ts';
import type { EngineInternals } from './internals.ts';
import type { BufferedSignalDelivery } from './signals.ts';

const MAX_SIGNAL_SEQUENCE_COMMIT_ATTEMPTS = 5;
const anonymousSignalSequenceLocks = new WeakMap<object, Map<string, Promise<void>>>();

export async function commitAnonymousSignalOperations(
  internals: EngineInternals,
  workflowId: string,
  deliveries: BufferedSignalDelivery[],
  appendTerminalCleanupOperation: (operations: BatchOperation[]) => void,
  markTerminalCleanupTracked: () => void,
): Promise<void> {
  const sequenceKey = KEYS.signalSequence(workflowId);

  if (!internals.storage.capabilities().conditionalBatch) {
    await runWithAnonymousSignalSequenceLock(internals.storage, workflowId, async () => {
      const currentSequenceBytes = await internals.storage.get(sequenceKey);
      const nextSequence = await deriveNextAnonymousSignalSequence(
        internals,
        workflowId,
        currentSequenceBytes,
      );
      const operations = createAnonymousSignalOperations(
        internals,
        workflowId,
        deliveries,
        nextSequence,
        sequenceKey,
      );
      appendTerminalCleanupOperation(operations);
      await internals.storage.batch(operations);
      markTerminalCleanupTracked();
    });
    return;
  }

  requireStorageCapability(internals.storage, 'conditionalBatch', 'anonymous signal ordering');

  for (let attempt = 0; attempt < MAX_SIGNAL_SEQUENCE_COMMIT_ATTEMPTS; attempt += 1) {
    const currentSequenceBytes = await internals.storage.get(sequenceKey);
    const nextSequence = await deriveNextAnonymousSignalSequence(
      internals,
      workflowId,
      currentSequenceBytes,
    );
    const operations = createAnonymousSignalOperations(
      internals,
      workflowId,
      deliveries,
      nextSequence,
      sequenceKey,
    );
    appendTerminalCleanupOperation(operations);

    const committed = await storageConditionalBatch(
      internals.storage,
      [{ key: sequenceKey, expectedValue: currentSequenceBytes }],
      operations,
    );
    if (committed) {
      markTerminalCleanupTracked();
      return;
    }
  }

  throw new Error(
    `Could not allocate anonymous signal sequence for workflow "${workflowId}" after ${MAX_SIGNAL_SEQUENCE_COMMIT_ATTEMPTS} attempts`,
  );
}

async function runWithAnonymousSignalSequenceLock(
  storage: object,
  workflowId: string,
  operation: () => Promise<void>,
): Promise<void> {
  let storageLocks = anonymousSignalSequenceLocks.get(storage);
  if (!storageLocks) {
    storageLocks = new Map<string, Promise<void>>();
    anonymousSignalSequenceLocks.set(storage, storageLocks);
  }

  const previous = storageLocks.get(workflowId) ?? Promise.resolve();
  let releaseCurrentLock!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrentLock = resolve;
  });
  const lockChain = previous.then(
    () => current,
    () => current,
  );
  storageLocks.set(workflowId, lockChain);

  try {
    await previous.catch(() => {});
    await operation();
  } finally {
    releaseCurrentLock();
    if (storageLocks.get(workflowId) === lockChain) {
      storageLocks.delete(workflowId);
    }
  }
}

function createAnonymousSignalOperations(
  internals: EngineInternals,
  workflowId: string,
  deliveries: BufferedSignalDelivery[],
  nextSequence: number,
  sequenceKey: string,
): BatchOperation[] {
  const operations: BatchOperation[] = deliveries.map(({ signalName, payload }, index) => ({
    type: 'put',
    key: KEYS.signal(
      workflowId,
      signalName,
      generatedSignalId(nextSequence + index),
      SIGNAL_SORT_CLASS_NORMAL,
    ),
    value: encodePayloadWithinLimit(
      payload,
      internals.options.payloadSizePolicy.maxBytes,
      'signal payload',
    ),
  }));

  operations.push({
    type: 'put',
    key: sequenceKey,
    value: encode(nextSequence + deliveries.length),
  });

  return operations;
}

function generatedSignalId(sequenceValue: number): string {
  return `anonymous:${String(sequenceValue).padStart(16, '0')}:${crypto.randomUUID()}`;
}

async function deriveNextAnonymousSignalSequence(
  internals: EngineInternals,
  workflowId: string,
  currentSequenceBytes: Uint8Array | null,
): Promise<number> {
  if (currentSequenceBytes !== null) {
    return decodeSignalSequence(currentSequenceBytes);
  }

  return scanNextAnonymousSignalSequence(internals, workflowId);
}

async function scanNextAnonymousSignalSequence(
  internals: EngineInternals,
  workflowId: string,
): Promise<number> {
  const prefix = `sig:${encodeStorageKeyComponent(workflowId)}:`;
  let nextSequence = 0;

  for await (const [key] of internals.storage.scan(prefix)) {
    const sequence = extractAnonymousSignalSequence(key);
    if (sequence !== null && sequence >= nextSequence) {
      nextSequence = sequence + 1;
    }
  }

  return nextSequence;
}

function extractAnonymousSignalSequence(key: string): number | null {
  const marker = ':anonymous%3A';
  const markerIndex = key.lastIndexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  const sequenceStart = markerIndex + marker.length;
  const sequenceEnd = key.indexOf('%3A', sequenceStart);
  if (sequenceEnd === -1) {
    return null;
  }

  const sequence = Number(key.slice(sequenceStart, sequenceEnd));
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}

function decodeSignalSequence(bytes: Uint8Array | null): number {
  if (bytes === null) {
    return 0;
  }

  const value = decode(bytes);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Stored anonymous signal sequence must be a non-negative safe integer');
  }

  return value;
}
