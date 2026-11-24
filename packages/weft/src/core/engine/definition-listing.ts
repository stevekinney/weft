/**
 * Describe every workflow type an engine can run, whether it was registered
 * with `register()` (a code type) or `registerSource()` (a source type), so a
 * caller can render a definitions catalog without stitching `weft.system.registry`,
 * `weft.workflows.revisions.list`, and `weft.catalog.sources.list` together.
 *
 * Reads process-local registration state and the catalog's installed records.
 * It never runs a source loader: a source that has not been loaded reports its
 * load state and no contract.
 *
 * `origin` records how Weft came to know the type. It says nothing about who
 * authored it.
 *
 * @module core/engine/definition-listing
 */

import { compareCodepoint } from '../compare-codepoint.ts';
import type { WorkflowContract } from '../contract/types.ts';
import type { FailureCategory } from '../types/identity.ts';
import { ensureWorkflowCatalogReady, getWorkflowCatalog } from './catalog-readiness.ts';
import type { Engine } from './index.ts';
import { getInternals, type EngineInternals } from './internals.ts';
import type { SourceLoadState } from './source-runtime-state.ts';

/** How Weft learned of a workflow type: `register()` (`code`) or `registerSource()` (`source`). */
export type WorkflowDefinitionOrigin = 'code' | 'source';

/** `ready` for a code type or a loaded source; otherwise the source's load state. */
export type WorkflowDefinitionState = SourceLoadState;

/** One workflow type, summarised. */
export type WorkflowDefinitionSummary = Readonly<{
  name: string;
  origin: WorkflowDefinitionOrigin;
  state: WorkflowDefinitionState;
  /** The category of the last load failure when `state` is `failed`; otherwise `null`. */
  lastFailureCategory: FailureCategory | null;
  /**
   * The revision a new instance would run: a code type's registered revision,
   * a source's only registered revision, or the active one when a source has
   * several. `null` when several are registered and none is active.
   */
  revision: string | null;
  /** The remaining fields are `null` unless `state` is `ready`. */
  workflowVersion: string | null;
  description: string | null;
  tags: readonly string[] | null;
  signals: readonly string[] | null;
  updates: readonly string[] | null;
  queries: readonly string[] | null;
}>;

/** A {@link WorkflowDefinitionSummary} with the full contract of its active revision. */
export type WorkflowDefinitionDetail = WorkflowDefinitionSummary &
  Readonly<{
    contractHash: string | null;
    contract: WorkflowContract | null;
  }>;

/** One page of {@link WorkflowDefinitionSummary} entries, ordered by name. */
export type WorkflowDefinitionPage = Readonly<{
  definitions: readonly WorkflowDefinitionSummary[];
  /** Present when more entries follow. */
  nextOffset?: number;
}>;

function definitionNames(internals: EngineInternals): Map<string, WorkflowDefinitionOrigin> {
  const origins = new Map<string, WorkflowDefinitionOrigin>();
  for (const name of internals.registrations.keys()) origins.set(name, 'code');
  for (const name of internals.sources.byName.keys()) {
    if (!origins.has(name)) origins.set(name, 'source');
  }
  return origins;
}

/** The revision a new instance of source type `name` would run, or `null` when it is ambiguous. */
async function sourceRevision(engine: Engine, name: string): Promise<string | null> {
  const byRevision = getInternals(engine).sources.byName.get(name);
  if (byRevision === undefined) return null;
  if (byRevision.size === 1) return [...byRevision.keys()][0]!;
  const active = await getWorkflowCatalog(engine).resolveActiveDurable(name);
  return active !== undefined && byRevision.has(active.revision) ? active.revision : null;
}

function messageNames(messages: WorkflowContract['signals'] | undefined): readonly string[] {
  return Object.keys(messages ?? {}).toSorted(compareCodepoint);
}

/** The revision a new instance of `name` would run, or `null` when none can be named. */
function resolveRevision(
  engine: Engine,
  name: string,
  origin: WorkflowDefinitionOrigin,
): Promise<string | null> {
  if (origin === 'source') return sourceRevision(engine, name);
  return Promise.resolve(getInternals(engine).registeredCatalogRevisions.get(name) ?? null);
}

/** A source's load state and failure category, from its diagnostics for `revision`. */
function sourceLoadState(
  engine: Engine,
  name: string,
  revision: string,
): Pick<WorkflowDefinitionSummary, 'state' | 'lastFailureCategory'> {
  const diagnostics = getInternals(engine).sources.diagnostics.get(name)?.get(revision);
  const state = diagnostics?.state ?? 'idle';
  const category = state === 'failed' ? diagnostics?.lastFailureCategory : undefined;
  return { state, lastFailureCategory: category ?? null };
}

