/**
 * `weft conformance` — runs the shared RemoteWorker protocol check sequence
 * (`conformance/run-conformance.ts`) against a worker command given on the
 * command line and prints the report. The `weft.conformance.report` server
 * operation runs the identical sequence against operator-registered targets,
 * so the two surfaces cannot disagree about what passes.
 *
 * @module cli/conformance
 */

import { type ConformanceReport, runConformanceReport } from '../conformance/run-conformance.ts';
import { serve } from '../index.ts';
import type { CommandOutput } from './types.ts';

type ConformanceCommandOptions = {
  timeoutMs: number;
  json: boolean;
  workerCommand: string[];
};

function formatReport(report: ConformanceReport, json: boolean): string {
  if (json) return JSON.stringify(report, null, 2);
  return report.checks
    .map((check) => `${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.message}`)
    .join('\n');
}

/** Runs RemoteWorker protocol conformance checks against a candidate worker command. */
export async function executeConformance(
  options: ConformanceCommandOptions,
): Promise<CommandOutput> {
  if (options.workerCommand.length === 0) {
    return {
      stdout: '',
      stderr: 'Error: worker command is required after --',
      exitCode: 2,
    };
  }

  const report = await runConformanceReport({
    command: options.workerCommand,
    timeoutMs: options.timeoutMs,
    serve,
  });
  return { stdout: formatReport(report, options.json), exitCode: report.ok ? 0 : 1 };
}
