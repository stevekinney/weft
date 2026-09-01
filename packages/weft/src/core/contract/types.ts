/**
 * Canonical, normalized workflow contract vocabulary.
 *
 * A `WorkflowContract` is the single normalized representation that feeds
 * both TypeScript code generation (`weft codegen`) and `contractHash()` — the
 * same data, described once, rather than two independent derivations that
 * could silently drift apart. `WorkflowRevisionManifest` pairs that contract
 * with the two identity questions a consumer asks about a workflow revision:
 *
 * | Field          | Question answered                                    | Stability                    |
 * | -------------- | ----------------------------------------------------- | ----------------------------- |
 * | `contractHash` | Which public payload contract does this revision use? | Deterministic, payload-only   |
 * | `revision`     | Which exact definition (name, version, docs) is this? | Deterministic or author-set   |
 *
 * `contractHash` deliberately excludes `name`, `workflowVersion`,
 * `description`, and `tags` — those identify *which* workflow and *how it is
 * documented*, not *what callers may send and expect back*. `revision` is the
 * broader identity: it changes on a documentation edit even when the payload
 * contract does not, which is what lets a caller detect "the same contract,
 * redeployed" versus "a genuinely different definition was loaded."
 *
 * @module core/contract/types
 */

import type { DefinitionSchema } from '../types/definition-schema.ts';

/**
 * Domain separator folded into every `contractHash()`/`deriveWorkflowRevision()`
 * digest. Bumping this constant is how a future normalization change is
 * guaranteed to produce a different hash rather than silently colliding with
 * one computed under the old rules.
 *
 * @example
 * ```ts
 * import { WORKFLOW_CONTRACT_VERSION } from '@lostgradient/weft';
 *
 * console.log(WORKFLOW_CONTRACT_VERSION); // 1
 * ```
 */
export const WORKFLOW_CONTRACT_VERSION = 1;

/**
 * Normalized JSON Schema pair carried by one workflow signal, update, or
 * query.
 *
 * @example
 * ```ts
 * import type { WorkflowMessageContract } from '@lostgradient/weft';
 *
 * const approval: WorkflowMessageContract = {
 *   inputSchema: { type: 'object', properties: { approved: { type: 'boolean' } } },
 * };
 * console.log(approval.inputSchema?.['type']);
 * ```
 */
export type WorkflowMessageContract = Readonly<{
  /** Normalized JSON Schema describing accepted input, when the message accepts one. */
  inputSchema?: Record<string, unknown>;
  /** Normalized JSON Schema describing the returned value, when the message returns one. */
  outputSchema?: Record<string, unknown>;
}>;

/**
 * Normalized JSON Schema pair carried by one activity a workflow contract
 * exposes.
 *
 * @example
 * ```ts
 * import type { WorkflowActivityContract } from '@lostgradient/weft';
 *
 * const charge: WorkflowActivityContract = {
 *   inputSchema: { type: 'object', properties: { amount: { type: 'number' } } },
 *   outputSchema: { type: 'object', properties: { id: { type: 'string' } } },
 * };
 * console.log(charge.inputSchema?.['type']);
 * ```
 */
export type WorkflowActivityContract = Readonly<{
  /** Normalized JSON Schema describing accepted input, when the activity accepts one. */
  inputSchema?: Record<string, unknown>;
  /** Normalized JSON Schema describing the returned value, when the activity returns one. */
  outputSchema?: Record<string, unknown>;
}>;

/**
 * Canonical, normalized representation of one workflow's public contract —
 * everything callers may send it and expect back, plus enough identity
 * metadata (`name`, `workflowVersion`, `description`, `tags`) to describe
 * which workflow this is. This is the single input to both TypeScript
 * emission and `contractHash()`.
 *
 * Every open-ended record (`signals`, `updates`, `queries`, `activities`) is
 * omitted entirely rather than present-but-empty, matching the registry
 * snapshot's "absent fields omitted, never `null` or `{}`" convention — see
 * {@link normalizeWorkflowContract}.
 *
 * @example
 * ```ts
 * import type { WorkflowContract } from '@lostgradient/weft';
 *
 * const checkout: WorkflowContract = {
 *   name: 'checkout',
 *   workflowVersion: '2.1.0',
 *   inputSchema: { type: 'object', properties: { cartId: { type: 'string' } } },
 *   activities: {
 *     charge: { inputSchema: { type: 'object', properties: { amount: { type: 'number' } } } },
 *   },
 * };
 * console.log(checkout.name);
 * ```
 */
export type WorkflowContract = Readonly<{
  /** Wire-safe workflow name. */
  name: string;
  /** Semantic replay-compatibility boundary declared by the workflow author. */
  workflowVersion: string;
  /** User-facing description. Excluded from `contractHash()`; included in `revision`. */
  description?: string;
  /** User-facing grouping tags. Excluded from `contractHash()`; included in `revision`. */
  tags?: ReadonlyArray<string>;
  /** Normalized JSON Schema describing accepted workflow input, when declared. */
  inputSchema?: Record<string, unknown>;
  /** Normalized JSON Schema describing the workflow result, when declared. */
  outputSchema?: Record<string, unknown>;
  /** Signal contracts keyed by canonical signal name. */
  signals?: Readonly<Record<string, WorkflowMessageContract>>;
  /** Update contracts keyed by canonical update name. */
  updates?: Readonly<Record<string, WorkflowMessageContract>>;
  /** Query contracts keyed by canonical query name. */
  queries?: Readonly<Record<string, WorkflowMessageContract>>;
  /** Activity contracts keyed by canonical activity name. */
  activities?: Readonly<Record<string, WorkflowActivityContract>>;
  /** Contract of the workflow's definition-level finalizer activity, when declared. */
  finalizer?: WorkflowActivityContract;
}>;

