/**
 * The two construction-time capability gates described in
 * [ADR 0002 § Construction-time capability gates](../../../documentation/contributing/architecture-decisions/0002-multiengine-per-workflow-ownership.md#construction-time-capability-gates):
 *
 * - **Gate 1 — storage capability.** Fails fast when the configured storage
 *   backend does not support `conditionalBatch`, naming the *configured*
 *   fencing mode in the diagnostic rather than a hardcoded one, so an operator
 *   troubleshooting the shipped `ownership: 'lease'` is not sent chasing
 *   `workflow-lease`, which is unimplemented until a later stage.
 * - **Gate 2 — ownership-mode marker.** Stamps or verifies the store-wide
 *   `ownership-mode-marker` singleton so `ownership: 'lease'` and
 *   `ownership: 'workflow-lease'` remain mutually exclusive across engine
 *   *processes*, not merely within one process.
 *
 * Both gates fire only for the two fencing modes (`'lease'` and
 * `'workflow-lease'`); `ownership: 'none'` never touches the marker or checks
 * the capability. {@link bootstrapOwnershipGates} runs them in the ADR's
 * required order (Gate 1 then Gate 2) and is the unit later wired in front of
 * claim acquisition, recovery scanning, scheduler polling, and task polling —
 * that wiring is a later stage and is deliberately not done here.
 *
 * @module core/engine/ownership-mode-marker
 */

import {
  KEYS,
  requireStorageCapability,
  storageConditionalBatch,
  type Storage,
} from '../../storage/interface.ts';
import { OwnershipModeMismatchError } from './lease-errors.ts';
import {
  decodeOwnershipModeMarker,
  encodeOwnershipModeMarker,
  type FencingOwnershipMode,
  type OwnershipModeMarkerRecord,
} from './workflow-claim-codec.ts';

/**
 * Mirrors the full `ownership` discriminant (`EngineConstructorOptions.ownership`
 * / `ResolvedOptions.ownershipMode`). Duplicated here as a literal union rather
 * than imported, because neither call site exports a standalone name for it —
 * importing `ResolvedOptions` would pull in the whole engine-internal-types
 * surface for one field's type.
 */
export type EngineOwnershipMode = 'none' | 'lease' | 'workflow-lease';

/**
 * Gate 1 — storage capability. Fires for `ownership: 'lease'` or
 * `ownership: 'workflow-lease'`; reuses the existing, untyped `Error` that
 * {@link requireStorageCapability} already throws. The diagnostic names the
 * mode that is actually configured — hardcoding `'workflow-lease'` into the
 * message would misdirect an operator troubleshooting the shipped global
 * lease toward an unimplemented feature.
 */
export function assertOwnershipStorageCapability(
  storage: Storage,
  configuredMode: FencingOwnershipMode,
): void {
  requireStorageCapability(storage, 'conditionalBatch', `ownership: '${configuredMode}'`);
}

/**
 * Read the store-wide ownership-mode marker, distinguishing genuine absence
 * (`storage.get` returned `null`) from corruption (bytes are present but do
 * not decode as a valid `{ mode, establishedAt }` record).
 *
 * A corrupt marker is deliberately NOT treated as absent. `acquire`-on-absent
 * exists so the *first* fencing-mode engine against a fresh store gets to
 * establish the mode every later engine must agree with. If corrupt bytes
 * were treated as absent, any engine that happened to read the marker after
 * it was damaged — by a bug, a manual edit, or a future build writing a shape
 * this one cannot parse — would silently re-stamp it with its own configured
 * mode and overwrite whatever the real prior engines agreed on, defeating the
 * marker's entire purpose of making a mode mismatch detectable. Failing
 * closed here is the same fail-closed discipline `EngineLeaseCorruptedError`
 * already applies to a corrupt global-lease epoch.
 */
async function readOwnershipModeMarkerOrThrowIfCorrupt(
  storage: Storage,
  markerKey: string,
): Promise<OwnershipModeMarkerRecord | null> {
  const bytes = await storage.get(markerKey);
  if (bytes === null) return null;
  const decoded = decodeOwnershipModeMarker(bytes);
  if (decoded === null) {
    throw new Error(
      `The store's ownership-mode-marker ("${markerKey}") exists but does not decode as a valid ` +
        '{ mode, establishedAt } record. Treating an undecodable marker as absent would let this ' +
        "engine silently overwrite whatever mode the store's real prior engines agreed on, " +
        "defeating the marker's purpose of making a mixed fencing-mode deployment detectable. " +
        'Resolve by operator repair: inspect the stored bytes and, only if certain no other ' +
        'engine relies on them, delete the key so a fresh marker can be established.',
    );
  }
  return decoded;
}

