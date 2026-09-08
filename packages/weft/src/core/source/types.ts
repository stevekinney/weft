/**
 * Types for dynamic workflow sources (WFT-13/14): a typed, serializable
 * {@link WorkflowSourceDescriptor} paired with a host-side loader capability
 * that is never serialized, plus the pure type-extractor helpers
 * {@link workflowSource} uses to preserve a literal `() => import('./x.ts')`
 * import's exact `TInput`/`TOutput`/`TServices` inference through to the
 * returned {@link WorkflowSourceHandle}.
 *
 * @module core/source/types
 */

import type { WorkflowDefinition } from '../types.ts';

/**
 * The kind of location a {@link WorkflowSourceDescriptor} names. `'module'`
 * is the only kind today — a literal ES module import resolved by a host
 * loader. The union is a single literal rather than `string` so a future
 * source kind (a bundle registry entry, a remote fetch) can be added without
 * a breaking change to this type.
 *
 * @example
 * ```ts
 * import type { WorkflowSourceKind } from '@lostgradient/weft';
 *
 * const kind: WorkflowSourceKind = 'module';
 * console.log(kind);
 * ```
 */
export type WorkflowSourceKind = 'module';

/**
 * Plain, serializable metadata identifying one dynamic workflow source:
 * where a workflow's code lives (`location`), which named export holds the
 * workflow definition (`exportName`), and the exact revision the caller
 * expects (`revision`), plus optional pinned `workflowVersion`/`contractHash`
 * expectations. Deliberately carries no function reference — the loader
 * capability that actually resolves `location` into a module value is a
 * separate, never-serialized field on {@link WorkflowSourceHandle}. A
 * descriptor is safe to log, persist, or send over the wire; nothing here
 * can execute code.
 *
 * `TName` is a phantom convenience for callers that want to brand a
 * descriptor with a specific workflow name at the type level (for example
 * a lookup table keyed by name); {@link WorkflowSourceHandle} itself always
 * carries the unparameterized (`TName = string`) shape, since the
 * descriptor's `name` field holds whatever string the caller supplied and
 * is only checked against the loaded module's actual name at resolve time
 * — see `resolveWorkflowSource`'s `name-mismatch` rejection reason.
 *
 * @example
 * ```ts
 * import type { WorkflowSourceDescriptor } from '@lostgradient/weft';
 *
 * const descriptor: WorkflowSourceDescriptor = {
 *   kind: 'module',
 *   name: 'checkout',
 *   location: './workflows/checkout.ts',
 *   exportName: 'checkout',
 *   revision: 'checkout-2026.09.01',
 * };
 * console.log(descriptor.kind);
 * ```
 */
export interface WorkflowSourceDescriptor<TName extends string = string> {
  /** Which resolver (`core/source/resolvers.ts`) loads this source. */
  readonly kind: WorkflowSourceKind;
  /** The workflow name this source is expected to resolve to. */
  readonly name: TName;
  /**
   * Host-meaningful location string (a module specifier for `kind: 'module'`).
   * Carried verbatim — never parsed, concatenated, or used to construct an
   * import specifier by this package; the loader capability alone is
   * responsible for turning `location` into a loaded module.
   */
  readonly location: string;
  /** The named export within the loaded module that holds the workflow definition. */
  readonly exportName: string;
  /** The caller's expected content-derived revision; compared against the revision actually derived from the loaded contract. */
  readonly revision: string;
  /** Optional pinned workflow version; compared with `checkWorkflowCompatibility`'s semver-range semantics when set. */
  readonly workflowVersion?: string;
  /** Optional pinned contract hash; compared for exact equality when set. */
  readonly contractHash?: string;
}

/**
 * The loose input shape {@link workflowSource} accepts before `kind`
 * defaults to `'module'` — every {@link WorkflowSourceDescriptor} field
 * except `kind`, which callers may omit for the only kind that exists today.
 *
 * @example
 * ```ts
 * import type { WorkflowSourceDescriptorInput } from '@lostgradient/weft';
 *
 * const input: WorkflowSourceDescriptorInput<'checkout'> = {
 *   name: 'checkout',
 *   location: './workflows/checkout.ts',
 *   exportName: 'checkout',
 *   revision: 'checkout-2026.09.01',
 * };
 * console.log(input.exportName);
 * ```
 */
export type WorkflowSourceDescriptorInput<TExportName extends string> = {
  readonly kind?: WorkflowSourceKind;
  readonly name: string;
  readonly location: string;
  readonly exportName: TExportName;
  readonly revision: string;
  readonly workflowVersion?: string;
  readonly contractHash?: string;
};

