/**
 * Type-level regression tests for WFT-93.
 *
 * An operation whose Zod `outputSchema` is a `z.discriminatedUnion()` compiles
 * to JSON Schema `oneOf`. Before WFT-93 the client generator had no `oneOf`
 * case, so every such operation surfaced through `client.operations` as
 * `unknown` — callers got no fields and no narrowing.
 *
 * These assertions pin three things the generator must keep emitting:
 * the discriminant survives as a string literal (not widened to `string`),
 * narrowing on it reaches branch-only fields, and a `oneOf` nested inside
 * another `oneOf` or under `anyOf` flattens into the same union rather than
 * collapsing back to `unknown`.
 *
 * Written against `WeftClient['operations']` rather than the generated
 * `ClientOperationTypes` directly, so a regression in either the generator or
 * the client's wiring to it fails here.
 *
 * @module client/generated-operations.test-d
 */

import type { WeftClient } from './interface.ts';

declare const operations: WeftClient['operations'];

/**
 * `weft.tasks.get` — six top-level `oneOf` branches, one of which (`terminal`)
 * is itself a nested `oneOf` of three disposition branches.
 */
type TaskRecord = Awaited<ReturnType<(typeof operations)['weft.tasks.get']>>;

declare const task: TaskRecord;

// The discriminant is present on every branch and stays a literal union. Both
// halves matter: reading `.state` at all fails when the output is `unknown`,
// and the annotation fails if the branches widened to `string`.
const _taskStates: 'queued' | 'leased' | 'completing' | 'cancelling' | 'terminal' | 'deadLettered' =
  task.state;
void _taskStates;

// @ts-expect-error — 'settled' is not one of the emitted discriminant literals.
const _notAState: TaskRecord['state'] = 'settled';
void _notAState;

// Narrowing on the discriminant reaches the nested `oneOf` branches, whose
// `disposition` field exists on no other branch. This is the assertion that
// proves nested union flattening, not just top-level `oneOf` support.
function dispositionOf(
  record: TaskRecord,
): 'resolved' | 'cancelled' | 'retryExhausted' | undefined {
  return record.state === 'terminal' ? record.disposition : undefined;
}
void dispositionOf;

// Branch-only fields must NOT be reachable before narrowing.
// @ts-expect-error — `disposition` exists only on the `terminal` branches.
const _unnarrowedDisposition = task.disposition;
void _unnarrowedDisposition;

// A field shared by every branch stays reachable without narrowing.
const _operationId: string = task.operationId;
void _operationId;

/**
 * `weft.workers.drain` — a two-branch `oneOf` whose branches are hoisted into
 * shared aliases, confirming narrowing survives alias substitution.
 */
type DrainResult = Awaited<ReturnType<(typeof operations)['weft.workers.drain']>>;

declare const drain: DrainResult;

const _drainTargets: 'worker' | 'deployment' = drain.target;
void _drainTargets;

const _drainedWorkerId: string | undefined = drain.target === 'worker' ? drain.workerId : undefined;
void _drainedWorkerId;

const _drainedDeploymentName: string | undefined =
  drain.target === 'deployment' ? drain.deploymentName : undefined;
void _drainedDeploymentName;

/**
 * `weft.workflows.finalizer.get` — a `oneOf` nested under `anyOf` with `null`,
 * the nullable-discriminated-union shape. The whole union used to collapse to
 * `unknown` because its first `anyOf` member was an unsupported `oneOf`.
 */
type FinalizerState = Awaited<ReturnType<(typeof operations)['weft.workflows.finalizer.get']>>;

declare const finalizer: FinalizerState;

const _finalizerStatuses: 'pending' | 'running' | 'succeeded' | 'failed' | undefined =
  finalizer === null ? undefined : finalizer.status;
void _finalizerStatuses;

const _finalizerError: string | undefined =
  finalizer !== null && finalizer.status === 'failed' ? finalizer.error : undefined;
void _finalizerError;

// `null` remains part of the union — the `anyOf` sibling must not be dropped.
const _finalizerNullable: FinalizerState = null;
void _finalizerNullable;
