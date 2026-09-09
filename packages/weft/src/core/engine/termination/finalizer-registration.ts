import { DynamicWorkflowSourceUnavailableError } from '../dynamic-source-errors.ts';
import {
  getResolvedDynamicRegistration,
  resolveExecutableRegistration,
} from '../dynamic-source-execution.ts';
import type { Engine } from '../index.ts';
import type { EngineInternals } from '../internals.ts';
import type { RunnableFinalizer } from './finalizer-activity.ts';

/**
 * Resolve `type`'s `finalizer`, awaiting a full dynamic-source resolve when
 * `type` is `registerSource()`-registered but unresolved on this process —
 * {@link getResolvedDynamicRegistration}'s sync-only lookup cannot close that
 * gap. Without this, a type never started/resumed/recovered here after a
 * fresh restart (only torn down) rearms its `wf-teardown:` timer forever,
 * since nothing else triggers the resolve `lastResolvedRevisionByName`
 * needs. Returns `undefined` (rearm) when `type` has no registration at
 * all, or when the resolve itself fails — a load failure here doesn't fail
 * the (already terminal) workflow, it just defers to the next self-heal
 * attempt.
 */
export async function resolveFinalizerRegistration(
  internals: EngineInternals,
  type: string,
): Promise<RunnableFinalizer | undefined> {
  const eagerOrAlreadyResolved = getResolvedDynamicRegistration(internals, type)?.finalizer;
  if (eagerOrAlreadyResolved !== undefined) {
    return eagerOrAlreadyResolved;
  }
  if (!internals.sources.byName.has(type)) {
    return undefined;
  }
  try {
    const { entry } = await resolveExecutableRegistration(
      internals.engine as unknown as Engine,
      internals,
      type,
    );
    return entry.finalizer;
  } catch (error) {
    if (error instanceof DynamicWorkflowSourceUnavailableError) {
      return undefined;
    }
    throw error;
  }
}
