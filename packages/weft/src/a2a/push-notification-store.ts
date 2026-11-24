/**
 * `createWeftPushNotificationStore`: the A2A SDK's `PushNotificationStore` over any
 * Weft storage adapter with conditional batches, scoped the same way the task store
 * is, with an idempotent create, a paginated list, and secret-free tombstones.
 *
 * Every mutation of one task's configurations (create and delete) commits together
 * with a bump of that task's head record, conditioned on the head it read, so two
 * concurrent creates of the same webhook cannot both store a configuration. The head's
 * sequence is also the deletion fence a tombstone records.
 *
 * @module a2a/push-notification-store
 */

import {
  type AuthenticationInfo,
  type ListTaskPushNotificationConfigsResponse,
  TaskPushNotificationConfig,
} from '@a2a-js/sdk';
import type {
  PushNotificationStore,
  ServerCallContext,
  StoredPushNotificationConfig,
} from '@a2a-js/sdk/server';

import { requireStorageCapability, type Storage } from "../embedded/storage/src/index.ts";
import { A2APushConfigurationConflictError } from './store-errors.ts';
import {
  type A2ACallerScope,
  type A2ACompareAndSwapAttempt,
  type A2APageCursor,
  callerScope,
  compareIdentifiers,
  decodeRecord,
  encodeRecord,
  pageTokenBinding,
  paginate,
  resolvePageSize,
  scanRecords,
  scopedKey,
  withCompareAndSwap,
} from './store-support.ts';

/** Options for {@link createWeftPushNotificationStore}. */
export type WeftPushNotificationStoreOptions = {
  /**
   * A Weft storage adapter that reports `conditionalBatch`, `linearizable`
   * read-after-write, and `snapshot` scans.
   */
  readonly storage: Storage;
  /** Separates one published agent's configurations from another's in shared storage. */
  readonly namespace: string;
  /** The clock, in epoch milliseconds, that stamps each configuration's creation. */
  readonly now?: () => number;
};

/** A page request for {@link WeftPushNotificationStore.list}. */
export type WeftPushNotificationListRequest = {
  readonly taskId: string;
  /** 1–100. Absent or `0` (the protobuf default for an unset field) means 50. */
  readonly pageSize?: number | undefined;
  /** A `nextPageToken` from an earlier page of the same task for the same caller. */
  readonly pageToken?: string | undefined;
};

/**
 * The SDK's `PushNotificationStore`, plus `create`, `get`, and a paginated `list`.
 * Every method returns credentials unredacted, because the sender needs them; wrap the
 * request handler with `withRedactedPushConfigurations` before serving reads.
 */
export interface WeftPushNotificationStore extends PushNotificationStore {
  /**
   * Store a configuration, or return the existing one it repeats: a create naming an
   * existing `id` with the same webhook URL, `token`, and authentication, or naming no
   * `id` with the same URL, `token`, and authentication as a live configuration of the
   * task. Authentication scheme names compare case-insensitively.
   *
   * @throws {A2APushConfigurationConflictError} When the `id` names a configuration
   *   with a different URL, `token`, or authentication, or a deleted configuration.
   */
  create(
    taskId: string,
    context: ServerCallContext,
    pushNotificationConfig: TaskPushNotificationConfig,
  ): Promise<TaskPushNotificationConfig>;
  /**
   * Refuse, without writing, a create that {@link WeftPushNotificationStore.create}
   * would refuse: the same checks against the task's stored configurations, so a
   * caller can decline before it takes an effect that a later create could not undo.
   * Resolves the live configuration a create would return unchanged, or `undefined` when it
   * would store a new one.
   *
   * @throws {A2APushConfigurationConflictError} As `create` does.
   */
  check(
    taskId: string,
    context: ServerCallContext,
    pushNotificationConfig: TaskPushNotificationConfig,
  ): Promise<TaskPushNotificationConfig | undefined>;
  /** One live configuration, or `undefined` for a missing or deleted one. */
  get(
    taskId: string,
    configId: string,
    context: ServerCallContext,
  ): Promise<TaskPushNotificationConfig | undefined>;
  /**
   * One page of a task's live configurations, ordered by creation time, then
   * identifier. The page token is bound to the caller and the task.
   */
  list(
    params: WeftPushNotificationListRequest,
    context: ServerCallContext,
  ): Promise<ListTaskPushNotificationConfigsResponse>;
  loadWithMetadata(
    taskId: string,
    context: ServerCallContext,
  ): Promise<StoredPushNotificationConfig[]>;
}

