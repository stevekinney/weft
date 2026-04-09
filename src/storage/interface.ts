/** A single KV operation in a batch. */
export type BatchOperation =
  | { type: 'put'; key: string; value: Uint8Array }
  | { type: 'delete'; key: string };

/** Options for range scans. */
export interface ScanOptions {
  limit?: number;
  reverse?: boolean;
  gt?: string;
  lt?: string;
  gte?: string;
  lte?: string;
}

/** KV-oriented storage interface. All storage adapters implement this. */
export interface Storage extends Disposable {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]>;
  batch(operations: BatchOperation[]): Promise<void>;

  /** Optional SQL passthrough for dashboard/debugging (SQLite only). */
  query?<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * Key layout constants for hierarchical key encoding.
 * All timestamps are zero-padded to 16 digits for correct lexicographic ordering.
 */
export const KEYS = {
  workflow: (id: string) => `wf:${id}`,
  checkpoint: (id: string) => `wf:${id}:ckpt`,
  checkpointHistory: (id: string, step: number) =>
    `wf:${id}:ckpt:${String(step).padStart(10, '0')}`,
  operation: (queue: string, scheduledAt: number, id: string) =>
    `op:${queue}:${String(scheduledAt).padStart(16, '0')}:${id}`,
  operationInflight: (id: string) => `op:inflight:${id}`,
  operationQueued: (id: string) => `op:queued:${id}`,
  operationResolved: (id: string) => `op:resolved:${id}`,
  event: (workflowId: string, sequence: number) =>
    `ev:${workflowId}:${String(sequence).padStart(10, '0')}`,
  eventHead: (workflowId: string) => `ev:${workflowId}:head`,
  signal: (workflowId: string, name: string, id: string) => `sig:${workflowId}:${name}:${id}`,
  deadline: (deadline: number, workflowId: string) =>
    `wf-deadline:${String(deadline).padStart(16, '0')}:${workflowId}`,
  attribute: (workflowId: string) => `attr:${workflowId}`,
  attributeIndex: (attributeName: string, encodedValue: string, workflowId: string) =>
    `idx:${attributeName}:${encodedValue}:${workflowId}`,
  update: (workflowId: string, updateId: string) => `upd:${workflowId}:${updateId}`,
  updateResponse: (updateId: string) => `upr:${updateId}`,
  updateIdempotency: (workflowId: string, key: string) => `upk:${workflowId}:${key}`,
  budget: (namespace: string, period: string, date: string) =>
    `budget:${namespace}:${period}:${date}`,
  review: (workflowId: string, reviewId: string) => `review:${workflowId}:${reviewId}`,
  offload: (workflowId: string, key: string) => `offload:${workflowId}:${key}`,
  archive: (workflowId: string, key: string) => `archive:${workflowId}:${key}`,
  sharedState: (workflowId: string, stateKey: string) => `shared:${workflowId}:${stateKey}`,
  sharedStateVersion: (workflowId: string, stateKey: string) =>
    `shared:${workflowId}:${stateKey}:version`,
  streamChunk: (workflowId: string, key: string, chunkIndex: number) =>
    `blob:${workflowId}:${key}:chunk:${String(chunkIndex).padStart(10, '0')}`,
  streamMetadata: (workflowId: string, key: string) => `blob:${workflowId}:${key}:meta`,
  budgetCharged: (operationId: string) => `budget-charged:${operationId}`,
  toolEffect: (workflowId: string, agentId: string, semanticHash: string) =>
    `tool-effect:${workflowId}:${agentId}:${semanticHash}`,
} as const;
