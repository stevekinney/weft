/**
 * Unconditionally activate one `registerSource()` revision, the dynamic-source
 * counterpart to the activation `engine.register()` performs for a code
 * workflow.
 *
 * `engine.workflows.activate()` is the guarded primitive: it refuses a
 * candidate whose `workflowVersion` differs from the active revision's,
 * because activating it advertises a replay-incompatible change. A host that
 * supplies a new revision of a workflow it owns is making the same decision a
 * deploy makes when it re-registers changed code, and that path moves the
 * active pointer without consulting compatibility
 * (`WorkflowCatalog.activateRegistered`). Runs that started on the previous
 * revision stay pinned to it, so nothing is replayed against new code.
 *
 * @module core/engine/source-activation
 */

import type { WorkflowCatalogActivePointer } from '../catalog/index.ts';
import { dispatchCatalogInstallAndActivatedEvents } from './catalog-events.ts';
import { ensureWorkflowCatalogReady, getWorkflowCatalog } from './catalog-readiness.ts';
import { copyWorkflowDefinition } from './construction.ts';
import type { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { buildRegistrationEntry } from './registration.ts';
import { resolveWorkflowSourceForExecution } from './source-resolution.ts';

/**
 * Load and install `(name, revision)`, then make it the revision new instances
 * of `name` run, whatever the previous active revision's contract was. Returns
 * the new active pointer. The revision must have been registered with
 * `registerSource()` on this engine.
 */
export async function activateRegisteredSourceRevision(
  engine: Engine,
  name: string,
  revision: string,
): Promise<WorkflowCatalogActivePointer> {
  await ensureWorkflowCatalogReady(engine);
  const catalog = getWorkflowCatalog(engine);
  // Read before resolving: loading a source installs it without announcing it,
  // so whether `catalog:revision-installed` is owed depends on the state before.
  const preExisting = await catalog.hasInstalled(name, revision);
  const record = await resolveWorkflowSourceForExecution(engine, name, revision);
  const resolved = getInternals(engine).sources.resolved.get(name)?.get(revision);
  if (resolved === undefined) {
    throw new Error(
      `Workflow source "${name}" revision "${revision}" resolved without a local definition`,
    );
  }
  const definition = copyWorkflowDefinition(
    name,
    buildRegistrationEntry(name, resolved.definition),
  );
  const pointerBefore = (await catalog.resolveActiveDurable(name)) ?? null;
  const pointerAfter = await catalog.activateRegistered(name, record.manifest, definition);
  dispatchCatalogInstallAndActivatedEvents(
    engine,
    name,
    revision,
    preExisting,
    pointerBefore,
    pointerAfter,
  );
  return pointerAfter;
}
