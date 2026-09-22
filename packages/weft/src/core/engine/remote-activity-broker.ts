/**
 * The default {@link RemoteActivityBroker} (COR-152): writes a remote
 * activity's `queued` task-ledger record directly onto the engine's own
 * `Storage`, then fires a low-latency, best-effort `RemoteActivityQueuedEvent`
 * hint. See `core/remote-activity-broker.ts` for the interface and the
 * ownership rules this implementation upholds.
 *
 * @module core/engine/remote-activity-broker
 */

import type { Storage } from '../../storage/interface.ts';
import { isJSONValue } from '../json.ts';
import type { RemoteActivityBroker, RemoteActivityTaskRequest } from '../remote-activity-broker.ts';
import { commitTaskLedgerTransition } from '../task-ledger/task-ledger-runtime.ts';
import { createQueued, type CreateQueuedInput } from '../task-ledger/task-ledger-transitions.ts';
import {
  decodeRemoteTaskRecord,
  REMOTE_TASK_RECORD_VERSION,
  taskLedgerKey,
} from '../task-ledger/task-ledger.ts';
import type { RetryPolicy } from '../types.ts';

/** Default visibility timeout for a remote-dispatched task when neither the
 * per-call activity `timeout` nor the engine's `activityExecution` default
 * supplies one. Matches `task-dispatch.ts`'s own `DEFAULT_VISIBILITY_TIMEOUT`. */
const DEFAULT_VISIBILITY_TIMEOUT_MS = 30_000;

/** Engine-construction-level defaults from `activityExecution: { mode: 'remote' }`. */
export type RemoteActivityBrokerDefaults = Readonly<{
  queue?: string;
  visibilityTimeoutMilliseconds?: number;
  retryPolicy?: RetryPolicy;
}>;

function qualifyActivityName(workflowType: string, activityName: string): string {
  return `${workflowType}.${activityName}`;
}

/**
 * The default `RemoteActivityBroker`, bound to the engine's own storage.
 * Writes the task's `queued` ledger record directly — the same durable shape
 * `TaskDispatch` produces through `server/runtime/task-dispatch.ts`, so a
 * `serve()`d server's reconciliation scan and startup recovery treat it
 * identically to a task dispatched through `WeftServer.dispatchTask`.
 *
 * `defaults` are the engine-construction-level `queue`/
 * `visibilityTimeoutMilliseconds`/`retryPolicy` from `ActivityExecutionOptions`
 * (`mode: 'remote'`), applied whenever a call omits its own value. A caller
 * substituting a custom `RemoteActivityBroker` test double does not get these
 * for free — the double fully replaces this enqueue mechanism and is
 * responsible for its own defaulting, same as `ActivityWorkerDispatcher`'s
 * caller owns its own pool configuration.
 *
 * `onEnqueued` is an optional low-latency hint fired only after a genuinely
 * FRESH ledger write (never for an idempotent replay hitting an
 * already-`queued` record) — see `RemoteActivityQueuedEvent`.
 */
export class EngineOwnedRemoteActivityBroker implements RemoteActivityBroker {
  /**
   * The task-ledger `Storage` this broker writes `queued` records to.
   *
   * Named for its role rather than `#storage` on purpose. This class lives
   * under `core/engine/` but is NOT the engine: it is a collaborator holding
   * a constructor-injected dependency, so the rule
   * `scripts/check-engine-internals-field-access.ts` enforces — engine state
   * belongs on `EngineInternals`, reached through `getInternals(this)`, never
   * on a `#private` field — does not describe this field. `getInternals(this)`
   * is not even available here; `this` is a broker, not an `Engine`. A field
   * literally called `#storage` collided with `EngineInternals.storage` and
   * made a dependency injection look like the violation the check exists to
   * catch, so the name now says which storage and whose it is.
   */
  readonly #ledgerStorage: Storage;
  readonly #defaults: RemoteActivityBrokerDefaults;
  readonly #onEnqueued: (operationId: string, workflowId: string, queue: string) => void;

  constructor(
    storage: Storage,
    defaults: RemoteActivityBrokerDefaults,
    onEnqueued: (operationId: string, workflowId: string, queue: string) => void,
  ) {
    this.#ledgerStorage = storage;
    this.#defaults = defaults;
    this.#onEnqueued = onEnqueued;
  }

  async enqueue(request: RemoteActivityTaskRequest): Promise<void> {
    const key = taskLedgerKey(request.operationId);

    // Idempotent replay guard: a workflow re-executing `ctx.run()` after a
    // crash/recovery derives the SAME deterministic token
    // (`deriveAsyncActivityToken`) and calls `enqueue` again. The first
    // dispatch's ledger record is the truth; skip the write entirely rather
    // than letting `createQueued`'s absent-key precondition reject it.
    const existing = decodeRemoteTaskRecord(await this.#ledgerStorage.get(key));
    if (existing !== null) return;

    // Matches `buildCreateQueuedInput`'s (`task-dispatch-envelope.ts`) own
    // normalization: a zero-argument activity call carries `input:
    // undefined`, which is not itself a `JSONValue` even though it is a
    // perfectly ordinary call — `null` is the durable envelope's equivalent.
    const input = request.input === undefined ? null : request.input;
    if (!isJSONValue(input)) {
      throw new Error(
        `Remote activity "${request.activityName}" for operation "${request.operationId}" has ` +
          'a non-JSON-serializable input — remote dispatch requires JSON-safe input.',
      );
    }

    const queue = request.queue ?? this.#defaults.queue ?? 'default';
    const retryPolicy = request.retryPolicy ?? this.#defaults.retryPolicy;
    const createInput: CreateQueuedInput = {
      recordVersion: REMOTE_TASK_RECORD_VERSION,
      operationId: request.operationId,
      workflowId: request.workflowId,
      workflowType: request.workflowType,
      activityName: qualifyActivityName(request.workflowType, request.activityName),
      queue,
      input,
      headers: request.headers,
      visibilityTimeoutMilliseconds:
        request.visibilityTimeoutMilliseconds ??
        this.#defaults.visibilityTimeoutMilliseconds ??
        DEFAULT_VISIBILITY_TIMEOUT_MS,
      createdAt: Date.now(),
      ...(request.workflowExecutionToken !== undefined
        ? { workflowExecutionToken: request.workflowExecutionToken }
        : {}),
      ...(request.workflowRevision !== undefined
        ? { workflowRevision: request.workflowRevision }
        : {}),
      ...(retryPolicy !== undefined ? { retryPolicy } : {}),
      ...(request.scheduleToCloseDeadline !== undefined
        ? { scheduleToCloseDeadline: request.scheduleToCloseDeadline }
        : {}),
    };

    const result = await commitTaskLedgerTransition(
      this.#ledgerStorage,
      request.operationId,
      (current, now) => createQueued(current, createInput, now),
    );

    if (!result.ok) {
      // Lost a create race to a concurrent writer for this exact operationId
      // (another process, or a duplicate concurrent replay) — the record now
      // exists durably either way; treat it the same as the idempotent-replay
      // guard above rather than failing the activity attempt.
      const raced = decodeRemoteTaskRecord(await this.#ledgerStorage.get(key));
      if (raced !== null) return;
      throw new Error(
        `Failed to durably enqueue remote activity task "${request.operationId}": ${result.reason}`,
      );
    }

    this.#onEnqueued(request.operationId, request.workflowId, queue);
  }
}
