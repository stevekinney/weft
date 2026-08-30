/**
 * Type-level helpers consumed by the workflow builder
 * (`src/core/types/workflow-builder.ts`) and by the per-workflow
 * `WorkflowContext` overloads (Phase 1b).
 *
 * Split out from `workflow-builder.ts` so each file stays under the project's
 * 500-line guideline and so engine plumbing in later phases can import the
 * normalised activity/signal/update/query shapes without dragging in the
 * builder interface itself.
 */

import type { ActivityCallable, ActivityContext, ActivityDefinition } from './activity.ts';
import type { QueryDefinition, SignalDefinition, UpdateDefinition } from './message-handles.ts';

// ---------------------------------------------------------------------------
// Activity input shapes accepted by `.activities({ ... })`
// ---------------------------------------------------------------------------

/**
 * Object form accepted by `.activities({ ... })`. The outer object key is the
 * canonical activity name; the inner `name` field is forbidden because passing
 * one that disagrees with the key is the most common authoring mistake. All
 * other `ActivityDefinition` options (`retry`, `timeout`, `idempotent`,
 * `queue`, `description`, `tags`, schemas, `compensate`, `verify`, etc.) are
 * passed through unchanged.
 *
 * @example
 * ```ts
 * import type { ActivityObjectInput } from '@lostgradient/weft';
 *
 * const entry: ActivityObjectInput<string, string> = {
 *   execute: async (greeting) => `hello ${greeting}`,
 *   idempotent: true,
 * };
 * void entry;
 * ```
 */
export type ActivityObjectInput<TInput = unknown, TOutput = unknown> = Omit<
  ActivityDefinition<TInput, TOutput>,
  'name'
>;

/** Detect the object form (has `execute`) from a bare callable. */
type HasExecuteProperty<T> = T extends { execute: unknown } ? true : false;

/**
 * Accepted shapes for a single entry in the `.activities({ ... })` map.
 *
 * - Bare async or sync function with a single input parameter (or no
 *   parameters, for void-input activities).
 * - `ActivityCallable<TInput, TOutput>` returned by `activity({ name, execute })`.
 * - Object form carrying `execute` plus optional `retry`, `timeout`,
 *   `idempotent`, etc.
 *
 * The constraint is intentionally loose: a single union of three structural
 * shapes (function, callable-shaped, has-execute-object). Tightening it to
 * fixed-input-type unions (`(input: never) => unknown`) triggers
 * contravariance errors that prevent the most common authoring forms from
 * satisfying `extends ActivityMapInput`. `NormalizeActivities<T>` reads the
 * concrete input/output types off each entry directly via conditional
 * inference, so the looser constraint does not cost us downstream typing.
 *
 * Multi-parameter functions are allowed by the constraint but degrade
 * gracefully to `unknown` input in `NormalizeActivities<T>` — they cannot
 * be reliably called via `ctx.run('name', input)` and that is documented.
 *
 * @example
 * ```ts
 * import type { ActivityEntryInput } from '@lostgradient/weft';
 *
 * const entry: ActivityEntryInput = async (name: string) => `hello ${name}`;
 * void entry;
 * ```
 */
export type ActivityEntryInput =
  | ((...arguments_: never[]) => unknown)
  | { readonly execute: (...arguments_: never[]) => unknown };

/**
 * The map shape `.activities({ ... })` accepts. Each value is an
 * `ActivityEntryInput`; the outer object key becomes the activity's canonical
 * name.
 *
 * @example
 * ```ts
 * import type { ActivityMapInput } from '@lostgradient/weft';
 *
 * const map: ActivityMapInput = {
 *   greet: async (name: string) => `hello ${name}`,
 * };
 * void map;
 * ```
 */
export type ActivityMapInput = Record<string, ActivityEntryInput>;

// ---------------------------------------------------------------------------
// Normalised activity map carried by the builder and the workflow definition
// ---------------------------------------------------------------------------

/**
 * Single entry in the normalised activity map. Inputs and outputs are extracted
 * from the user-provided form so downstream type helpers
 * (`ActivityArgsFor`, `ActivityResultFor`) can read them uniformly without
 * re-discriminating between bare functions and object forms.
 *
 * The `definition` field stores an untyped `ActivityDefinition` (generic
 * defaults of `unknown`) so the entry remains assignable across input/output
 * variations. Type-safety is preserved via the phantom `input`/`output`
 * marker fields, which `ActivityArgsFor`/`ActivityResultFor` consume.
 *
 * @example
 * ```ts
 * import type { NormalizedActivityEntry } from '@lostgradient/weft';
 *
 * type GreetEntry = NormalizedActivityEntry<{ name: string }, string>;
 * declare const entry: GreetEntry;
 * void entry.definition;
 * ```
 */
