/**
 * Shared fixtures for the A2A store tests: the three storage adapters every store test
 * runs on, call contexts for a given user and tenant, task and push-configuration
 * builders, and a storage decorator that can interpose on a conditional batch.
 */

import { afterEach } from 'bun:test';

import {
  type Artifact,
  type Message,
  Role,
  type Task,
  type TaskPushNotificationConfig,
  TaskState,
} from '@a2a-js/sdk';
import { ServerCallContext, type User } from '@a2a-js/sdk/server';

import {
  type BatchOperation,
  type ConditionalBatchCondition,
  type Storage,
  storageConditionalBatch,
} from "../embedded/storage/src/index.ts";
import {
  type StorageBackendDescriptor,
  storageBackends,
} from '../testing/storage-backends.test-support.ts';

const STORE_ADAPTERS = ['MemoryStorage', 'BunSQLiteStorage'];

/**
 * Weft's memory and Bun SQLite adapters: every A2A store test runs on each. IndexedDB is left out
 * because the stores require snapshot scans, which it does not offer.
 */
export const a2aStoreBackends: readonly StorageBackendDescriptor[] = storageBackends.filter(
  (backend) => STORE_ADAPTERS.includes(backend.name),
);

/**
 * Register cleanup for the storage a test opens and return a function that opens a
 * fresh storage on `backend`.
 */
export function useBackendStorage(backend: StorageBackendDescriptor): () => Storage {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });
  return () => {
    const { storage, cleanup } = backend.factory();
    cleanups.push(cleanup);
    return storage;
  };
}

class NamedUser implements User {
  readonly #name: string;

  constructor(name: string) {
    this.#name = name;
  }

  get isAuthenticated(): boolean {
    return true;
  }

  get userName(): string {
    return this.#name;
  }
}

/**
 * A call context for an authenticated `user` (anonymous when omitted), `tenant`, and
 * A2A wire version (1.0 unless told otherwise).
 */
export function callContext(
  options: { user?: string; tenant?: string; requestedVersion?: string } = {},
): ServerCallContext {
  return new ServerCallContext({
    ...(options.user === undefined ? {} : { user: new NamedUser(options.user) }),
    ...(options.tenant === undefined ? {} : { tenant: options.tenant }),
    requestedVersion: options.requestedVersion ?? '1.0',
  });
}

export function messageFixture(messageId: string): Message {
  return {
    messageId,
    contextId: '',
    taskId: '',
    role: Role.ROLE_USER,
    parts: [
      {
        content: { $case: 'text', value: messageId },
        metadata: undefined,
        filename: '',
        mediaType: 'text/plain',
      },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

export function artifactFixture(artifactId: string): Artifact {
  return {
    artifactId,
    name: artifactId,
    description: '',
    parts: [
      {
        content: { $case: 'text', value: artifactId },
        metadata: undefined,
        filename: '',
        mediaType: 'text/plain',
      },
    ],
    metadata: undefined,
    extensions: [],
  };
}

/** A task with the given identifier, context, state, and status timestamp. */
export function taskFixture(
  id: string,
  options: {
    contextId?: string;
    state?: TaskState;
    timestamp?: string;
    history?: Message[];
    artifacts?: Artifact[];
  } = {},
): Task {
  return {
    id,
    contextId: options.contextId ?? 'context-1',
    status: {
      state: options.state ?? TaskState.TASK_STATE_WORKING,
      message: undefined,
      timestamp: options.timestamp ?? '2026-10-17T12:00:00.000Z',
    },
    artifacts: options.artifacts ?? [],
    history: options.history ?? [],
    metadata: undefined,
  };
}

/** A push configuration for `taskId`, with Bearer authentication unless told otherwise. */
export function pushConfigFixture(
  taskId: string,
  options: Partial<
    Pick<TaskPushNotificationConfig, 'id' | 'url' | 'token' | 'authentication'>
  > = {},
): TaskPushNotificationConfig {
  return {
    tenant: '',
    id: options.id ?? '',
    taskId,
    url: options.url ?? 'https://hooks.example.com/a2a',
    token: options.token ?? 'token-1',
    authentication:
      'authentication' in options
        ? options.authentication
        : { scheme: 'Bearer', credentials: 'secret-credential' },
  };
}

/** Every raw value stored under `prefix`, decoded as text. */
export async function storedText(storage: Storage, prefix = 'a2a:'): Promise<string[]> {
  const values: string[] = [];
  for await (const [, value] of storage.scan(prefix)) values.push(new TextDecoder().decode(value));
  return values;
}

/** Overwrite the record at `key` with an arbitrary JSON value. */
export async function overwriteRecord(
  storage: Storage,
  key: string,
  value: unknown,
): Promise<void> {
  await storage.put(key, new TextEncoder().encode(JSON.stringify(value)));
}

/** Every key stored under `prefix`, in key order. */
export async function storedKeys(storage: Storage, prefix = 'a2a:'): Promise<string[]> {
  const keys: string[] = [];
  for await (const [key] of storage.scan(prefix)) keys.push(key);
  return keys;
}

/**
 * Runs before a conditional batch reaches the wrapped storage. Returning `false`
 * fails the batch without applying it; anything else lets it through.
 */
export type ConditionalBatchInterposer = (
  conditions: ConditionalBatchCondition[],
  operations: BatchOperation[],
) => Promise<boolean | undefined> | boolean | undefined;

/**
 * A storage that delegates to `storage` and records every conditional batch's outcome,
 * letting `interpose` act before each one.
 */
export function interposedStorage(
  storage: Storage,
  interpose: ConditionalBatchInterposer,
): { storage: Storage; outcomes: boolean[] } {
  const outcomes: boolean[] = [];
  async function conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    const verdict = await interpose(conditions, operations);
    const committed =
      verdict === false ? false : await storageConditionalBatch(storage, conditions, operations);
    outcomes.push(committed);
    return committed;
  }
  const wrapped = new Proxy(storage, {
    get(target, property) {
      if (property === 'conditionalBatch') return conditionalBatch;
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { storage: wrapped, outcomes };
}
