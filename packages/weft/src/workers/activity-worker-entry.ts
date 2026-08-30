/**
 * Web Worker entry point for activity execution.
 *
 * Sets up `self.onmessage` to handle {@link ActivityExecutionRequest} and
 * posts back {@link ActivityExecutionResult} via `self.postMessage`. Uses
 * the existing `executeActivity` helper from `activity-runner.ts`.
 *
 * @module workers/activity-worker-entry
 */

import type { ActivityExecutionRequest, ActivityExecutionResult } from './activity-runner.ts';
import { executeActivity } from './activity-runner.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Function type that resolves an activity name to its handler function, or
 * returns `undefined` when the activity is not registered.
 *
 * Passed to `initializeActivityWorkerMessageLoop` to wire up the message
 * handler inside a Web Worker.  Typically backed by a `Map` built at worker
 * startup from the activity registration object.
 *
 * @example
 * ```ts
 * import { type ActivityHandlerLookup } from '@lostgradient/weft';
 *
 * const activities = new Map<string, (input: unknown) => unknown>([
 *   ['double', (n: unknown) => (n as number) * 2],
 * ]);
 *
 * const lookup: ActivityHandlerLookup = (name) => activities.get(name);
 * console.log(lookup('double')); // [Function: double]
 * console.log(lookup('missing')); // undefined
 * ```
 */
export type ActivityHandlerLookup = (name: string) => ((input: unknown) => unknown) | undefined;

// ---------------------------------------------------------------------------
// Worker bootstrap
// ---------------------------------------------------------------------------

/**
 * Initialize the activity worker message loop. Call this from within a Web
 * Worker to wire up the activity execution protocol.
 *
 * @param getActivity - Resolves an activity name to its function. Typically
 *   backed by a registration map built at worker creation time.
 *
 * @example
 * ```ts
 * import { initializeActivityWorkerMessageLoop } from '@lostgradient/weft';
 *
 * const activities = new Map<string, (input: unknown) => unknown>();
 * activities.set('greet', (input: unknown) => {
 *   if (typeof input !== 'object' || input === null || !('name' in input)) {
 *     throw new Error('Expected greeting input');
 *   }
 *   if (typeof input.name !== 'string') {
 *     throw new Error('Expected greeting name');
 *   }
 *   return `Hello, ${input.name}!`;
 * });
 *
 * // Call inside a Worker file to start listening for tasks:
 * initializeActivityWorkerMessageLoop((name) => activities.get(name));
 * ```
 */
export function initializeActivityWorkerMessageLoop(getActivity: ActivityHandlerLookup): void {
  self.addEventListener('message', async (event: MessageEvent<ActivityExecutionRequest>) => {
    const request = event.data;
    const activityFunction = getActivity(request.activityName);

    if (!activityFunction) {
      const result: ActivityExecutionResult = {
        operationId: request.operationId,
        status: 'failed',
        error: `Unknown activity in worker: "${request.activityName}"`,
      };
      self.postMessage(result);
      return;
    }

    const result = await executeActivity(request, activityFunction);
    self.postMessage(result);
  });
}

// ---------------------------------------------------------------------------
// Function serialization validation
// ---------------------------------------------------------------------------

/**
 * Common patterns that indicate a function captures variables from an outer
 * scope and therefore cannot be safely serialized via `toString()`. When
 * detected, `validateHandlerSerializable` throws a descriptive error so
 * callers get an immediate, actionable failure instead of a silent broken
 * worker script.
 */