type LiveConfiguration = A2APageCursor & {
  readonly kind: 'live';
  readonly config: TaskPushNotificationConfig;
  readonly wireVersion: string;
};

type StoredConfiguration = LiveConfiguration | { readonly kind: 'deleted'; readonly id: string };

function readConfiguration(record: Record<string, unknown>): StoredConfiguration {
  if (record['state'] === 'deleted') return { kind: 'deleted', id: String(record['id']) };
  const config = TaskPushNotificationConfig.fromJSON(record['config']);
  return {
    kind: 'live',
    config,
    id: config.id,
    sortKey: Number(record['createdAt']),
    wireVersion: String(record['wireVersion']),
  };
}

function sameAuthentication(
  left: AuthenticationInfo | undefined,
  right: AuthenticationInfo | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.scheme.toLowerCase() === right.scheme.toLowerCase() &&
    left.credentials === right.credentials
  );
}

function sameWebhook(left: TaskPushNotificationConfig, right: TaskPushNotificationConfig): boolean {
  return (
    left.url === right.url &&
    left.token === right.token &&
    sameAuthentication(left.authentication, right.authentication)
  );
}

/** Creation time, then identifier. */
function compareCreationOrder(left: A2APageCursor, right: A2APageCursor): number {
  const leftKey = left.sortKey ?? 0;
  const rightKey = right.sortKey ?? 0;
  if (leftKey !== rightKey) return leftKey - rightKey;
  return compareIdentifiers(left.id, right.id);
}

/**
 * Decide what a create does against the task's stored configurations: return an
 * existing configuration it repeats, or name the identifier to store it under.
 */
function resolveCreate(
  taskId: string,
  stored: readonly StoredConfiguration[],
  input: TaskPushNotificationConfig,
): { readonly existing: TaskPushNotificationConfig } | { readonly id: string } {
  if (input.id) {
    const sameId = stored.find((entry) => entry.id === input.id);
    if (sameId === undefined) return { id: input.id };
    if (sameId.kind === 'deleted') {
      throw new A2APushConfigurationConflictError(taskId, input.id, 'deleted');
    }
    if (!sameWebhook(sameId.config, input)) {
      throw new A2APushConfigurationConflictError(taskId, input.id, 'different');
    }
    return { existing: sameId.config };
  }
  const match = stored.find((entry) => entry.kind === 'live' && sameWebhook(entry.config, input));
  return match?.kind === 'live' ? { existing: match.config } : { id: crypto.randomUUID() };
}

/**
 * Refuse storage whose reads or scans can lag a commit. A create decides whether a
 * webhook is new by scanning the task's configurations, and the compare-and-swap
 * fences only the head record it read: a current head read beside a stale scan that
 * omits a configuration or tombstone would commit a duplicate webhook or reuse a
 * deleted identifier.
 */
function requirePushStorage(storage: Storage): void {
  requireStorageCapability(storage, 'conditionalBatch', 'A2A push notification store');
  const { readAfterWrite, scanConsistency } = storage.capabilities();
  if (readAfterWrite !== 'linearizable' || scanConsistency !== 'snapshot') {
    throw new Error(
      `The A2A push notification store requires storage with linearizable read-after-write and snapshot scans, but this storage backend reports "${readAfterWrite}" reads and "${scanConsistency}" scans.`,
    );
  }
}

async function readHead(
  storage: Storage,
  headKey: string,
): Promise<{ bytes: Uint8Array | null; sequence: number }> {
  const bytes = await storage.get(headKey);
  return {
    bytes,
    sequence: bytes === null ? 0 : Number(decodeRecord(headKey, bytes)['sequence']),
  };
}

