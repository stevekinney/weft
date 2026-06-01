/**
 * Public testing primitives for weft consumers.
 *
 * Imported via `@lostgradient/weft/testing` to keep production bundles free of
 * test-only code. Re-exports {@link TestEngine}, {@link TimeControl},
 * {@link ActivityMockRegistry}, and the chaos helpers.
 *
 * @module @lostgradient/weft/testing
 */

// Bun 1.3.13 minifier workaround: pure re-export barrels
// (`export { X } from './m'`) emit invalid JavaScript with undeclared
// identifiers in `dist/`. Loading the bundle from Node throws
// `Export 'd' is not defined in module`. Rebinding each value to a
// local const before re-exporting forces the bundler to keep the
// reference live. Verified by reverting to direct re-exports:
// `bun run build && node -e "import('./dist/testing/index.js')"` fails.
// Remove this workaround once Bun ships the fix and CI proves a clean
// build with direct re-exports.
import { ChaosNonRetryableError, ChaosTimeoutError, ChaosTransientError, withChaos } from './chaos';
import { ActivityMockRegistry } from './mocks';
import { killAndReboot, spawnServerSubprocess, withSubprocessServer } from './subprocess-engine';
import { TestEngine } from './test-engine';
import { TimeControl } from './time-control';

/**
 * Re-exported {@link ActivityMockRegistry}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { ActivityMockRegistry } from '@lostgradient/weft/testing';
 * const registry = new ActivityMockRegistry();
 * void registry;
 * ```
 */
const exportedActivityMockRegistry = ActivityMockRegistry;

/**
 * Re-exported {@link ChaosNonRetryableError}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { ChaosNonRetryableError } from '@lostgradient/weft/testing';
 * const error = new ChaosNonRetryableError('chaos');
 * void error;
 * ```
 */
const exportedChaosNonRetryableError = ChaosNonRetryableError;

/**
 * Re-exported {@link ChaosTimeoutError}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { ChaosTimeoutError } from '@lostgradient/weft/testing';
 * const error = new ChaosTimeoutError(1000);
 * void error;
 * ```
 */
const exportedChaosTimeoutError = ChaosTimeoutError;

/**
 * Re-exported {@link ChaosTransientError}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { ChaosTransientError } from '@lostgradient/weft/testing';
 * const error = new ChaosTransientError('transient');
 * void error;
 * ```
 */
const exportedChaosTransientError = ChaosTransientError;

/**
 * Re-exported {@link TestEngine}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { TestEngine } from '@lostgradient/weft/testing';
 * await using engine = new TestEngine();
 * void engine;
 * ```
 */
const exportedTestEngine = TestEngine;

/**
 * Re-exported {@link TimeControl}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { TimeControl } from '@lostgradient/weft/testing';
 * const control = new TimeControl();
 * void control;
 * ```
 */
const exportedTimeControl = TimeControl;

/**
 * Re-exported {@link withChaos}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { withChaos } from '@lostgradient/weft/testing';
 * const wrapped = withChaos(async () => 'ok', { faultRate: 0.1 });
 * void wrapped;
 * ```
 */
const exportedWithChaos = withChaos;

/**
 * Re-exported {@link spawnServerSubprocess}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { spawnServerSubprocess } from '@lostgradient/weft/testing';
 * void spawnServerSubprocess;
 * ```
 */
const exportedSpawnServerSubprocess = spawnServerSubprocess;

/**
 * Re-exported {@link killAndReboot}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { killAndReboot } from '@lostgradient/weft/testing';
 * void killAndReboot;
 * ```
 */
const exportedKillAndReboot = killAndReboot;

/**
 * Re-exported {@link withSubprocessServer}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { withSubprocessServer } from '@lostgradient/weft/testing';
 * void withSubprocessServer;
 * ```
 */
const exportedWithSubprocessServer = withSubprocessServer;

export type { ChaosScenario, FaultClass } from './chaos';
export type { MockCall, MockedActivity, MockHandle } from './mocks';
export type {
  SubprocessServerHandle,
  SubprocessServerOptions,
  SubprocessServerProcess,
  SubprocessSignal,
} from './subprocess-engine';
export type { RunNOptions, RunNResult } from './test-engine';
export {
  exportedActivityMockRegistry as ActivityMockRegistry,
  exportedChaosNonRetryableError as ChaosNonRetryableError,
  exportedChaosTimeoutError as ChaosTimeoutError,
  exportedChaosTransientError as ChaosTransientError,
  exportedKillAndReboot as killAndReboot,
  exportedSpawnServerSubprocess as spawnServerSubprocess,
  exportedTestEngine as TestEngine,
  exportedTimeControl as TimeControl,
  exportedWithChaos as withChaos,
  exportedWithSubprocessServer as withSubprocessServer,
};