/**
 * Structural shape one signal, update, or query source must satisfy for
 * {@link buildWorkflowContract} to convert it. Deliberately narrower than
 * `SignalDefinition`/`UpdateDefinition`/`QueryDefinition` — only the schema
 * metadata those conversions need — so any of the three handle types (and
 * any structurally equivalent value) satisfies it without a cast.
 *
 * @example
 * ```ts
 * import { signal } from '@lostgradient/weft';
 * import type { WorkflowContractMessageSource } from '@lostgradient/weft';
 *
 * const approval = signal('approval');
 * const source: WorkflowContractMessageSource = approval;
 * console.log(source.inputSchema === undefined);
 * ```
 */
export interface WorkflowContractMessageSource {
  readonly inputSchema?: DefinitionSchema;
  readonly outputSchema?: DefinitionSchema;
}

/**
 * Structural shape one activity or finalizer source must satisfy for
 * {@link buildWorkflowContract} to convert it. Requires `name` — shared with
 * every real activity source type — specifically so a `WorkflowDefinition`'s
 * `finalizer` field (declared as the narrower `AnyActivityDefinition`, which
 * does not itself declare `inputSchema`/`outputSchema`) remains structurally
 * assignable here: TypeScript's weak-type check requires at least one
 * property in common between source and target when every target property is
 * optional, and `name` is that shared property.
 *
 * @example
 * ```ts
 * import { activity } from '@lostgradient/weft';
 * import type { WorkflowContractActivitySource } from '@lostgradient/weft';
 *
 * const charge = activity({ name: 'charge', execute: async (input: number) => input });
 * const source: WorkflowContractActivitySource = charge;
 * console.log(source.name);
 * ```
 */
export interface WorkflowContractActivitySource {
  readonly name: string;
  readonly inputSchema?: DefinitionSchema;
  readonly outputSchema?: DefinitionSchema;
}

/**
 * Authoring-time input accepted by {@link buildWorkflowContract} — the
 * narrowest structural shape that both `WorkflowDefinition` and
 * `BuiltWorkflowDefinition` already satisfy, so neither type is imported here
 * and no coupling is introduced between this module and the workflow builder.
 *
 * @example
 * ```ts
 * import { workflow } from '@lostgradient/weft';
 * import type { WorkflowContractSource } from '@lostgradient/weft';
 *
 * const greet = workflow({ name: 'greet', version: '1.0.0' }).execute(
 *   async function* (_ctx, input: string) {
 *     return `hello ${input}`;
 *   },
 * );
 * const source: WorkflowContractSource = greet;
 * console.log(source.name);
 * ```
 */
export interface WorkflowContractSource {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly tags?: ReadonlyArray<string>;
  readonly inputSchema?: DefinitionSchema;
  readonly outputSchema?: DefinitionSchema;
  readonly signals?: Readonly<Record<string, WorkflowContractMessageSource>>;
  readonly updates?: Readonly<Record<string, WorkflowContractMessageSource>>;
  readonly queries?: Readonly<Record<string, WorkflowContractMessageSource>>;
  readonly activities?: Readonly<Record<string, WorkflowContractActivitySource>>;
  readonly finalizer?: WorkflowContractActivitySource;
}

/**
 * Current workflow revision manifest schema version. An unknown value is
 * rejected by {@link parseWorkflowRevisionManifest} before any other field is
 * read, the same "reject rather than best-effort parse" contract
 * `WORKER_MANIFEST_VERSION` uses.
 *
 * @example
 * ```ts
 * import { WORKFLOW_REVISION_MANIFEST_VERSION } from '@lostgradient/weft';
 *
 * console.log(WORKFLOW_REVISION_MANIFEST_VERSION); // 1
 * ```
 */
export const WORKFLOW_REVISION_MANIFEST_VERSION = 1;

/**
 * A workflow contract paired with its two identity answers: the
 * payload-only `contractHash` and the broader `revision`.
 *
 * `revision` is an opaque label: content-derived by {@link deriveWorkflowRevision}
 * by default, or explicitly supplied. {@link parseWorkflowRevisionManifest}
 * recomputes and checks `contractHash` on every parse, but never recomputes
 * `revision` — an explicitly supplied revision is a caller assertion, not a
 * value this module can verify.
 *
 * @example
 * ```ts
 * import { WORKFLOW_REVISION_MANIFEST_VERSION, buildWorkflowContract } from '@lostgradient/weft';
 * import type { WorkflowRevisionManifest } from '@lostgradient/weft';
 *
 * const contract = buildWorkflowContract({ name: 'checkout', version: '2.1.0' });
 * const manifest: WorkflowRevisionManifest = {
 *   manifestVersion: WORKFLOW_REVISION_MANIFEST_VERSION,
 *   name: contract.name,
 *   workflowVersion: contract.workflowVersion,
 *   revision: 'sha256:placeholder',
 *   contractHash: 'sha256:placeholder',
 *   contract,
 * };
 * console.log(manifest.name);
 * ```
 */
export type WorkflowRevisionManifest = Readonly<{
  /** Manifest schema version; unknown values are rejected, not tolerated. */
  manifestVersion: typeof WORKFLOW_REVISION_MANIFEST_VERSION;
  /** Wire-safe workflow name; must equal `contract.name`. */
  name: string;
  /** Semantic replay-compatibility boundary; must equal `contract.workflowVersion`. */
  workflowVersion: string;
  /** Content-derived or explicitly supplied opaque revision identity. */
  revision: string;
  /** Deterministic payload-only contract identity, verified on every parse. */
  contractHash: string;
  /** The normalized workflow contract this manifest describes. */
  contract: WorkflowContract;
}>;