async function readTaskConfigurations(
  storage: Storage,
  scope: A2ACallerScope,
  taskId: string,
): Promise<StoredConfiguration[]> {
  const records = await scanRecords(storage, `${scopedKey('push', scope, taskId)}:`);
  return records.map(({ record }) => readConfiguration(record));
}

/**
 * Plans one create of a push configuration with the storage, namespace, and clock of
 * the store it belongs to. See {@link planPushConfigurationCreate}.
 */
export type PushConfigurationCreatePlanner = (
  taskId: string,
  context: ServerCallContext,
  input: TaskPushNotificationConfig,
) => Promise<A2ACompareAndSwapAttempt<TaskPushNotificationConfig>>;

/** The planner of each store {@link createWeftPushNotificationStore} made, and of each store that delegates to one. */
const createPlanners = new WeakMap<PushNotificationStore, PushConfigurationCreatePlanner>();

/**
 * The create planner of a store {@link createWeftPushNotificationStore} made, or of a
 * store {@link delegatePushConfigurationCreates} registered as delegating to one, so a
 * caller that folds a create into its own batch stamps the configuration with the
 * store's clock, as the store's own `create` does. `undefined` for any other store.
 */
export function pushConfigurationCreatePlannerOf(
  store: PushNotificationStore,
): PushConfigurationCreatePlanner | undefined {
  return createPlanners.get(store);
}

/** Give `wrapper`, which forwards its creates to `store`, the create planner of `store`. */
export function delegatePushConfigurationCreates(
  wrapper: PushNotificationStore,
  store: PushNotificationStore,
): void {
  const planner = createPlanners.get(store);
  if (planner !== undefined) createPlanners.set(wrapper, planner);
}

/**
 * Plan one create of a push configuration: the existing configuration it repeats, or
 * the conditional batch that stores it, conditioned on the task's push head and
 * bumping it. {@link createWeftPushNotificationStore}'s `create` commits the batch on
 * its own; a workflow agent folds it into the batch that creates the task, so a task
 * and the inline configuration of its first message are stored together or not at
 * all. Both write the same records under the same keys.
 *
 * @throws {A2APushConfigurationConflictError} As
 *   {@link WeftPushNotificationStore.create} does.
 */
export async function planPushConfigurationCreate(
  options: { readonly storage: Storage; readonly namespace: string; readonly now: () => number },
  taskId: string,
  context: ServerCallContext,
  input: TaskPushNotificationConfig,
): Promise<A2ACompareAndSwapAttempt<TaskPushNotificationConfig>> {
  const { storage, namespace, now } = options;
  const scope = callerScope(namespace, context);
  const headKey = scopedKey('push-head', scope, taskId);
  const head = await readHead(storage, headKey);
  const resolution = resolveCreate(
    taskId,
    await readTaskConfigurations(storage, scope, taskId),
    input,
  );
  if ('existing' in resolution) return { result: resolution.existing };
  const config: TaskPushNotificationConfig = {
    ...structuredClone(input),
    id: resolution.id,
    taskId,
  };
  const record = encodeRecord({
    state: 'live',
    config: TaskPushNotificationConfig.toJSON(config),
    createdAt: now(),
    wireVersion: context.requestedVersion,
  });
  return {
    conditions: [{ key: headKey, expectedValue: head.bytes }],
    operations: [
      { type: 'put', key: scopedKey('push', scope, taskId, config.id), value: record },
      { type: 'put', key: headKey, value: encodeRecord({ sequence: head.sequence + 1 }) },
    ],
    result: config,
  };
}

/**
 * Create an A2A `PushNotificationStore` over a Weft storage adapter, scoped by
 * `ServerCallContext.tenant`, the caller's `user`, and `namespace` exactly as
 * {@link createWeftA2ATaskStore} scopes tasks.
 *
 * Deleting a configuration replaces it with a tombstone holding only its identifier
 * and deletion fence, so its credentials leave storage and its `id` is never reused.
 *
 * @throws {Error} When `storage` does not report `conditionalBatch`, `linearizable`
 *   read-after-write, and `snapshot` scans.
 */
