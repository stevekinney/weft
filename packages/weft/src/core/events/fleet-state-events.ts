import type { RegisterErrorMessage } from '../../worker/protocol.ts';
import type { RealmLifecycleState } from '../realm/realm-lifecycle.ts';

/**
 * Maximum length, in UTF-16 code units, of a worker identifier carried on a
 * {@link WorkerRegistrationRejectedEvent}. A registration is refused before its
 * `workerId` has been validated, so the identifier is attacker-supplied; the
 * event carries a bounded prefix so an oversized value cannot be persisted into
 * the fleet feed.
 */
export const MAX_REJECTED_WORKER_ID_LENGTH = 128;

/**
 * Fired on the {@link Engine} for every revision realm lifecycle transition
 * (`warming`, `ready`, `active`, `draining`, `terminated`, `crashed`). It is not
 * fired for a realm's initial `warming` state at construction, because
 * construction is not a transition; a later bounded restart from `crashed` back
 * to `warming` is one, and carries the incremented `restartCount`. `realmId` is
 * minted once per realm by its revision pool and is unique for the life of the
 * process; `revision` is the immutable workflow revision the realm serves.
 * Engine-scoped: it never names a workflow.
 *
 * @example
 * ```ts
 * import { Engine, RealmStateChangedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(RealmStateChangedEvent.type, (event) => {
 *   console.log(event.realmId, event.revision, event.state, event.restartCount);
 * });
 * ```
 */
export class RealmStateChangedEvent extends Event {
  static readonly type = 'realm:state-changed' as const;
  readonly realmId: string;
  readonly revision: string;
  readonly state: RealmLifecycleState;
  readonly restartCount: number;

  constructor(realmId: string, revision: string, state: RealmLifecycleState, restartCount: number) {
    super(RealmStateChangedEvent.type);
    this.realmId = realmId;
    this.revision = revision;
    this.state = state;
    this.restartCount = restartCount;
  }
}

/**
 * The `status` values of {@link Engine.getLeaseHealth}: `disabled` (ownership
 * mode `none`), `no-lease` (not held yet, or the engine stopped), `healthy`, and
 * `contested` (expired, unconfirmable, or deposed).
 */
export type LeaseHealthStatus = 'disabled' | 'no-lease' | 'healthy' | 'contested';

/**
 * Fired on the {@link Engine} when the `status` that {@link Engine.getLeaseHealth}
 * reports changes, and only then: a renewal that leaves the status `healthy` is
 * silent. It fires when the engine observes the change (lease acquisition, a
 * renewal tick, a reported loss, or a fenced-write deposition), not at the
 * instant a lease's expiry time passes while no renewal runs. The
 * `process.emitWarning` signals stay alongside it. Carries the status only; read
 * `getLeaseHealth()` for holder identity and timestamps.
 *
 * @example
 * ```ts
 * import { Engine, LeaseHealthChangedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(LeaseHealthChangedEvent.type, (event) => {
 *   if (event.status === 'contested') console.warn('ownership lease contested');
 * });
 * ```
 */
export class LeaseHealthChangedEvent extends Event {
  static readonly type = 'lease:health-changed' as const;
  readonly status: LeaseHealthStatus;

  constructor(status: LeaseHealthStatus) {
    super(LeaseHealthChangedEvent.type);
    this.status = status;
  }
}

/**
 * Fired on the {@link Engine} (in the server runtime) when a worker's `register`
 * attempt is declined, at the same point the registry appends to its bounded
 * rejection log. `code` is the closed `registerError` taxonomy sent on the wire.
 * `workerId` is `undefined` when the frame carried none, and is truncated to
 * {@link MAX_REJECTED_WORKER_ID_LENGTH} code units because it is not yet
 * validated. The message text, manifest content, and deployment identity are
 * deliberately not carried; read `weft.workers.rejections` for those.
 *
 * @example
 * ```ts
 * import { Engine, WorkerRegistrationRejectedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(WorkerRegistrationRejectedEvent.type, (event) => {
 *   console.warn('registration rejected', event.workerId, event.code);
 * });
 * ```
 */
export class WorkerRegistrationRejectedEvent extends Event {
  static readonly type = 'worker:registration-rejected' as const;
  readonly workerId: string | undefined;
  readonly code: RegisterErrorMessage['code'];

