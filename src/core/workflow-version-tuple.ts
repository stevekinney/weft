/**
 * Workflow, agent, and tool version tuple utilities.
 *
 * Captures a `(workflowVersion, agentVersion, toolVersions[])` tuple on every
 * event-log entry and provides diff utilities to detect mismatches between
 * stored tuples and currently-registered definitions when resuming workflows.
 *
 * @module core/workflow-version-tuple
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Version tuple captured at workflow start and on every event-log entry. */
export type WorkflowVersionTuple = {
  workflowVersion: string;
  agentVersion?: string;
  /** Sorted `"${name}@${version}"` strings, one per tool. */
  toolVersions?: string[];
};

/** A single tool-level version change surfaced by {@link diffWorkflowVersionTuples}. */
export type WorkflowToolVersionChange =
  | { tool: string; change: 'added'; to: string }
  | { tool: string; change: 'removed'; from: string }
  | { tool: string; change: 'changed'; from: string; to: string };

/** Structured field-level diff between two {@link WorkflowVersionTuple}s. */
export type WorkflowVersionDiff = {
  workflowVersion?: [string, string];
  agentVersion?: [string, string];
  toolVersions?: WorkflowToolVersionChange[];
};

// ---------------------------------------------------------------------------
// collectToolVersions
// ---------------------------------------------------------------------------

/**
 * Collect sorted `"${name}@${version}"` version strings from a tool array.
 *
 * Each element exposes a `name` plus an optional `version`. Missing versions
 * default to `"0.0.0"`. The returned array is sorted alphabetically so
 * comparisons are order-independent.
 */
export function collectToolVersions(
  tools: Array<{ name: string; version?: string | undefined }>,
): string[] {
  return tools
    .map((tool) => {
      if (!tool.name) throw new Error(`collectToolVersions: tool is missing a required name field`);
      return `${tool.name}@${tool.version ?? '0.0.0'}`;
    })
    .toSorted();
}

// ---------------------------------------------------------------------------
// diffWorkflowVersionTuples
// ---------------------------------------------------------------------------

/**
 * Compare two {@link WorkflowVersionTuple}s and return structured field-level diffs.
 *
 * Only fields that actually differ are included in the output. An empty
 * object means the tuples are identical.
 */
export function diffWorkflowVersionTuples(
  stored: WorkflowVersionTuple,
  registered: WorkflowVersionTuple,
): WorkflowVersionDiff {
  const diff: WorkflowVersionDiff = {};

  // Workflow version
  if (stored.workflowVersion !== registered.workflowVersion) {
    diff.workflowVersion = [stored.workflowVersion, registered.workflowVersion];
  }

  // Agent version
  const storedAgent = stored.agentVersion ?? '0.0.0';
  const registeredAgent = registered.agentVersion ?? '0.0.0';
  if (storedAgent !== registeredAgent) {
    diff.agentVersion = [storedAgent, registeredAgent];
  }

  const toolChanges = diffToolVersions(stored.toolVersions ?? [], registered.toolVersions ?? []);

  if (toolChanges.length > 0) {
    diff.toolVersions = toolChanges;
  }

  return diff;
}

// ---------------------------------------------------------------------------
// formatWorkflowVersionDiff
// ---------------------------------------------------------------------------

/**
 * Format a human-readable summary of a {@link WorkflowVersionDiff} for error messages.
 *
 * Returns an empty string when the diff has no changes.
 */
export function formatWorkflowVersionDiff(diff: WorkflowVersionDiff): string {
  const lines: string[] = [];

  if (diff.workflowVersion) {
    const [from, to] = diff.workflowVersion;
    lines.push(`  - workflow version: ${from} → ${to}`);
  }

  if (diff.agentVersion) {
    const [from, to] = diff.agentVersion;
    lines.push(`  - agent version: ${from} → ${to}`);
  }

  if (diff.toolVersions) {
    for (const change of diff.toolVersions) {
      switch (change.change) {
        case 'added':
          lines.push(`  - tool \`${change.tool}\` added (version: ${change.to})`);
          break;
        case 'removed':
          lines.push(`  - tool \`${change.tool}\` removed (was: ${change.from})`);
          break;
        case 'changed':
          lines.push(`  - tool \`${change.tool}\` version: ${change.from} → ${change.to}`);
          break;
      }
    }
  }

  if (lines.length === 0) return '';
  return `\nVersion tuple changes:\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Parse `"name@version"` strings into a Map for O(1) lookups. */
function parseToolVersionMap(versions: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of versions) {
    const atIndex = entry.lastIndexOf('@');
    if (atIndex > 0) {
      map.set(entry.slice(0, atIndex), entry.slice(atIndex + 1));
    }
  }
  return map;
}

function diffToolVersions(
  storedVersions: string[],
  registeredVersions: string[],
): WorkflowToolVersionChange[] {
  const storedTools = parseToolVersionMap(storedVersions);
  const registeredTools = parseToolVersionMap(registeredVersions);
  const allToolNames = new Set([...storedTools.keys(), ...registeredTools.keys()]);
  const toolChanges: WorkflowToolVersionChange[] = [];

  for (const name of allToolNames) {
    const change = diffToolVersion(name, storedTools.get(name), registeredTools.get(name));
    if (change !== undefined) {
      toolChanges.push(change);
    }
  }

  return toolChanges;
}

function diffToolVersion(
  tool: string,
  from: string | undefined,
  to: string | undefined,
): WorkflowToolVersionChange | undefined {
  if (from === undefined && to !== undefined) {
    return { tool, change: 'added', to };
  }

  if (from !== undefined && to === undefined) {
    return { tool, change: 'removed', from };
  }

  if (from !== undefined && to !== undefined && from !== to) {
    return { tool, change: 'changed', from, to };
  }

  return undefined;
}
