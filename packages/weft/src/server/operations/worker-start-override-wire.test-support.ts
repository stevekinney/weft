import { buildStartBody, buildStartOrSignalBody } from '../../client/start-body.ts';
import type { WorkerStartOverridePreview } from '../../worker/start-override-preview.ts';

/** The wire bodies the HTTP client builds for a start that carries an override token. */
export function buildClientBody(preview: WorkerStartOverridePreview) {
  return {
    start: buildStartBody('wired', null, { workerStartOverridePreview: preview }),
    startOrSignal: buildStartOrSignalBody(
      'wired',
      null,
      { name: 'go', signalId: 's' },
      { workerStartOverridePreview: preview, onTerminalConflict: 'start-new' },
    ),
  };
}