/**
 * A code type is always `ready`. A source reports the load state of the
 * revision that would run, except that one already resolved in this process is
 * `ready` whatever its diagnostic says: a load whose only waiter gave up keeps
 * running, installs the revision, and still leaves a `cancelled` diagnostic.
 */
function resolveState(
  engine: Engine,
  name: string,
  origin: WorkflowDefinitionOrigin,
  revision: string | null,
): Pick<WorkflowDefinitionSummary, 'state' | 'lastFailureCategory'> {
  const ready = { state: 'ready', lastFailureCategory: null } as const;
  if (origin === 'code') return ready;
  if (revision === null) return { state: 'idle', lastFailureCategory: null };
  const resolved = getInternals(engine).sources.resolved.get(name)?.get(revision);
  return resolved === undefined ? sourceLoadState(engine, name, revision) : ready;
}

type ContractFields = Pick<
  WorkflowDefinitionDetail,
  | 'workflowVersion'
  | 'description'
  | 'tags'
  | 'signals'
  | 'updates'
  | 'queries'
  | 'contractHash'
  | 'contract'
>;

const NO_CONTRACT: ContractFields = {
  workflowVersion: null,
  description: null,
  tags: null,
  signals: null,
  updates: null,
  queries: null,
  contractHash: null,
  contract: null,
};

/** The contract-derived fields of a `ready` revision, read from the catalog without loading anything. */
async function readContractFields(
  engine: Engine,
  name: string,
  revision: string | null,
): Promise<ContractFields> {
  if (revision === null) return NO_CONTRACT;
  const record = await getWorkflowCatalog(engine).resolveEntry(name, revision);
  if (record === undefined) return NO_CONTRACT;
  const { manifest } = record;
  const { contract } = manifest;
  return {
    workflowVersion: manifest.workflowVersion,
    description: contract.description ?? null,
    tags: [...(contract.tags ?? [])],
    signals: messageNames(contract.signals),
    updates: messageNames(contract.updates),
    queries: messageNames(contract.queries),
    contractHash: manifest.contractHash,
    contract,
  };
}

async function describeDefinition(
  engine: Engine,
  name: string,
  origin: WorkflowDefinitionOrigin,
): Promise<WorkflowDefinitionDetail> {
  const revision = await resolveRevision(engine, name, origin);
  const state = resolveState(engine, name, origin, revision);
  const fields =
    state.state === 'ready' ? await readContractFields(engine, name, revision) : NO_CONTRACT;
  // A `ready` entry always carries its contract. A source loaded in this process
  // whose revision was since removed from the catalog has none to carry, and the
  // next start would load and install it again, so it reports as `idle`.
  const withheld = origin === 'source' && state.state === 'ready' && fields.contract === null;
  return {
    name,
    origin,
    ...(withheld ? { state: 'idle', lastFailureCategory: null } : state),
    revision,
    ...fields,
  };
}

function toSummary(detail: WorkflowDefinitionDetail): WorkflowDefinitionSummary {
  const { contractHash: _contractHash, contract: _contract, ...summary } = detail;
  return summary;
}

/**
 * List workflow types ordered by name (code-point order). `limit` defaults to
 * 100 and `offset` to 0; the caller bounds `limit`.
 */
export async function listWorkflowDefinitions(
  engine: Engine,
  options: { limit?: number | undefined; offset?: number | undefined } = {},
): Promise<WorkflowDefinitionPage> {
  await ensureWorkflowCatalogReady(engine);
  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;
  const origins = definitionNames(getInternals(engine));
  const names = [...origins.keys()].toSorted(compareCodepoint);
  const page = names.slice(offset, offset + limit);
  const definitions = await Promise.all(
    page.map(async (name) => toSummary(await describeDefinition(engine, name, origins.get(name)!))),
  );
  return {
    definitions,
    ...(offset + page.length < names.length ? { nextOffset: offset + page.length } : {}),
  };
}

/** One workflow type with the full contract of its active revision, or `undefined` for an unknown name. */
export async function describeWorkflowDefinition(
  engine: Engine,
  name: string,
): Promise<WorkflowDefinitionDetail | undefined> {
  await ensureWorkflowCatalogReady(engine);
  const origin = definitionNames(getInternals(engine)).get(name);
  return origin === undefined ? undefined : describeDefinition(engine, name, origin);
}