/**
 * A typed handle pairing a serializable {@link WorkflowSourceDescriptor}
 * with the host-side loader capability that resolves it — the value
 * `workflowSource()` returns. `load` is a plain `() => Promise<unknown>`
 * at the type level; when built from a literal `() => import('./x.ts')`
 * import, `TInput`/`TOutput`/`TName`/`TServices` are inferred from the
 * named export the descriptor points at, so `engine.registerSource(handle)`
 * and a later `resolveWorkflowSource` can carry that inference through
 * without a cast. `TInput`/`TOutput`/`TName`/`TServices` are phantom —
 * carried only as optional, never-populated marker fields — mirroring
 * `BuiltWorkflowDefinition`'s own phantom-marker convention
 * (`core/types/workflow-builder.ts`).
 *
 * @example
 * ```ts
 * import { workflowSource } from '@lostgradient/weft';
 * import type { WorkflowSourceHandle } from '@lostgradient/weft';
 *
 * declare const loadCheckout: () => Promise<{
 *   checkout: import('@lostgradient/weft').WorkflowDefinition<{ orderId: string }, { shipped: boolean }, 'checkout'>;
 * }>;
 * const source: WorkflowSourceHandle = workflowSource(
 *   { name: 'checkout', location: './workflows/checkout.ts', exportName: 'checkout', revision: 'r1' },
 *   loadCheckout,
 * );
 * console.log(source.descriptor.name);
 * ```
 */
export interface WorkflowSourceHandle<
  TInput = unknown,
  TOutput = unknown,
  TName extends string = string,
  TServices = unknown,
> {
  /** Plain, serializable source metadata. Never carries a function reference. */
  readonly descriptor: WorkflowSourceDescriptor;
  /** Host-side loader capability. Never serialized; invoked at most once per `(name, revision)` — see `resolveWorkflowSource`. */
  readonly load: () => Promise<unknown>;
  /** Phantom marker for the resolved workflow's input type. Not present at runtime. */
  readonly _input?: TInput;
  /** Phantom marker for the resolved workflow's output type. Not present at runtime. */
  readonly _output?: TOutput;
  /** Phantom marker for the resolved workflow's literal name type. Not present at runtime. */
  readonly _name?: TName;
  /** Phantom marker for the resolved workflow's per-run services type. Not present at runtime. */
  readonly _services?: TServices;
}

// ---------------------------------------------------------------------------
// Pure type-extractor helpers
// ---------------------------------------------------------------------------

/**
 * `true` when `T` is exactly `any` — used to reject a `workflowSource()`
 * call whose loader's module type could not be inferred (a dynamic
 * `import(pathVariable)`, which TypeScript types as `Promise<any>`).
 * Distinguishing `any` from a genuine `Record<string, unknown>` requires
 * this "does `T` accept both `0` and `1`" trick rather than `T extends
 * Record<string, unknown>` — `any` would trivially satisfy that constraint
 * too, silently defeating the whole point of requiring a literal import.
 *
 * @example
 * ```ts
 * import type { IsAny } from './types.ts';
 *
 * type CheckConcrete = IsAny<{ a: 1 }>;
 * const concrete: CheckConcrete = false;
 * console.log(concrete);
 * ```
 */
export type IsAny<T> = 0 extends 1 & T ? true : false;

/**
 * Resolve the exact export type at `TExportName` on `TModule`, narrowed to
 * `WorkflowDefinition` — or `never` when that export is not one. Feeding
 * `never` into {@link InputOf} / {@link OutputOf} / {@link NameOf} /
 * {@link ServicesOf} collapses each to `never` too (conditional types
 * distribute over `never`, TypeScript's "empty union" case), which is how a
 * `workflowSource()` call pointed at a non-workflow export compiles at the
 * call site but produces a handle whose type parameters are unusable —
 * misuse fails at first *use* of the handle rather than at the
 * `workflowSource()` call itself. See `workflow-source.test-d.ts` for the
 * regression pin.
 *
 * @example
 * ```ts
 * import type { ModuleWorkflowDefinition } from './types.ts';
 * import type { WorkflowDefinition } from '@lostgradient/weft';
 *
 * type Module = { checkout: WorkflowDefinition<{ orderId: string }, { shipped: boolean }, 'checkout'> };
 * type Resolved = ModuleWorkflowDefinition<Module, 'checkout'>;
 * declare const resolved: Resolved;
 * console.log(resolved.name);
 * ```
 */
export type ModuleWorkflowDefinition<
  TModule extends Record<string, unknown>,
  TExportName extends keyof TModule & string,
> =
  TModule[TExportName] extends WorkflowDefinition<
    infer _TInput,
    infer _TOutput,
    infer _TName,
    infer _TServices
  >
    ? TModule[TExportName]
    : never;

/** Extract `TInput` from a `WorkflowDefinition`-shaped type, or `never`. */
export type InputOf<T> =
  T extends WorkflowDefinition<infer TInput, infer _TOutput, infer _TName, infer _TServices>
    ? TInput
    : never;

/** Extract `TOutput` from a `WorkflowDefinition`-shaped type, or `never`. */
export type OutputOf<T> =
  T extends WorkflowDefinition<infer _TInput, infer TOutput, infer _TName, infer _TServices>
    ? TOutput
    : never;

/** Extract the literal `TName` from a `WorkflowDefinition`-shaped type, or `never`. */
export type NameOf<T> =
  T extends WorkflowDefinition<infer _TInput, infer _TOutput, infer TName, infer _TServices>
    ? TName
    : never;

/** Extract `TServices` from a `WorkflowDefinition`-shaped type, or `never`. */
export type ServicesOf<T> =
  T extends WorkflowDefinition<infer _TInput, infer _TOutput, infer _TName, infer TServices>
    ? TServices
    : never;
