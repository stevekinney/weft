import { mock } from 'bun:test';

import type { WorkflowLogLevel, WorkflowLogRecord } from '../core/types/workflow-log.ts';

export type CapturedWorkflowLogRecord = {
  method: WorkflowLogLevel;
  record: WorkflowLogRecord;
};

export function captureWorkflowLogConsole(): {
  records: WorkflowLogRecord[];
  restore: () => void;
} {
  const records: WorkflowLogRecord[] = [];
  return captureWorkflowLogConsoleRecords((_, record) => records.push(record), records);
}

export function captureWorkflowLogConsoleWithMethods(): {
  records: CapturedWorkflowLogRecord[];
  restore: () => void;
} {
  const records: CapturedWorkflowLogRecord[] = [];
  return captureWorkflowLogConsoleRecords(
    (method, record) => records.push({ method, record }),
    records,
  );
}

function captureWorkflowLogConsoleRecords<TRecords extends unknown[]>(
  recordCaptured: (method: WorkflowLogLevel, record: WorkflowLogRecord) => void,
  records: TRecords,
): {
  records: TRecords;
  restore: () => void;
} {
  const originals = {
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  for (const method of ['debug', 'info', 'warn', 'error'] as const) {
    console[method] = mock((record: unknown) =>
      recordCaptured(method, record as WorkflowLogRecord),
    );
  }

  return {
    records,
    restore: () => {
      console.debug = originals.debug;
      console.info = originals.info;
      console.warn = originals.warn;
      console.error = originals.error;
    },
  };
}
