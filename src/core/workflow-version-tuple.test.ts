import { describe, expect, it } from 'bun:test';

import {
  collectToolVersions,
  diffWorkflowVersionTuples,
  formatWorkflowVersionDiff,
} from './workflow-version-tuple.ts';

// ---------------------------------------------------------------------------
// collectToolVersions
// ---------------------------------------------------------------------------

describe('collectToolVersions', () => {
  it('returns sorted name@version strings for flat tools', () => {
    const tools = [
      { name: 'beta', version: '2.0.0' },
      { name: 'alpha', version: '1.0.0' },
    ];
    expect(collectToolVersions(tools)).toEqual(['alpha@1.0.0', 'beta@2.0.0']);
  });

  it('defaults missing version to 0.0.0', () => {
    const tools = [{ name: 'my-tool' }];
    expect(collectToolVersions(tools)).toEqual(['my-tool@0.0.0']);
  });

  it('throws when a tool has an empty name', () => {
    const tools = [{ name: '', version: '1.0.0' }];
    expect(() => collectToolVersions(tools)).toThrow(
      'collectToolVersions: tool is missing a required name field',
    );
  });

  it('returns empty array for empty input', () => {
    expect(collectToolVersions([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// diffWorkflowVersionTuples
// ---------------------------------------------------------------------------

describe('diffWorkflowVersionTuples', () => {
  it('returns empty diff when tuples are identical', () => {
    const tuple = { workflowVersion: '1.0.0', agentVersion: '1.0.0', toolVersions: ['t@1.0.0'] };
    expect(diffWorkflowVersionTuples(tuple, tuple)).toEqual({});
  });

  it('detects workflow version change', () => {
    const stored = { workflowVersion: '1.0.0' };
    const registered = { workflowVersion: '2.0.0' };
    const diff = diffWorkflowVersionTuples(stored, registered);
    expect(diff.workflowVersion).toEqual(['1.0.0', '2.0.0']);
  });

  it('detects agent version change', () => {
    const stored = { workflowVersion: '1.0.0', agentVersion: '1.0.0' };
    const registered = { workflowVersion: '1.0.0', agentVersion: '2.0.0' };
    const diff = diffWorkflowVersionTuples(stored, registered);
    expect(diff.agentVersion).toEqual(['1.0.0', '2.0.0']);
  });

  it('ignores agent version drift when both sides normalize to the default', () => {
    const stored = { workflowVersion: '1.0.0' };
    const registered = { workflowVersion: '1.0.0', agentVersion: '0.0.0' };
    expect(diffWorkflowVersionTuples(stored, registered)).toEqual({});
  });

  it('detects tool added', () => {
    const stored = { workflowVersion: '1.0.0' };
    const registered = { workflowVersion: '1.0.0', toolVersions: ['new-tool@1.0.0'] };
    const diff = diffWorkflowVersionTuples(stored, registered);
    const change = diff.toolVersions?.find((c) => c.tool === 'new-tool');
    expect(change?.change).toBe('added');
    if (change?.change === 'added') expect(change.to).toBe('1.0.0');
  });

  it('detects tool removed', () => {
    const stored = { workflowVersion: '1.0.0', toolVersions: ['old-tool@1.0.0'] };
    const registered = { workflowVersion: '1.0.0' };
    const diff = diffWorkflowVersionTuples(stored, registered);
    const change = diff.toolVersions?.find((c) => c.tool === 'old-tool');
    expect(change?.change).toBe('removed');
    if (change?.change === 'removed') expect(change.from).toBe('1.0.0');
  });

  it('detects tool version changed', () => {
    const stored = { workflowVersion: '1.0.0', toolVersions: ['my-tool@1.0.0'] };
    const registered = { workflowVersion: '1.0.0', toolVersions: ['my-tool@2.0.0'] };
    const diff = diffWorkflowVersionTuples(stored, registered);
    const change = diff.toolVersions?.find((c) => c.tool === 'my-tool');
    expect(change?.change).toBe('changed');
    if (change?.change === 'changed') {
      expect(change.from).toBe('1.0.0');
      expect(change.to).toBe('2.0.0');
    }
  });
});

// ---------------------------------------------------------------------------
// formatWorkflowVersionDiff
// ---------------------------------------------------------------------------

describe('formatWorkflowVersionDiff', () => {
  it('returns empty string for an empty diff', () => {
    expect(formatWorkflowVersionDiff({})).toBe('');
  });

  it('formats workflow version change', () => {
    const output = formatWorkflowVersionDiff({ workflowVersion: ['1.0.0', '2.0.0'] });
    expect(output).toContain('workflow version: 1.0.0 → 2.0.0');
  });

  it('formats agent version change', () => {
    const output = formatWorkflowVersionDiff({ agentVersion: ['1.0.0', '2.0.0'] });
    expect(output).toContain('agent version: 1.0.0 → 2.0.0');
  });

  it('formats tool added', () => {
    const output = formatWorkflowVersionDiff({
      toolVersions: [{ tool: 'new-tool', change: 'added', to: '1.0.0' }],
    });
    expect(output).toContain('new-tool');
    expect(output).toContain('added');
  });

  it('formats removed and changed tools', () => {
    const output = formatWorkflowVersionDiff({
      toolVersions: [
        { tool: 'legacy-tool', change: 'removed', from: '1.0.0' },
        { tool: 'active-tool', change: 'changed', from: '1.0.0', to: '2.0.0' },
      ],
    });

    expect(output).toContain('legacy-tool');
    expect(output).toContain('removed (was: 1.0.0)');
    expect(output).toContain('active-tool');
    expect(output).toContain('version: 1.0.0 → 2.0.0');
  });
});
