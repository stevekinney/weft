/**
 * The host-facing factory for `serve({ conformanceTargets })` (COR-1365).
 *
 * It lives in the testing subpath rather than the package root because
 * running a target spawns worker processes: the root entry must stay free of
 * `Bun.spawn` so it still bundles for the browser (COR-1192), and `serve()`
 * itself only accepts the {@link ConformanceTargetRunner} this returns.
 *
 * @module testing/conformance-targets
 */

import {
  createConformanceTargetRunner,
  type ConformanceTargetRunner,
  type ConformanceTargets,
} from '../conformance/targets.ts';
import { serve } from '../server/index.ts';

/**
 * Validate `targets` and build the runner `serve({ conformanceTargets })`
 * serves `weft.conformance.targets` and `weft.conformance.report` from.
 *
 * Throws a `TypeError` for a target name that is not 1-128 characters of
 * letters, digits, `.`, `_`, or `-`, an empty command or argument, or a
 * timeout that is not a positive integer. The targets are copied, so mutating
 * `targets` afterwards does not change what a request can run.
 *
 * @example
 * ```ts
 * import { Engine, MemoryStorage, serve } from '@lostgradient/weft';
 * import { createConformanceTargets } from '@lostgradient/weft/testing';
 *
 * const engine = new Engine({ storage: new MemoryStorage() });
 * await using server = serve({
 *   engine,
 *   conformanceTargets: createConformanceTargets({
 *     'python-sdk': { command: ['python', '-m', 'my_worker'], timeoutMs: 15_000 },
 *   }),
 * });
 * ```
 */
export function createConformanceTargets(targets: ConformanceTargets): ConformanceTargetRunner {
  return createConformanceTargetRunner(targets, serve);
}
