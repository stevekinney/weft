import { z } from 'zod';
import { MAX_BATCH_OPERATIONS, MAX_SCAN_LIMIT } from '../../storage/interface.ts';

const binaryValueSchema: z.ZodType<Uint8Array, Uint8Array> = z
  .instanceof(Uint8Array)
  .meta({ type: 'string', format: 'binary' });

export const storageGetInput = z.object({ key: z.string().min(1) });

export const storagePutInput = z.object({ key: z.string().min(1), value: binaryValueSchema });

export const storageDeleteInput = z.object({ key: z.string().min(1) });

export const storageScanInput = z.object({
  prefix: z.string(),
  limit: z.number().int().positive().max(MAX_SCAN_LIMIT).optional(),
  reverse: z.boolean().optional(),
  gt: z.string().optional(),
  gte: z.string().optional(),
  lt: z.string().optional(),
  lte: z.string().optional(),
});

const storageBatchOperationInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('put'), key: z.string().min(1), value: z.string() }),
  z.object({ type: z.literal('delete'), key: z.string().min(1) }),
]);

const storageConditionInput = z.object({
  key: z.string().min(1),
  expectedValue: z.string().nullable(),
});

export const storageBatchInput = z.object({
  operations: z.array(storageBatchOperationInput).max(MAX_BATCH_OPERATIONS),
});

export const storageConditionalBatchInput = z.object({
  conditions: z.array(storageConditionInput).max(MAX_BATCH_OPERATIONS),
  operations: z.array(storageBatchOperationInput).max(MAX_BATCH_OPERATIONS),
});

export const emptyOutput = z.null();
export const storageGetOutput = binaryValueSchema.nullable();
export const storageScanOutput = z.custom<StorageScanOutput>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function',
  'Storage scan output must be an async iterable.',
);
export const storageConditionalBatchOutput = z.object({ applied: z.boolean() });

export type StorageGetInput = z.infer<typeof storageGetInput>;
export type StoragePutInput = z.infer<typeof storagePutInput>;
export type StorageDeleteInput = z.infer<typeof storageDeleteInput>;
export type StorageScanInput = z.infer<typeof storageScanInput>;
type StorageScanEntry = { readonly key: string; readonly value: string };
export type StorageScanOutput = AsyncIterable<StorageScanEntry>;
export type StorageBatchInput = z.infer<typeof storageBatchInput>;
export type StorageConditionalBatchInput = z.infer<typeof storageConditionalBatchInput>;
export type StorageConditionalBatchOutput = z.infer<typeof storageConditionalBatchOutput>;