export interface NormalizedActivityEntry<TInput = unknown, TOutput = unknown> {
  /** Phantom marker — never read at runtime; carries the input type for ctx.run typing. */
  readonly input?: TInput;
  /** Phantom marker — never read at runtime; carries the output type for ctx.run typing. */
  readonly output?: TOutput;
  readonly definition: ActivityDefinition;
}

/**
 * The shape stored on a built `WorkflowDefinition` after `.activities({...})`
 * is consumed. Each entry exposes the inferred input/output types and the
 * normalised `ActivityDefinition` object that runtime code installs into the
 * per-workflow activity registry.
 *
 * @example
 * ```ts
 * import { workflow, type ActivityMap } from '@lostgradient/weft';
 *
 * const built = workflow({ name: 'demo' })
 *   .activities({ greet: async (name: string) => `hello ${name}` })
 *   .execute(async function* () { return 'ok'; });
 * const activities: ActivityMap = built.activities as unknown as ActivityMap;
 * void activities;
 * ```
 */
export type ActivityMap = Record<string, NormalizedActivityEntry>;

/**
 * Maps each entry in a user-supplied `ActivityMapInput` to a
 * `NormalizedActivityEntry`. Input/output inference rules:
 *
 * - Bare zero-arg function `() => TOutput | Promise<TOutput>`:
 *   `input = void`, `output = Awaited<TOutput>`.
 * - Bare single-arg function `(input: TInput) => TOutput | Promise<TOutput>`:
 *   `input = TInput`, `output = Awaited<TOutput>`.
 * - `ActivityCallable<TInput, TOutput>`: same as the underlying definition.
 * - Object form `{ execute, ...options }`: `execute`'s signature drives inference.
 * * Multi-parameter functions fall through to `unknown` inputs, which makes
 * `ctx.run('name', wrongType)` lose type-safety — type tests in Phase 1c pin
 * this rejection so users see a clear error rather than silent `unknown` drift.
 *
 * @example
 * ```ts
 * import type { NormalizeActivities } from '@lostgradient/weft';
 *
 * type Greet = NormalizeActivities<{ greet: (name: string) => Promise<string> }>;
 * declare const greet: Greet['greet'];
 * void greet;
 * ```
 */
export type NormalizeActivities<T extends ActivityMapInput> = {
  [K in keyof T & string]: NormalizeActivityEntry<T[K]>;
};

type NormalizeActivityEntry<T extends ActivityEntryInput> =
  HasExecuteProperty<T> extends true
    ? T extends { execute: (input: infer TInput, context?: ActivityContext) => infer TOutput }
      ? NormalizedActivityEntry<NormalizedInputType<TInput>, Awaited<TOutput>>
      : T extends { execute: (...arguments_: infer _Args) => infer TOutput }
        ? NormalizedActivityEntry<unknown, Awaited<TOutput>>
        : NormalizedActivityEntry
    : T extends ActivityCallable<infer TInput, infer TOutput>
      ? NormalizedActivityEntry<TInput, TOutput>
      : T extends () => infer TOutput
        ? NormalizedActivityEntry<void, Awaited<TOutput>>
        : T extends (input: infer TInput) => infer TOutput
          ? NormalizedActivityEntry<NormalizedInputType<TInput>, Awaited<TOutput>>
          : NormalizedActivityEntry;

/**
 * `never` in a contravariant position can swallow the inferred type; normalize
 * it back to `unknown` so downstream `ActivityArgsFor` produces a usable
 * argument shape rather than the unsatisfiable `[input: never]`.
 */
type NormalizedInputType<T> = [T] extends [never] ? unknown : T;

// ---------------------------------------------------------------------------
// Helpers for typing ctx.run, ctx.waitForSignal, ctx.waitForUpdate, etc.
// ---------------------------------------------------------------------------

/**
 * Argument tuple for `ctx.run('name', ...args)`. Collapses to `[]` for `void`
 * inputs; preserves `[] | [input]` for optional inputs so both zero-arg and
 * single-arg call shapes typecheck; otherwise `[input: T]`.
 *
 * @example
 * ```ts
 * import { workflow, type ActivityArgsFor, type ActivityMap } from '@lostgradient/weft';
 *
 * const greet = workflow({ name: 'greet' })
 *   .activities({ formatGreeting: async (name: string) => `hello ${name}` })
 *   .execute(async function* () { return 'ok'; });
 *
 * type Activities = NonNullable<typeof greet._activities>;
 * type Args = ActivityArgsFor<Activities['formatGreeting']>;
 * const args: Args = ['hi'];
 * void args;
 * void (null as unknown as ActivityMap);
 * ```
 */
export type ActivityArgsFor<TEntry extends NormalizedActivityEntry> =
  TEntry extends NormalizedActivityEntry<infer TInput>
    ? [TInput] extends [void]
      ? []
      : undefined extends TInput
        ? [] | [input: Exclude<TInput, undefined>]
        : [input: TInput]
    : [];

