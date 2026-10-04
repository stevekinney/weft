/**
 * COR-240 acceptance criterion 12: "WebSocket and long-poll use one
 * result-application implementation." That fact was true but untested — the
 * refutation audit of P-COR-31 found no test that would fail if a future
 * refactor gave either transport its own duplicate/dead-letter/conflict
 * handling instead of calling the shared `applyWorkerTaskResult`, even
 * though outward behavior might still happen to match at the moment of the
 * refactor. A behavioral test cannot catch that divergence by construction —
 * two implementations that currently agree are indistinguishable from one
 * shared implementation from the outside. This is deliberately a structural
 * test instead, following the same source-reading approach as
 * `operations/fault-shaper-regressions.test.ts`.
 *
 * @module server/runtime/task-result-application.test
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const runtimeDirectory = fileURLToPath(new URL('.', import.meta.url));

function readRuntimeSource(fileName: string): string {
  return readFileSync(`${runtimeDirectory}${fileName}`, 'utf8');
}

const SHARED_IMPORT_PATTERN =
  /import\s*\{[^}]*\bapplyWorkerTaskResult\b[^}]*\}\s*from\s*['"]\.\/task-result-application\.ts['"]/;
const SHARED_CALL_PATTERN = /\bapplyWorkerTaskResult\s*\(/;

describe('WebSocket and long-poll share one result-application implementation (COR-240 criterion 12)', () => {
  it('both transports import applyWorkerTaskResult from task-result-application.ts', () => {
    const websocketSource = readRuntimeSource('websocket-worker.ts');
    const longPollSource = readRuntimeSource('task-result-submission.ts');

    for (const [name, source] of [
      ['websocket-worker.ts', websocketSource],
      ['task-result-submission.ts', longPollSource],
    ] as const) {
      expect(source, `${name} should import applyWorkerTaskResult`).toMatch(SHARED_IMPORT_PATTERN);
      expect(source, `${name} should call applyWorkerTaskResult`).toMatch(SHARED_CALL_PATTERN);
    }
  });

  it('neither transport defines its own commitTaskLedgerCompletion or matchIdempotentResubmission', () => {
    // The ledger-level idempotency matching (duplicate/dead-lettered/conflict
    // classification) lives one level below applyWorkerTaskResult, in
    // task-ledger-completion.ts. If either transport grew its own copy of
    // that logic, importing the shared function above would no longer
    // guarantee shared BEHAVIOR — this closes that gap directly.
    const forbiddenDefinitionPattern =
      /function\s+(commitTaskLedgerCompletion|matchIdempotentResubmission)\b/;
    for (const fileName of ['websocket-worker.ts', 'task-result-submission.ts'] as const) {
      expect(
        readRuntimeSource(fileName),
        `${fileName} should not define its own ledger-completion logic`,
      ).not.toMatch(forbiddenDefinitionPattern);
    }
  });

  it('commitTaskLedgerCompletion is called from exactly one production module in this directory', () => {
    // A grep confirming an import (the prior two tests) proves both
    // transports reach the shared seam; this proves the seam itself has not
    // grown a second production caller elsewhere in server/runtime that
    // would let a future change route one transport around it silently.
    const callSitePattern = /\bcommitTaskLedgerCompletion\s*\(/;
    const callers = readdirSync(runtimeDirectory)
      .filter((fileName) => fileName.endsWith('.ts') && !fileName.endsWith('.test.ts'))
      .filter((fileName) => fileName !== 'task-ledger-completion.ts')
      .filter((fileName) => callSitePattern.test(readRuntimeSource(fileName)));

    expect(callers).toEqual(['task-result-application.ts']);
  });
});
