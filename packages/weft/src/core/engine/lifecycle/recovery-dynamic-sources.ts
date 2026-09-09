/**
 * The `recoverAll()` batch-wide dynamic-source preload barrier (WFT-15/16):
 * "preload every dynamic revision referenced by non-terminal state before
 * advancing any generator." Split out of `transition.ts`, which has no
 * headroom under the repository's 500-line implementation-file ceiling for
 * this logic inline.
 *
 * @module core/engine/lifecycle/recovery-dynamic-sources
 */

import { DynamicWorkflowSourceUnavailableError } from '../dynamic-source-errors.ts';
import { EngineDisposedError } from '../errors.ts';
import type { EngineInternals } from '../internals.ts';
import type { LifecycleCallbacks } from './shared.ts';

/**
 * Preload every distinct `recoverableTypes` entry that is not already an
 * eager registration (which resolves synchronously and needs no preload),
 * concurrently, one loader invocation per distinct type even when many
 * non-terminal runs share it. Returns a `type -> DynamicWorkflowSourceUnavailableError`
 * map; `recoverAll()` (`transition.ts`) closes over it in a
 * batch-local `createRecoveryScopedCallbacks()` wrapper — never a field on
 * shared `internals` — for the duration of its per-entry loop, rather than
 * failing a matched type directly: every entry, failed type or not, still
 * goes through `recoverEntryOrIsolateFailure()` -> `resume()`, so a cached
 * failure here commits AFTER claim acquisition and terminal-cleanup
 * tracking, exactly like the existing `VersionMismatchError` isolation.
 * Because the map lives only in that one closure, a concurrent, unrelated
 * `engine.start()`/`engine.resume()` call — or a second concurrent
 * `recoverAll()` batch — never observes it. A disposal mid-preload aborts
 * the whole barrier by rethrowing, matching
 * `recoverEntryOrIsolateFailure`'s own un-isolated treatment of
 * {@link EngineDisposedError}.
 */
export async function preloadRecoverableDynamicSourceTypes(
  internals: EngineInternals,
  callbacks: LifecycleCallbacks,
  recoverableTypes: readonly string[],
): Promise<Map<string, DynamicWorkflowSourceUnavailableError>> {
  const distinctLazyTypes = new Set<string>();
  for (const type of recoverableTypes) {
    if (!internals.registrations.has(type)) distinctLazyTypes.add(type);
  }

  const failures = new Map<string, DynamicWorkflowSourceUnavailableError>();
  if (distinctLazyTypes.size === 0) return failures;

  const types = [...distinctLazyTypes];
  const results = await Promise.allSettled(
    types.map((type) => callbacks.resolveExecutableRegistration(type)),
  );
  for (const [index, result] of results.entries()) {
    if (result.status !== 'rejected') continue;
    const type = types[index]!;
    const reason: unknown = result.reason;
    if (reason instanceof EngineDisposedError) throw reason;
    failures.set(
      type,
      reason instanceof DynamicWorkflowSourceUnavailableError
        ? reason
        : new DynamicWorkflowSourceUnavailableError(type, undefined, 'load-failed', reason),
    );
  }
  return failures;
}