const CLOSURE_PATTERNS: ReadonlyArray<{ pattern: RegExp; description: string }> = [
  {
    pattern: /\bthis\b/,
    description: 'references `this` (class method or bound context)',
  },
  {
    pattern: /\bimport\s*\(/,
    description: 'uses dynamic `import()`',
  },
  {
    pattern: /\brequire\s*\(/,
    description: 'uses `require()`',
  },
];

/**
 * Strip string literals (single, double, template) and comments (line, block)
 * from JavaScript source so that closure-detection regexes only match actual
 * code, not occurrences inside `"use this link"` or `// import something`.
 */
function stripStringsAndComments(source: string): string {
  return source.replace(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:\\[\s\S]|[^`\\])*`|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g,
    '',
  );
}

/**
 * Validate that a handler function can be safely serialized with `toString()`
 * for use inside a Web Worker blob script.
 *
 * @throws {Error} If the function body matches a known closure pattern.
 */
function validateHandlerSerializable(
  name: string,
  handler: (...arguments_: unknown[]) => unknown,
): void {
  const source = handler.toString();

  // Native code cannot be serialized — `toString()` returns something like
  // `function foo() { [native code] }`.
  if (source.includes('[native code]')) {
    throw new Error(
      `Activity handler "${name}" is a native function and cannot be serialized for worker execution.`,
    );
  }

  // Strip strings and comments so patterns only match actual code references.
  const codeOnly = stripStringsAndComments(source);

  for (const { pattern, description } of CLOSURE_PATTERNS) {
    if (pattern.test(codeOnly)) {
      throw new Error(
        `Activity handler "${name}" ${description}. ` +
          'Handlers passed to createActivityWorkerEntryUrl must be self-contained functions ' +
          'without closures over outer scope, class instances, or module-level variables.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Blob URL creation
// ---------------------------------------------------------------------------

/**
 * Create a Blob URL that can be used to spawn an activity Web Worker with
 * the given activity registrations.
 *
 * @param registrations - Map of activity names to handler functions. The
 *   handlers must be serializable (no closures over local state).
 * @returns A Blob URL string suitable for the `activityExecution.workerUrl`
 *   option. Call {@link revokeActivityWorkerEntryUrl} when the URL is no
 *   longer needed (e.g., during engine disposal) to free the registration.
 * @throws {Error} If any handler function cannot be safely serialized.
 *
 * @example
 * ```ts
 * import { createActivityWorkerEntryUrl, revokeActivityWorkerEntryUrl } from '@lostgradient/weft';
 *
 * const registrations = new Map<string, (input: unknown) => unknown>();
 * registrations.set('double', (n: unknown) => (n as number) * 2);
 *
 * const url = createActivityWorkerEntryUrl(registrations);
 * // Pass url to Engine as activityExecution.workerUrl
 * revokeActivityWorkerEntryUrl(url); // cleanup when done
 * ```
 */
export function createActivityWorkerEntryUrl(
  registrations: Map<string, (input: unknown) => unknown>,
): string {
  for (const [name, handler] of registrations) {
    validateHandlerSerializable(name, handler);
  }

  const registrationEntries = [...registrations.entries()]
    .map(([name, handler]) => `  activities.set(${JSON.stringify(name)}, ${handler.toString()});`)
    .join('\n');

  const script = `
const activities = new Map();
${registrationEntries}

import { initializeActivityWorkerMessageLoop } from '${import.meta.url}';
initializeActivityWorkerMessageLoop((name) => activities.get(name));
`;

  const blob = new Blob([script], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}

/**
 * Revoke a Blob URL previously created by {@link createActivityWorkerEntryUrl}.
 * Call this once all workers that need the URL have been constructed (e.g.,
 * during engine disposal) to free the URL registration and prevent leaks.
 *
 * @example
 * ```ts
 * import { createActivityWorkerEntryUrl, revokeActivityWorkerEntryUrl } from '@lostgradient/weft';
 *
 * const registrations = new Map<string, (input: unknown) => unknown>();
 * registrations.set('greet', (input: unknown) => 'hello');
 * const url = createActivityWorkerEntryUrl(registrations);
 * // After all workers using this URL have been created:
 * revokeActivityWorkerEntryUrl(url);
 * ```
 */
export function revokeActivityWorkerEntryUrl(url: string): void {
  URL.revokeObjectURL(url);
}
