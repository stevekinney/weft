/**
 * Operator-configurable gate on which workers may become routing-eligible.
 *
 * Runs after the manifest has been validated and checked for deployment
 * consistency, and before the workerId-hijack guard and registry insertion —
 * so a rejected worker never becomes routing-eligible and never displaces an
 * existing registration. The default (`undefined` on {@link ServeOptions})
 * accepts every worker that already passed authentication, matching the
 * behavior before this policy existed.
 *
 * @module server/worker-admission-policy
 */

import type { WorkerManifest } from '../worker/manifest/types.ts';
import type { Principal } from './principal.ts';

/**
 * Everything a {@link WorkerAdmissionPolicy} needs to decide on one
 * registration attempt.
 *
 * @example
 * ```ts
 * import type { WorkerAdmissionRequest } from '@lostgradient/weft/server';
 *
 * function summarize(request: WorkerAdmissionRequest): string {
 *   return `${request.workerId} -> ${request.manifest.deployment.name}`;
 * }
 * ```
 */
export type WorkerAdmissionRequest = Readonly<{
  /** The authenticated principal, or `undefined` when authentication is disabled. */
  principal: Principal | undefined;
  workerId: string;
  queue: string;
  /** The manifest already validated by `parseWorkerManifest()`. */
  manifest: WorkerManifest;
}>;

/**
 * Outcome of a {@link WorkerAdmissionPolicy} decision.
 *
 * @example
 * ```ts
 * import type { WorkerAdmissionDecision } from '@lostgradient/weft/server';
 *
 * const rejected: WorkerAdmissionDecision = { status: 'rejected', reason: 'unknown fleet' };
 * console.log(rejected.status); // 'rejected'
 * ```
 */
export type WorkerAdmissionDecision =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected'; readonly reason: string };

/**
 * Decide whether a worker registration attempt may proceed.
 *
 * A policy consults the authenticated principal and the accepted manifest —
 * never claims the manifest makes about itself as if they were credentials,
 * since a manifest is worker-asserted data, not proof of identity.
 *
 * @example
 * ```ts
 * import type { WorkerAdmissionPolicy } from '@lostgradient/weft/server';
 *
 * const onlyBilling: WorkerAdmissionPolicy = ({ manifest }) =>
 *   manifest.deployment.name === 'billing'
 *     ? { status: 'accepted' }
 *     : { status: 'rejected', reason: 'only the billing deployment may register' };
 * ```
 */
export type WorkerAdmissionPolicy = (request: WorkerAdmissionRequest) => WorkerAdmissionDecision;
