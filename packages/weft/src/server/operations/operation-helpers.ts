import type { OperationFault } from "../../embedded/backchannel/src/index.ts";
import {
  invalidParamsFault,
  isOperationFault,
  readRestTextBody,
  type RestFaultResponseOptions,
  type RestInputContext,
} from "../../embedded/backchannel/src/internals.ts";
import type { Storage } from "../../embedded/storage/src/index.ts";
import { UndeclaredWorkflowMessageError, type Engine } from '../../core/engine.ts';
import { WorkerDeploymentVersionRemovedError } from '../../worker/deployment-version-removed-error.ts';
import { shapeWeftRestFaultAsJson } from '../weft-operation-fault.ts';
import { WORKER_CONFLICT_REASONS } from './worker-conflict-reasons.ts';

/**
 * The `Conflict` a start answers when its worker start-override token cannot
 * authorize it (expired, already used, for another workflow, stale against the
 * accepted binding, or unverifiable). The reason is a stable machine-readable
 * string, not the message, so a client branches on it.
 */
export function workerStartOverrideRejectedFault(message: string): OperationFault {
  return {
    code: 'Conflict',
    message,
    data: { reason: WORKER_CONFLICT_REASONS.overrideTokenRejected },
  };
}

/**
 * The `Conflict` an operation that binds work to a deployment build answers when the build has been
 * removed (`version-removed`), or `undefined` when `error` is not that error. A start, a restart, a
 * fork, a child, an automatic upgrade, the retry of a failed run and a task-ledger entry all end
 * here.
 */
export function workerVersionRemovedFault(error: unknown): OperationFault | undefined {
  if (!(error instanceof WorkerDeploymentVersionRemovedError)) return undefined;
  return {
    code: 'Conflict',
    message: error.message,
    data: { reason: WORKER_CONFLICT_REASONS.versionRemoved },
  };
}

/**
 * Default REST fault shaper. Delegates to the centralized, exhaustively
 * audited REST projection so direct and per-operation bindings cannot drift.
 * REST-only — JSON-RPC transports receive their distinct operation fault data.
 *
 * When the fault carries a fine-grained `data.weftCode` (set only at sites that
 * hold a typed `WeftError`), it remains a top-level `weftCode` sibling. Safe
 * structured fields are added under `data`; fields outside the per-code
 * allowlist are withheld. `EngineFailure` stays byte-identically masked.
 */
export function shapeRestFault(
  fault: OperationFault,
  options?: RestFaultResponseOptions,
): Response {
  return shapeWeftRestFaultAsJson(fault, options);
}

export function faultMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function unprocessableFault(message: string): OperationFault {
  return {
    code: 'Unprocessable',
    message,
    data: { reason: message },
  };
}

/**
 * The `Unprocessable` a signal, update, or query answers when the workflow
 * declared messages of that kind and this name is not one of them, or
 * `undefined` when `error` is not that rejection.
 */
export function undeclaredMessageFault(error: unknown): OperationFault | undefined {
  if (!(error instanceof UndeclaredWorkflowMessageError)) return undefined;
  return unprocessableFault(error.message);
}

export function engineFailureFault(message: string): OperationFault {
  return {
    code: 'EngineFailure',
    message,
    data: {},
  };
}

export async function readOptionalJsonBody(
  request: Request,
  context?: RestInputContext,
): Promise<unknown> {
  try {
    const text = await readRestTextBody(request, context);
    return text.trim() === '' ? undefined : (JSON.parse(text) as unknown);
  } catch (error) {
    if (isOperationFault(error)) throw error;
    throw invalidParamsFault('Invalid JSON body');
  }
}

export type OperationEngineMethodName = {
  [Key in keyof Engine]-?: Engine[Key] extends (...arguments_: never[]) => unknown ? Key : never;
}[keyof Engine];

/** Validate the object boundary for helpers that use engine-owned private state. */
export function assertOperationEngineObject(engine: unknown): asserts engine is object {
  if (typeof engine !== 'object' || engine === null || Array.isArray(engine)) {
    throw new TypeError('Operation requires an engine object.');
  }
}

/** Narrow an operation engine to the exact methods an operation will call. */
export function assertOperationEngineMethods<
  const Methods extends readonly OperationEngineMethodName[],
>(engine: unknown, methods: Methods): asserts engine is Pick<Engine, Methods[number]> {
  if (typeof engine !== 'object' || engine === null || Array.isArray(engine)) {
    throw new TypeError('Operation requires an engine with the requested capabilities.');
  }

  for (const method of methods) {
    if (typeof Reflect.get(engine, method) !== 'function') {
      throw new TypeError(`Operation engine is missing required method "${String(method)}".`);
    }
  }
}

/** Narrow an operation engine to exact callable methods on its workflow namespace. */
export function assertOperationWorkflowMethods<
  const Methods extends readonly (keyof Engine['workflows'])[],
>(
  engine: unknown,
  methods: Methods,
): asserts engine is { workflows: Pick<Engine['workflows'], Methods[number]> } {
  if (typeof engine !== 'object' || engine === null || Array.isArray(engine)) {
    throw new TypeError('Operation requires an engine with the requested capabilities.');
  }
  const workflows = Reflect.get(engine, 'workflows');
  if (typeof workflows !== 'object' || workflows === null || Array.isArray(workflows)) {
    throw new TypeError('Operation engine is missing the requested workflow capabilities.');
  }
  for (const method of methods) {
    if (typeof Reflect.get(workflows, method) !== 'function') {
      throw new TypeError(`Operation workflow namespace is missing required method "${method}".`);
    }
  }
}

export type OperationStorageMethodName =
  'capabilities' | 'get' | 'put' | 'delete' | 'scan' | 'batch' | 'conditionalBatch';

type OperationStorageContract<Methods extends readonly OperationStorageMethodName[]> = Pick<
  Storage,
  Methods[number]
>;

function isOperationStorageWithMethods<const Methods extends readonly OperationStorageMethodName[]>(
  value: unknown,
  methods: Methods,
): value is OperationStorageContract<Methods> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return methods.every((method) => typeof Reflect.get(value, method) === 'function');
}

/** Resolve the storage capability needed by the raw storage operations. */
export function requireOperationStorage<
  const Methods extends readonly OperationStorageMethodName[],
>(engine: unknown, methods: Methods): OperationStorageContract<Methods> {
  if (typeof engine !== 'object' || engine === null || Array.isArray(engine)) {
    throw new TypeError('Raw storage operations require an engine with storage capabilities.');
  }

  const storage = Reflect.get(engine, 'storage');
  if (!isOperationStorageWithMethods(storage, methods)) {
    throw new TypeError('Raw storage operations require the requested storage capability.');
  }
  return storage;
}

/** Validate one optional storage method at the operation boundary that consumes it. */
export function assertOperationStorageMethod<const Method extends OperationStorageMethodName>(
  storage: unknown,
  method: Method,
  message?: string,
): asserts storage is Required<Pick<Storage, Method>> {
  if (
    typeof storage !== 'object' ||
    storage === null ||
    Array.isArray(storage) ||
    typeof Reflect.get(storage, method) !== 'function'
  ) {
    throw new TypeError(message ?? `Operation storage is missing required method "${method}".`);
  }
}

/** Validate and return one optional storage method for the operation that consumes it. */
export function requireOperationStorageMethod<const Method extends OperationStorageMethodName>(
  storage: unknown,
  method: Method,
  message?: string,
): Required<Pick<Storage, Method>> {
  assertOperationStorageMethod(storage, method, message);
  return storage;
}
