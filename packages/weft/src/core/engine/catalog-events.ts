/**
 * Shared installed/activated/draining event-dispatch helper (WFT-12), used
 * by BOTH producers of catalog activation: `catalog-readiness.ts`'s
 * `drainPendingCatalogInstalls` (the `engine.register()`-drain path) and
 * `catalog-activation.ts`'s `activateCatalogRevisionCandidate` (the guarded
 * primitive). The two producers return different result shapes
 * (`activateRegistered` always succeeds and returns a bare pointer;
 * `activateCandidate` returns a union that can also refuse) — this helper
 * takes already-normalized before/after pointer values instead of either
 * raw return type, so it stays agnostic to which producer called it.
 * `activation-rejected` is NOT dispatched here — only `activateCandidate`
 * can refuse, so its one caller dispatches that event itself.
 *
 * @module core/engine/catalog-events
 */

import type { WorkflowCatalogActivePointer } from '../catalog/index.ts';
import {
  WorkflowRevisionActivatedEvent,
  WorkflowRevisionDrainingEvent,
  WorkflowRevisionInstalledEvent,
} from '../events/catalog-events.ts';
import type { Engine } from './index.ts';

/**
 * Dispatch `catalog:revision-installed` (only when `preExisting` is
 * `false` — genuinely new content, not a byte-identical reinstall or a
 * cross-process durable adoption of already-present content), then decide
 * activated/draining from how `pointerBefore` and `pointerAfter` compare:
 *
 * - Identical `revision` AND `generation` (a true no-op — nothing was
 *   durably written, e.g. `activateRegistered`'s own no-op branch): neither
 *   fires.
 * - Same `revision`, different `generation` (a reactivation that still
 *   bumped the fencing counter, e.g. `activateCandidate` re-activating the
 *   currently active revision): `catalog:revision-activated` fires with
 *   `previousRevision: undefined` — nothing was actually displaced, so
 *   there is nothing to drain.
 * - Different `revision`: `catalog:revision-draining` for `pointerBefore`
 *   (when it existed) followed by `catalog:revision-activated` for
 *   `pointerAfter`, `previousRevision` set to the displaced revision.
 */
export function dispatchCatalogInstallAndActivatedEvents(
  engine: Engine,
  name: string,
  revision: string,
  preExisting: boolean,
  pointerBefore: WorkflowCatalogActivePointer | null,
  pointerAfter: WorkflowCatalogActivePointer,
): void {
  if (!preExisting) {
    engine.dispatchEvent(new WorkflowRevisionInstalledEvent(name, revision));
  }

  const unchanged =
    pointerBefore !== null &&
    pointerBefore.revision === pointerAfter.revision &&
    pointerBefore.generation === pointerAfter.generation;
  if (unchanged) {
    return;
  }

  const previousRevision =
    pointerBefore !== null && pointerBefore.revision !== pointerAfter.revision
      ? pointerBefore.revision
      : undefined;
  if (previousRevision !== undefined) {
    engine.dispatchEvent(new WorkflowRevisionDrainingEvent(name, previousRevision));
  }

  engine.dispatchEvent(
    new WorkflowRevisionActivatedEvent(
      name,
      pointerAfter.revision,
      pointerAfter.generation,
      previousRevision,
    ),
  );
}
