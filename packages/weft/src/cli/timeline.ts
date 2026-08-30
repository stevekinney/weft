import type { CommandOutput } from './types.ts';
import { collectDiffLines, formatValue } from './utilities.ts';

export { collectDiffLines } from './utilities.ts';

function formatTimelineLine(entry: {
  step: number;
  operationType: string;
  operationLabel: string;
  status: string;
  duration?: number;
  outputSummary?: string;
}): string {
  const duration = entry.duration !== undefined ? `${entry.duration}ms` : '-';
  const output = entry.outputSummary ?? '(pending)';
  return `Step ${entry.step} | ${entry.operationType} | ${entry.operationLabel} | ${entry.status} | ${duration} | ${output}`;
}

function formatReplayDetails(options: {
  workflowId: string;
  step: number;
  replay: {
    checkpoint: unknown;
    accumulatedResults: unknown;
    events: unknown;
  };
}): CommandOutput {
  return {
    stdout: [
      `Replay step ${options.step} for ${options.workflowId}`,
      '',
      `Checkpoint: ${formatValue(options.replay.checkpoint)}`,
      '',
      `Accumulated results: ${formatValue(options.replay.accumulatedResults)}`,
      '',
      `Events: ${formatValue(options.replay.events)}`,
    ].join('\n'),
    exitCode: 0,
  };
}

/** Executes timeline inspection and replay checkpoint diff commands. */
export async function executeTimeline(options: {
  database: string;
  workflowId: string;
  step?: number;
  diff?: [number, number];
}): Promise<CommandOutput> {
  if (!options.workflowId) {
    return {
      stdout: '',
      stderr: 'Error: workflowId is required for timeline',
      exitCode: 1,
    };
  }

  const { BunSQLiteStorage } = await import('../storage/bun-sql.ts');
  const storage = new BunSQLiteStorage(options.database);
  const { Engine } = await import('../core/engine.ts');
  const engine = new Engine({ storage });

  try {
    const state = await engine.get(options.workflowId);
    if (state === null) {
      return {
        stdout: '',
        stderr: `Error: workflow "${options.workflowId}" not found`,
        exitCode: 1,
      };
    }

    if (options.step !== undefined) {
      const replay = await engine.replayTo(options.workflowId, options.step);
      if (replay === null) {
        return {
          stdout: '',
          stderr: `Error: replay not found for step ${options.step}`,
          exitCode: 1,
        };
      }

      return formatReplayDetails({
        workflowId: options.workflowId,
        step: options.step,
        replay,
      });
    }

    if (options.diff !== undefined) {
      const [fromStep, toStep] = options.diff;
      const fromReplay = await engine.replayTo(options.workflowId, fromStep);
      const toReplay = await engine.replayTo(options.workflowId, toStep);
      if (fromReplay === null || toReplay === null) {
        return {
          stdout: '',
          stderr: `Error: replay not found for diff ${fromStep} -> ${toStep}`,
          exitCode: 1,
        };
      }

      const lines: string[] = [];
      collectDiffLines(fromReplay.checkpoint, toReplay.checkpoint, 'checkpoint', lines);
      collectDiffLines(
        fromReplay.accumulatedResults,
        toReplay.accumulatedResults,
        'accumulatedResults',
        lines,
      );

      return {
        stdout: [`Diff ${fromStep} -> ${toStep} for ${options.workflowId}`, ...lines].join('\n'),
        exitCode: 0,
      };
    }

    const timeline = await engine.getTimeline(options.workflowId);
    return {
      stdout:
        timeline.length === 0
          ? `No timeline entries found for workflow "${options.workflowId}".`
          : timeline.map(formatTimelineLine).join('\n'),
      exitCode: 0,
    };
  } finally {
    await engine[Symbol.asyncDispose]();
    storage[Symbol.dispose]();
  }
}
