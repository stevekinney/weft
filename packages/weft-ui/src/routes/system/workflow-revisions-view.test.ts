/**
 * Unit tests for `workflow-revisions-view.ts` (WFT-115): structural
 * guarding + row projection for the Revisions panel.
 */
import { describe, expect, test } from 'bun:test';

import {
  isWorkflowRevisionRecordLike,
  workflowRevisionRows,
  type WorkflowRevisionRecordSource,
} from './workflow-revisions-view.ts';

function manifest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    manifestVersion: 1,
    name: 'order-processing',
    workflowVersion: '0.0.0',
    revision: 'order-processing-rev-1',
    contractHash: 'sha256:hash-1',
    contract: { name: 'order-processing', workflowVersion: '0.0.0' },
    ...overrides,
  };
}

function record(overrides: Partial<WorkflowRevisionRecordSource> = {}): unknown {
  return { manifest: manifest(), installedAt: 1_700_000_000_000, ...overrides };
}

describe('isWorkflowRevisionRecordLike', () => {
  test('accepts a well-formed record', () => {
    expect(isWorkflowRevisionRecordLike(record())).toBe(true);
  });

  test('rejects non-objects', () => {
    expect(isWorkflowRevisionRecordLike(null)).toBe(false);
    expect(isWorkflowRevisionRecordLike(undefined)).toBe(false);
    expect(isWorkflowRevisionRecordLike('nope')).toBe(false);
    expect(isWorkflowRevisionRecordLike(42)).toBe(false);
  });

  test('rejects a record missing installedAt', () => {
    const { installedAt: _installedAt, ...rest } = record() as Record<string, unknown>;
    expect(isWorkflowRevisionRecordLike(rest)).toBe(false);
  });

  test('rejects a manifest missing contractHash', () => {
    const bad = manifest();
    delete (bad as Record<string, unknown>)['contractHash'];
    expect(isWorkflowRevisionRecordLike({ manifest: bad, installedAt: 1 })).toBe(false);
  });

  test('rejects a manifest whose manifestVersion is not a number', () => {
    expect(
      isWorkflowRevisionRecordLike({
        manifest: manifest({ manifestVersion: '1' }),
        installedAt: 1,
      }),
    ).toBe(false);
  });

  test('rejects a manifest with no contract object', () => {
    expect(
      isWorkflowRevisionRecordLike({ manifest: manifest({ contract: undefined }), installedAt: 1 }),
    ).toBe(false);
  });
});

describe('workflowRevisionRows', () => {
  test('drops malformed records rather than fabricating a row', () => {
    const rows = workflowRevisionRows([record(), { not: 'a record' }, null, 42], {
      revision: 'order-processing-rev-1',
      generation: 1,
      activatedAt: 1,
    });
    expect(rows).toHaveLength(1);
  });

  test('flags exactly one row active per the active pointer', () => {
    const rows = workflowRevisionRows(
      [
        record({ manifest: manifest({ revision: 'rev-a' }) }),
        record({ manifest: manifest({ revision: 'rev-b' }) }),
        record({ manifest: manifest({ revision: 'rev-c' }) }),
      ],
      { revision: 'rev-b', generation: 2, activatedAt: 1_700_000_000_000 },
    );
    expect(rows.filter((row) => row.isActive)).toHaveLength(1);
    expect(rows.find((row) => row.isActive)?.revision).toBe('rev-b');
  });

  test('no row is active when the active pointer is null', () => {
    const rows = workflowRevisionRows([record()], null);
    expect(rows.every((row) => !row.isActive)).toBe(true);
  });

  test('sorts rows by revision, codepoint order', () => {
    const rows = workflowRevisionRows(
      [
        record({ manifest: manifest({ revision: 'rev-c' }) }),
        record({ manifest: manifest({ revision: 'rev-a' }) }),
        record({ manifest: manifest({ revision: 'rev-b' }) }),
      ],
      null,
    );
    expect(rows.map((row) => row.revision)).toEqual(['rev-a', 'rev-b', 'rev-c']);
  });

  test('projects workflowVersion, contractHash, manifestVersion, and installedAt verbatim', () => {
    const rows = workflowRevisionRows(
      [
        record({
          manifest: manifest({ workflowVersion: '2.0.0', contractHash: 'sha256:h2' }),
          installedAt: 42,
        }),
      ],
      null,
    );
    expect(rows[0]).toEqual({
      revision: 'order-processing-rev-1',
      workflowVersion: '2.0.0',
      contractHash: 'sha256:h2',
      manifestVersion: 1,
      installedAt: 42,
      isActive: false,
    });
  });
});