export function createWeftPushNotificationStore(
  options: WeftPushNotificationStoreOptions,
): WeftPushNotificationStore {
  const { storage, namespace } = options;
  requirePushStorage(storage);
  const now = options.now ?? Date.now;

  async function liveConfigurations(
    taskId: string,
    context: ServerCallContext,
  ): Promise<LiveConfiguration[]> {
    const stored = await readTaskConfigurations(storage, callerScope(namespace, context), taskId);
    return stored
      .filter((entry): entry is LiveConfiguration => entry.kind === 'live')
      .toSorted(compareCreationOrder);
  }

  async function create(
    taskId: string,
    context: ServerCallContext,
    input: TaskPushNotificationConfig,
  ): Promise<TaskPushNotificationConfig> {
    const headKey = scopedKey('push-head', callerScope(namespace, context), taskId);
    return withCompareAndSwap(storage, headKey, () =>
      planPushConfigurationCreate({ storage, namespace, now }, taskId, context, input),
    );
  }

  const store: WeftPushNotificationStore = {
    create,

    async check(taskId, context, input) {
      const resolution = resolveCreate(
        taskId,
        await readTaskConfigurations(storage, callerScope(namespace, context), taskId),
        input,
      );
      return 'existing' in resolution ? resolution.existing : undefined;
    },

    async save(taskId, context, pushNotificationConfig): Promise<void> {
      const stored = await create(taskId, context, pushNotificationConfig);
      // The SDK reads the assigned identifier back from the object it passed in.
      pushNotificationConfig.id = stored.id;
    },

    async get(taskId, configId, context) {
      const key = scopedKey('push', callerScope(namespace, context), taskId, configId);
      const bytes = await storage.get(key);
      const stored = bytes === null ? undefined : readConfiguration(decodeRecord(key, bytes));
      return stored?.kind === 'live' ? stored.config : undefined;
    },

    async load(taskId, context) {
      const live = await liveConfigurations(taskId, context);
      return live.map((entry) => entry.config);
    },

    async loadWithMetadata(taskId, context) {
      const live = await liveConfigurations(taskId, context);
      return live.map((entry) => ({
        config: entry.config,
        wireVersion: entry.wireVersion,
      }));
    },

    async list(params, context) {
      const pageSize = resolvePageSize(params.pageSize === 0 ? undefined : params.pageSize);
      const scope = callerScope(namespace, context);
      const { page, nextPageToken } = paginate(await liveConfigurations(params.taskId, context), {
        pageSize,
        pageToken: params.pageToken ?? '',
        binding: pageTokenBinding([
          'push',
          scope.namespace,
          scope.tenant,
          scope.owner,
          params.taskId,
        ]),
        compare: compareCreationOrder,
      });
      return { configs: page.map((entry) => entry.config), nextPageToken };
    },

    async delete(taskId, context, configId = taskId): Promise<void> {
      const scope = callerScope(namespace, context);
      const headKey = scopedKey('push-head', scope, taskId);
      const key = scopedKey('push', scope, taskId, configId);
      await withCompareAndSwap(storage, headKey, async () => {
        const head = await readHead(storage, headKey);
        const bytes = await storage.get(key);
        const stored = bytes === null ? undefined : readConfiguration(decodeRecord(key, bytes));
        if (stored?.kind !== 'live') return { result: undefined };
        const deletionFence = head.sequence + 1;
        return {
          conditions: [{ key: headKey, expectedValue: head.bytes }],
          operations: [
            {
              type: 'put',
              key,
              value: encodeRecord({ state: 'deleted', id: configId, deletionFence }),
            },
            { type: 'put', key: headKey, value: encodeRecord({ sequence: deletionFence }) },
          ],
          result: undefined,
        };
      });
    },
  };
  createPlanners.set(store, (taskId, context, input) =>
    planPushConfigurationCreate({ storage, namespace, now }, taskId, context, input),
  );
  return store;
}
