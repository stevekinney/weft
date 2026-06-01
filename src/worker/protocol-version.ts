/**
 * Canonical RemoteWorker wire protocol version constants.
 *
 * Lives in a leaf module so both the parser implementation (`protocol.ts`) and
 * the JSON Schema declarations (`protocol-schemas.ts`) can depend on the
 * version without forming an import cycle.
 *
 * @module worker/protocol-version
 */

/**
 * Current RemoteWorker wire protocol version.
 *
 * **Version 2** (Phase 4 of the workflow-builder refactor) bumps the semantics
 * of the `activities: string[]` field in the register message. Each entry is
 * now a qualified `${workflowType}.${activityName}` name rather than a bare
 * activity name, so the server can dispatch the correct workflow's activity
 * implementation when the same activity key is used by multiple workflows. The
 * wire shape did not change; only the meaning of the strings.
 *
 * @example
 * ```ts
 * import { REMOTE_WORKER_PROTOCOL_VERSION } from '@lostgradient/weft/worker-protocol';
 *
 * const registration = { type: 'register', protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION };
 * ```
 */
export const REMOTE_WORKER_PROTOCOL_VERSION = 2;

/**
 * Lowest RemoteWorker protocol version accepted by this package.
 *
 * @example
 * ```ts
 * import { REMOTE_WORKER_MIN_PROTOCOL_VERSION } from '@lostgradient/weft/worker-protocol';
 *
 * const supportsCurrentVersion = REMOTE_WORKER_MIN_PROTOCOL_VERSION === 2;
 * ```
 */
export const REMOTE_WORKER_MIN_PROTOCOL_VERSION = 2;

/**
 * Highest RemoteWorker protocol version accepted by this package.
 *
 * @example
 * ```ts
 * import { REMOTE_WORKER_MAX_PROTOCOL_VERSION } from '@lostgradient/weft/worker-protocol';
 *
 * const canUseRequestedVersion = 2 <= REMOTE_WORKER_MAX_PROTOCOL_VERSION;
 * ```
 */
export const REMOTE_WORKER_MAX_PROTOCOL_VERSION = 2;

/**
 * Explicit supported RemoteWorker protocol versions.
 *
 * @example
 * ```ts
 * import { REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS } from '@lostgradient/weft/worker-protocol';
 *
 * const supported = REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS.includes(2);
 * ```
 */
export const REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS = [REMOTE_WORKER_PROTOCOL_VERSION] as const;

/**
 * RemoteWorker protocol version accepted by this package.
 *
 * @example
 * ```ts
 * import type { RemoteWorkerProtocolVersion } from '@lostgradient/weft/worker-protocol';
 *
 * const version: RemoteWorkerProtocolVersion = 2;
 * ```
 */
export type RemoteWorkerProtocolVersion =
  (typeof REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS)[number];
