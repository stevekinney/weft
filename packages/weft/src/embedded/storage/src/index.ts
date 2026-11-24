/**
 * The key-value storage protocol Weft and its adapters share: the `Storage` interface and its
 * derived operations, the capability model, the in-memory and scoped stores, the text-value view,
 * and the key and byte encodings adapters persist.
 *
 * @module storage
 */
export * from './byte-encoding.ts';
export * from './capabilities.ts';
export * from './delete-range.ts';
export * from './derived-operations.ts';
export * from './entry-metadata.ts';
export * from './interface.ts';
export * from './key-encoding.ts';
export * from './memory.ts';
export * from './scoped-storage.ts';
export * from './text-value-import.ts';
export * from './text-value-store.ts';
