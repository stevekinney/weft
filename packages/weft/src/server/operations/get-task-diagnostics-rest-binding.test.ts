import { describe, expect, it } from 'bun:test';

import { getTaskDiagnosticsRestBinding } from './get-task-diagnostics.ts';

function extract(query: string): Promise<Record<string, unknown>> {
  return Promise.resolve(
    getTaskDiagnosticsRestBinding.extractInput(
      new Request(`http://localhost/v1/tasks/diagnostics${query}`),
      {},
      {},
    ),
  ) as Promise<Record<string, unknown>>;
}

describe('weft.tasks.diagnostics REST binding', () => {
  it('reads includeExpectedDelayed as a boolean for "true" and "false"', async () => {
    const asTrue = await extract('?includeExpectedDelayed=true');
    const asFalse = await extract('?includeExpectedDelayed=false');
    expect(asTrue['includeExpectedDelayed']).toBe(true);
    expect(asFalse['includeExpectedDelayed']).toBe(false);
  });

  it('treats an absent or empty includeExpectedDelayed as unset', async () => {
    const absent = await extract('');
    const empty = await extract('?includeExpectedDelayed=');
    expect(absent['includeExpectedDelayed']).toBeUndefined();
    expect(empty['includeExpectedDelayed']).toBeUndefined();
  });

  it('passes any other includeExpectedDelayed value through for schema validation to reject', async () => {
    const other = await extract('?includeExpectedDelayed=maybe');
    expect(other['includeExpectedDelayed']).toBe('maybe');
  });

  it('reads numeric filters as numbers and leaves empty ones unset', async () => {
    const input = await extract('?limit=25&staleQueuedAfterMs=');
    expect(input['limit']).toBe(25);
    expect(input['staleQueuedAfterMs']).toBeUndefined();
  });
});