/**
 * Result type for `ctx.run('name', ...)`. Always `Awaited<TOutput>` so workflow
 * code never sees a bare `Promise`.
 *
 * @example
 * ```ts
 * import { workflow, type ActivityResultFor } from '@lostgradient/weft';
 *
 * const greet = workflow({ name: 'greet' })
 *   .activities({ formatGreeting: async (name: string) => `hello ${name}` })
 *   .execute(async function* () { return 'ok'; });
 *
 * type Activities = NonNullable<typeof greet._activities>;
 * type Result = ActivityResultFor<Activities['formatGreeting']>;
 * const result: Result = 'hello';
 * void result;
 * ```
 */
export type ActivityResultFor<TEntry extends NormalizedActivityEntry> =
  TEntry extends NormalizedActivityEntry<unknown, infer TOutput> ? Awaited<TOutput> : unknown;

/**
 * Lookup type for `ctx.waitForSignal('name')`. Extracts the payload type from a
 * `SignalDefinition` stored on the workflow's signal map.
 *
 * @example
 * ```ts
 * import { signal, type SignalPayload } from '@lostgradient/weft';
 *
 * const approve = signal<{ approverId: string }>('approve');
 * type ApprovePayload = SignalPayload<typeof approve>;
 * const payload: ApprovePayload = { approverId: 'user-1' };
 * void payload;
 * ```
 */
export type SignalPayload<TSignal> =
  TSignal extends SignalDefinition<infer TInput> ? TInput : unknown;

/**
 * Lookup type for `ctx.waitForUpdate('name')`. Extracts the payload + response
 * shape from a `UpdateDefinition`.
 *
 * @example
 * ```ts
 * import { update, type UpdatePayload } from '@lostgradient/weft';
 *
 * const checkStatus = update<{ id: string }, { status: string }>('checkStatus');
 * type CheckPayload = UpdatePayload<typeof checkStatus>;
 * declare const shape: CheckPayload;
 * shape.respond({ status: 'pending' });
 * void shape.payload.id;
 * ```
 */
export type UpdatePayload<TUpdate> =
  TUpdate extends UpdateDefinition<infer TInput, infer TOutput>
    ? { payload: TInput; respond: (result: TOutput) => void }
    : { payload: unknown; respond: (result: unknown) => void };

/**
 * Lookup type for query handlers registered on a workflow. Returns the
 * `{ input, output }` pair so handler signatures stay symmetrical with the
 * other message kinds.
 *
 * @example
 * ```ts
 * import { query, type QueryShape } from '@lostgradient/weft';
 *
 * const getProgress = query<void, number>('getProgress');
 * type Shape = QueryShape<typeof getProgress>;
 * const example: Shape = { input: undefined, output: 0.5 };
 * void example;
 * ```
 */
export type QueryShape<TQuery> =
  TQuery extends QueryDefinition<infer TInput, infer TOutput>
    ? { input: TInput; output: TOutput }
    : { input: unknown; output: unknown };

// ---------------------------------------------------------------------------
// Map containers for the builder's per-method payloads
// ---------------------------------------------------------------------------

// Each map's value constraint is structural (`{ readonly name: string }`)
// rather than a fully-typed `SignalDefinition<TInput>`. The structural form
// dodges contravariance pain on the `_input` / `_output` phantom markers:
// `SignalDefinition<{ approverId: string }>` is *not* assignable to
// `SignalDefinition<unknown>` under `exactOptionalPropertyTypes`, because the
// phantom marker's parameter widens the contravariant position. The structural
// constraint lets each entry preserve its own payload type, which is what
// `SignalPayload<S>` / `UpdatePayload<U>` / `QueryShape<Q>` then read back out.

/**
 * Map shape stored on the workflow definition after `.signals({...})`.
 *
 * @example
 * ```ts
 * import { signal, type SignalMap } from '@lostgradient/weft';
 *
 * const map: SignalMap = { approve: signal<{ approverId: string }>('approve') };
 * void map;
 * ```
 */
export type SignalMap = Record<string, { readonly name: string }>;

/**
 * Map shape stored on the workflow definition after `.updates({...})`.
 *
 * @example
 * ```ts
 * import { update, type UpdateMap } from '@lostgradient/weft';
 *
 * const map: UpdateMap = {
 *   checkStatus: update<{ id: string }, { status: string }>('checkStatus'),
 * };
 * void map;
 * ```
 */
export type UpdateMap = Record<string, { readonly name: string }>;

/**
 * Map shape stored on the workflow definition after `.queries({...})`.
 *
 * @example
 * ```ts
 * import { query, type QueryMap } from '@lostgradient/weft';
 *
 * const map: QueryMap = { getProgress: query<void, number>('getProgress') };
 * void map;
 * ```
 */
export type QueryMap = Record<string, { readonly name: string }>;
