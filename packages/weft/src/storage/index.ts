export type { JSONValue } from '../core/json.ts';
export { storageDeleteRange } from './delete-range.ts';
export type { DeleteRangeOptions } from './delete-range.ts';
export {
  KEYS,
  MAX_BATCH_OPERATIONS,
  MAX_SCAN_LIMIT,
  StorageBatchOperationLimitExceededError,
  WEFT_RESERVED_KEY_PREFIXES,
  assertDurableStorageForRecovery,
  assertStorageBatchOperationCount,
  requireStorageCapability,
  storageBatch,
  storageConditionalBatch,
  storageValuesEqual,
} from './interface.ts';
export type {
  BatchOperation,
  ConditionalBatchCondition,
  GatedStorageCapabilityKey,
  ScanOptions,
  Storage,
  StorageBatchOperationLimitTarget,
  StorageCapabilities,
} from './interface.ts';
export { MemoryStorage } from './memory.ts';
export { resolveStorage } from './resolve.ts';
export type { StorageConfiguration } from './resolve.ts';
export { ScopedStorage, scopedStorage } from './scoped-storage.ts';
export { copyTextKeyValueRowsToStorage } from './text-value-import.ts';
export type {
  CopyTextKeyValueRowsToStorageOptions,
  CopyTextKeyValueRowsToStorageResult,
  TextKeyValueRow,
} from './text-value-import.ts';
export { textValueStore } from './text-value-store.ts';
export type {
  TextValueStore,
  TextValueStoreBatchOperation,
  TextValueStoreCondition,
  TextValueStoreOptions,
} from './text-value-store.ts';
export { jsonCodec, msgpackCodec, withCodec } from './typed-storage.ts';
export type {
  CodecStorageOptions,
  MessagePackValue,
  StorageCodec,
  StorageValueParser,
  TypedBatchOperation,
  TypedConditionalBatchCondition,
  TypedStorage,
} from './typed-storage.ts';