  constructor(workerId: string | undefined, code: RegisterErrorMessage['code']) {
    super(WorkerRegistrationRejectedEvent.type);
    this.workerId = workerId?.slice(0, MAX_REJECTED_WORKER_ID_LENGTH);
    this.code = code;
  }
}

/** Drain state of a worker deployment, or of one of its builds, as the operator drain operations report it. */
export type WorkerDeploymentDrainState = 'active' | 'draining' | 'drained';

/**
 * Fired on the {@link Engine} (in the server runtime) after each operator
 * mutation of a worker deployment commits: draining or resuming a deployment or
 * one of its builds, setting the routing pointer, promoting, or rolling back. `buildId` is present when the mutation named one build.
 * `drainState` is the deployment's (or the named build's) drain state after the
 * mutation, and `routingGeneration` is the deployment's routing pointer
 * generation after it (`0` when no pointer exists). Per-worker drains are not
 * deployment mutations and do not fire it.
 *
 * @example
 * ```ts
 * import { Engine, WorkerDeploymentChangedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(WorkerDeploymentChangedEvent.type, (event) => {
 *   console.log(event.deploymentName, event.drainState, event.routingGeneration);
 * });
 * ```
 */
export class WorkerDeploymentChangedEvent extends Event {
  static readonly type = 'worker:deployment-changed' as const;
  readonly deploymentName: string;
  readonly buildId: string | undefined;
  readonly drainState: WorkerDeploymentDrainState;
  readonly routingGeneration: number;

  constructor(
    deploymentName: string,
    buildId: string | undefined,
    drainState: WorkerDeploymentDrainState,
    routingGeneration: number,
  ) {
    super(WorkerDeploymentChangedEvent.type);
    this.deploymentName = deploymentName;
    this.buildId = buildId;
    this.drainState = drainState;
    this.routingGeneration = routingGeneration;
  }
}

/**
 * Fired on the {@link Engine} after chunks written under a workflow stream key
 * other than `tokens` are durably stored. It carries the key and a zero-based
 * `sequence`, never a chunk body. Token chunks are not announced here: they
 * already reach subscribers through `stream:token` and the workflow feed.
 *
 * It is coalesced per `(workflowId, key)`, so `sequence` is the latest chunk
 * stored when the event fires, not every chunk: the first chunk after a quiet
 * 250 ms window is announced at once, and a trailing event at the end of the
 * window names the latest stored sequence. A stream's last chunk is always
 * announced, when the stream completes or its workflow ends, and a run that a
 * `start-new` replacement superseded announces nothing. Read the chunks after
 * the last one held rather than counting events. The event announces stored
 * chunks, not a completed stream: a stream that later fails has its partial
 * chunks removed.
 *
 * @example
 * ```ts
 * import { Engine, StreamChunkEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(StreamChunkEvent.type, (event) => {
 *   console.log(event.workflowId, event.key, event.sequence);
 * });
 * ```
 */
export class StreamChunkEvent extends Event {
  static readonly type = 'stream:chunk' as const;
  readonly workflowId: string;
  readonly key: string;
  readonly sequence: number;

  constructor(workflowId: string, key: string, sequence: number) {
    super(StreamChunkEvent.type);
    this.workflowId = workflowId;
    this.key = key;
    this.sequence = sequence;
  }
}

/**
 * Fired on the {@link Engine} (in the server runtime) when the number of pending,
 * unclaimed tasks in one of the server's in-memory task queues changes. `queue`
 * is the task queue name and `depth` is its pending count after the change.
 * It is coalesced per queue to at most one event per second: the first change
 * after a quiet period is announced at once, and a trailing event carries the
 * latest depth when the second ends, so a burst that settles at `0` ends with a
 * `0` event. A change that leaves the depth as it was announced is silent.
 *
 * The depth is read from the owning process's own `TaskQueue`, not the durable
 * task ledger, so it is per-process: a deployment with several server processes
 * emits one stream of depths per process and does not sum them. The count
 * restarts at `0` when the process does.
 *
 * @example
 * ```ts
 * import { Engine, QueueDepthChangedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(QueueDepthChangedEvent.type, (event) => {
 *   console.log(event.queue, event.depth);
 * });
 * ```
 */
export class QueueDepthChangedEvent extends Event {
  static readonly type = 'queue:depth-changed' as const;
  readonly queue: string;
  readonly depth: number;

  constructor(queue: string, depth: number) {
    super(QueueDepthChangedEvent.type);
    this.queue = queue;
    this.depth = depth;
  }
}
