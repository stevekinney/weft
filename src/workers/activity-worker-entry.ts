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

export type ActivityHandlerLookup = (
  name: string,
) => ((...arguments_: unknown[]) => unknown) | undefined;

// ---------------------------------------------------------------------------
// Worker bootstrap
// ---------------------------------------------------------------------------

/**
 * Initialize the activity worker message loop. Call this from within a Web
 * Worker to wire up the activity execution protocol.
 *
 * @param getActivity - Resolves an activity name to its function. Typically
 *   backed by a registration map built at worker creation time.
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
// Blob URL creation
// ---------------------------------------------------------------------------

/**
 * Create a Blob URL that can be used to spawn an activity Web Worker with
 * the given activity registrations.
 *
 * @param registrations - Map of activity names to handler functions. The
 *   handlers must be serializable (no closures over local state).
 * @returns A Blob URL suitable for the `activityExecution.workerUrl` option.
 */
export function createActivityWorkerEntryUrl(
  registrations: Map<string, (...arguments_: unknown[]) => unknown>,
): string {
  const registrationEntries = [...registrations.entries()]
    .map(([name, handler]) => `  activities.set(${JSON.stringify(name)}, ${handler.toString()});`)
    .join('\n');

  const script = `
const activities = new Map();
${registrationEntries}

import { initializeActivityWorkerMessageLoop } from '${import.meta.url.replace(/activity-worker-entry\.[^/]+$/, 'activity-worker-entry.ts')}';
initializeActivityWorkerMessageLoop((name) => activities.get(name));
`;

  const blob = new Blob([script], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}
