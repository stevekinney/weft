import { type CatalogSnapshot } from "../embedded/backchannel/src/index.ts";
import {
  type ErasedOperation,
  snapshotOperationCatalog,
} from "../embedded/backchannel/src/internals.ts";
import { createLiveOperationRegistry, createLiveRestBindings } from './rest-bindings.ts';

/**
 * Capture the operation surface as a {@link CatalogSnapshot}, defaulting to
 * every operation this build registers.
 *
 * The result is deterministic — operations sorted by name, schemas normalised
 * — so two snapshots of the same build are byte-identical and a real surface
 * change is the only thing that shows up in a diff. That is what makes it safe
 * to commit one and regenerate clients from it.
 *
 * Pass `sourceOperations` to snapshot a deliberately narrowed set, which is
 * mainly useful in tests that assert on one operation's recorded shape.
 *
 * @example
 * ```ts
 * import { createCatalogSnapshot } from '@lostgradient/weft';
 *
 * const snapshot = createCatalogSnapshot();
 * const destructive = snapshot.operations
 *   .filter((operation) => operation.destructive)
 *   .map((operation) => operation.name);
 *
 * console.log('guard these behind confirmation:', destructive);
 * ```
 */
export function createCatalogSnapshot(
  sourceOperations: ReadonlyArray<ErasedOperation> = createLiveOperationRegistry().list(),
): CatalogSnapshot {
  return snapshotOperationCatalog({
    operations: sourceOperations,
    restBindings: createLiveRestBindings(),
  });
}