/** Throw {@link OwnershipModeMismatchError} when the stored mode disagrees with this engine's. */
function assertOwnershipModeMatches(
  configuredMode: FencingOwnershipMode,
  storedRecord: OwnershipModeMarkerRecord,
): void {
  if (storedRecord.mode !== configuredMode) {
    throw new OwnershipModeMismatchError(
      configuredMode,
      storedRecord.mode,
      storedRecord.establishedAt,
    );
  }
}

/** Input to {@link assertOwnershipModeMarker}. */
export type AssertOwnershipModeMarkerInput = {
  storage: Storage;
  /** This engine's configured fencing mode. */
  configuredMode: FencingOwnershipMode;
  /** Engine-clock source (ms), injected so tests can control `establishedAt` deterministically. */
  getNow: () => number;
};

/**
 * Gate 2 — ownership-mode marker. Fires immediately after Gate 1 passes, for
 * the same trigger (`ownership: 'lease'` or `ownership: 'workflow-lease'`;
 * `ownership: 'none'` never calls this).
 *
 * Reads `KEYS.ownershipModeMarker()`. If absent, `conditionalBatch`-puts
 * `{ mode: configuredMode, establishedAt: now() }` with an expected value of
 * `null` — the first fencing-mode engine against a fresh store establishes
 * the mode every later one must agree with. On a CAS loss (another engine won
 * the race to stamp it), re-reads and compares against that engine's mode
 * instead, since it is now authoritative. If the stored mode — from either
 * the initial read or the post-CAS-loss re-read — differs from this engine's
 * configured mode, throws {@link OwnershipModeMismatchError} before any
 * further construction proceeds.
 */
export async function assertOwnershipModeMarker(
  input: AssertOwnershipModeMarkerInput,
): Promise<void> {
  const { storage, configuredMode, getNow } = input;
  const markerKey = KEYS.ownershipModeMarker();

  const initial = await readOwnershipModeMarkerOrThrowIfCorrupt(storage, markerKey);
  if (initial !== null) {
    assertOwnershipModeMatches(configuredMode, initial);
    return;
  }

  const applied = await storageConditionalBatch(
    storage,
    [{ key: markerKey, expectedValue: null }],
    [
      {
        type: 'put',
        key: markerKey,
        value: encodeOwnershipModeMarker({ mode: configuredMode, establishedAt: getNow() }),
      },
    ],
  );
  if (applied) return;

  // Lost the race to stamp a fresh marker: another engine's write landed first.
  // Its mode is authoritative — re-read and compare against it.
  const reread = await readOwnershipModeMarkerOrThrowIfCorrupt(storage, markerKey);
  if (reread === null) {
    // The marker we just lost a CAS against is now genuinely absent again. This
    // is not the ordinary "another engine stamped it" race — that leaves the key
    // present — but a concurrent deletion during construction (for example, an
    // operator's documented administrative removal happening mid-boot). There is
    // no mode left to compare against, so fail closed rather than silently
    // re-attempting and risking a second, unbounded CAS loop against a moving key.
    throw new Error(
      `Lost the compare-and-swap while establishing the store's ownership-mode-marker ` +
        `("${markerKey}"), and a re-read then found it absent again. This indicates the marker ` +
        "was deleted concurrently during construction rather than raced by another engine's " +
        'write (which would have left it present). Retry construction once the concurrent ' +
        'deletion has settled.',
    );
  }
  assertOwnershipModeMatches(configuredMode, reread);
}

/** Input to {@link bootstrapOwnershipGates}. */
export type BootstrapOwnershipGatesInput = {
  storage: Storage;
  ownershipMode: EngineOwnershipMode;
  /** Engine-clock source (ms), injected so tests can control `establishedAt` deterministically. */
  getNow: () => number;
};

/**
 * Run Gate 1 then Gate 2, in that order, as ADR 0002 requires. No-op for
 * `ownership: 'none'`, which never touches storage-capability enforcement or
 * the mode marker. Both gates must complete successfully before any claim
 * acquisition, recovery scan, scheduler poll, or task poll proceeds — but
 * wiring this into `Engine` construction or any of those call sites is a
 * later stage; this function is the standalone, testable unit only.
 */
export async function bootstrapOwnershipGates(input: BootstrapOwnershipGatesInput): Promise<void> {
  const { storage, ownershipMode, getNow } = input;
  if (ownershipMode === 'none') return;
  assertOwnershipStorageCapability(storage, ownershipMode);
  await assertOwnershipModeMarker({ storage, configuredMode: ownershipMode, getNow });
}
