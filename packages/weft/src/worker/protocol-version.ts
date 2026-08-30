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
 * **Version 3** (Canonical Worker Manifest, WFT-27) replaces the register
 * message's parallel top-level identity fields (`activities`, `queue`,
 * `deploymentName`, `buildId`, `runtimeVersion`, `gitSha`, `capabilities`)
 * with a single `manifest: WorkerManifest` field, and the ack echoes
 * `acceptedManifestDigest` plus `serverCapabilities` instead of echoing
 * `activities` back. Both directions of the handshake reshape — a strictly
 * larger change than version 2's same-shape/different-semantics bump — so
 * this is a clean break rather than a negotiated one: a v2 peer gets the
 * canonical `WorkerProtocolIncompatibleError`, not a confusing
 * `invalid_registration`.
 *
 * @example
 * ```ts
 * import { REMOTE_WORKER_PROTOCOL_VERSION } from '@lostgradient/weft/worker-protocol';
 *
 * const registration = { type: 'register', protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION };
 * ```
 */
export const REMOTE_WORKER_PROTOCOL_VERSION = 3;

/**
 * Lowest RemoteWorker protocol version accepted by this package.
 *
 * @example
 * ```ts
 * import { REMOTE_WORKER_MIN_PROTOCOL_VERSION } from '@lostgradient/weft/worker-protocol';
 *
 * const supportsCurrentVersion = REMOTE_WORKER_MIN_PROTOCOL_VERSION === 3;
 * ```
 */
export const REMOTE_WORKER_MIN_PROTOCOL_VERSION = 3;

/**
 * Highest RemoteWorker protocol version accepted by this package.
 *
 * @example
 * ```ts
 * import { REMOTE_WORKER_MAX_PROTOCOL_VERSION } from '@lostgradient/weft/worker-protocol';
 *
 * const canUseRequestedVersion = 3 <= REMOTE_WORKER_MAX_PROTOCOL_VERSION;
 * ```
 */
export const REMOTE_WORKER_MAX_PROTOCOL_VERSION = 3;

/**
 * Explicit supported RemoteWorker protocol versions.
 *
 * @example
 * ```ts
 * import { REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS } from '@lostgradient/weft/worker-protocol';
 *
 * const supported = REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS.includes(3);
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
 * const version: RemoteWorkerProtocolVersion = 3;
 * ```
 */
export type RemoteWorkerProtocolVersion =
  (typeof REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS)[number];
