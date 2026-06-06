/**
 * Version compatibility check for running workflows against registered versions.
 *
 * Scans storage for active (running/pending) workflows, groups by type,
 * and compares stored versions with currently registered versions to
 * determine deployment safety.
 *
 * @module diagnostics/version-check
 */

import { decodeWorkflowState } from '../core/engine/validation.ts';
import { DEFAULT_WORKFLOW_VERSION, checkVersionCompatibility } from '../core/versioning.ts';
import type { Storage } from '../storage/interface.ts';
import type { VersionCheckReport, WorkflowTypeReport } from './types.ts';
import type { WorkflowRegistration } from './validate.ts';

interface WorkflowTypeGroup {
  count: number;
  versionCounts: Map<string, number>;
}

async function groupActiveWorkflowsByType(
  storage: Storage,
): Promise<Map<string, WorkflowTypeGroup>> {
  const groups = new Map<string, WorkflowTypeGroup>();
  for await (const [key, bytes] of storage.scan('wf:')) {
    if (key.includes(':ckpt')) continue;
    // Decode through `decodeWorkflowState` so older flat-shaped persisted records
    // are lifted into the current `versionTuple` representation before we read it.
    const state = decodeWorkflowState(bytes);
    if (state.status !== 'running' && state.status !== 'pending') continue;

    const storedVersion = state.versionTuple.workflowVersion;
    let group = groups.get(state.type);
    if (!group) {
      group = { count: 0, versionCounts: new Map() };
      groups.set(state.type, group);
    }
    group.count++;
    group.versionCounts.set(storedVersion, (group.versionCounts.get(storedVersion) ?? 0) + 1);
  }
  return groups;
}

function findMostCommonVersion(versionCounts: Map<string, number>): string {
  let storedVersion = '';
  let maxCount = 0;
  for (const [version, count] of versionCounts) {
    if (count > maxCount) {
      maxCount = count;
      storedVersion = version;
    }
  }
  return storedVersion;
}

function buildWorkflowTypeReports(
  groups: Map<string, WorkflowTypeGroup>,
  registrations: Record<string, WorkflowRegistration>,
): WorkflowTypeReport[] {
  const reports: WorkflowTypeReport[] = [];
  for (const [type, group] of groups) {
    const registration = registrations[type];
    if (!registration) continue;

    const storedVersion = findMostCommonVersion(group.versionCounts);
    const registeredVersion = registration.version ?? DEFAULT_WORKFLOW_VERSION;
    const hasMigration = !!registration.migrate;
    const compatibility = checkVersionCompatibility(storedVersion, registeredVersion, hasMigration);

    reports.push({
      type,
      storedVersion,
      registeredVersion,
      runningCount: group.count,
      compatibility,
      hasMigration,
    });
  }
  return reports;
}

function computeOverallVerdict(
  reports: WorkflowTypeReport[],
): VersionCheckReport['overallVerdict'] {
  let verdict: VersionCheckReport['overallVerdict'] = 'safe';
  for (const report of reports) {
    if (report.compatibility === 'incompatible') return 'unsafe';
    if (report.compatibility === 'needs-migration') verdict = 'needs-migration';
  }
  return verdict;
}

/**
 * Scans active (running and pending) workflows in `storage`, groups them by
 * type, and compares stored workflow versions against currently registered
 * versions to determine deployment safety.
 *
 * Returns a {@link VersionCheckReport} with a per-type breakdown and an
 * `overallVerdict` of `'safe'`, `'unsafe'`, or `'needs-migration'`.  Typically
 * called by the `weft version:check` CLI command.
 *
 * @example
 * ```ts
 * import { MemoryStorage, runVersionCheck, workflow } from '@lostgradient/weft';
 *
 * await using storage = new MemoryStorage();
 *
 * const ping = workflow({ name: 'ping', version: '1.0.0' })
 *   .execute(async function* () { return 'pong'; });
 * const report = await runVersionCheck(storage, { ping });
 * console.log(report.overallVerdict); // 'safe'
 * ```
 */
export async function runVersionCheck(
  storage: Storage,
  registrations: Record<string, WorkflowRegistration>,
): Promise<VersionCheckReport> {
  const groups = await groupActiveWorkflowsByType(storage);
  const workflowTypes = buildWorkflowTypeReports(groups, registrations);
  const overallVerdict = computeOverallVerdict(workflowTypes);
  return { workflowTypes, overallVerdict };
}
