import {
  storageValuesEqual,
  type BatchOperation,
  type ConditionalBatchCondition,
} from './interface.ts';

export interface ConditionalBatchBodyHandlers {
  read(key: string): Uint8Array | null;
  put(key: string, value: Uint8Array): void;
  delete(key: string): void;
}

export function runConditionalBatchBody(
  conditions: ConditionalBatchCondition[],
  operations: BatchOperation[],
  handlers: ConditionalBatchBodyHandlers,
): boolean {
  for (const condition of conditions) {
    if (!storageValuesEqual(handlers.read(condition.key), condition.expectedValue)) {
      return false;
    }
  }

  for (const operation of operations) {
    if (operation.type === 'put') {
      handlers.put(operation.key, operation.value);
    } else {
      handlers.delete(operation.key);
    }
  }

  return true;
}
