#!/usr/bin/env bun
/**
 * Engine instance state lives on `EngineInternals` (a WeakMap-backed object
 * reached via `getInternals(this)`), not on `#private` class fields. This
 * keeps engine state accessible to the sibling modules that hold the engine's
 * extracted methods.
 *
 * This check enforces that invariant: no `this.#fieldName` reference may remain
 * in `src/core/engine/` for any field that belongs to `EngineInternals`.
 * Methods stay as `#private` (`this.#methodName(...)`) and are intentionally
 * not flagged.
 *
 * The field names are listed below. Methods extracted into sibling modules
 * still reach state through `getInternals(...)`, so no `this.#fieldName`
 * reference should exist for any of these names anywhere under
 * `src/core/engine/`.
 */

import { Glob, file } from 'bun';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..');

const ENGINE_INTERNALS_FIELDS = [
  'storage',
  'registrations',
  'workflowTypesByHandler',
  'abortController',
  'scheduler',
  'options',
  'strategy',
  'inlineStrategy',
  'handleCache',
  'finalizationRegistry',
  'resultResolvers',
  'signalWaiters',
  'signalWaitersByWorkflow',
  'updateWaiters',
  'updateWaitersByWorkflow',
  'sleepResolvers',
  'sleepResolversByWorkflow',
  'interceptors',
  'activityInterceptors',
  'composedWorkflowInterceptor',
  'composedActivityInterceptor',
  'updateCoordinator',
  'activityRegistry',
  'activityWorkerDispatcher',
  'checkpoints',
  'broadcastChannel',
  'pendingNestingDepth',
  'pendingParentHeaders',
  'workflowNestingDepths',
  'workflowHeaders',
  'workflowStateWriteChains',
  'budgetPolicyEnforcer',
  'tenantQuotaManager',
  'heartbeatDetails',
  'pendingStarts',
  'pendingScheduleCreations',
  'workflowsNeedingTerminalCleanup',
  'cleanupInterval',
  'retentionSweepInterval',
  'retentionSweepInFlight',
  'nextRetentionSweepAt',
  'reviewCoordinator',
  'reviewWaiters',
  'reviewWaitersByWorkflow',
  'reviewEscalationHandlers',
  'workflowReviewIds',
  'parkedInlineWorkflows',
  'terminalizingWorkflows',
  'reviewTimerIds',
  'pendingWebhooks',
  'alertManager',
  'eventLogHeads',
  'workflowFeedListeners',
  'workflowVersionTuples',
  'pendingTimelineEntries',
  'workflowCatalog',
  'pendingCatalogInstalls',
  'catalogRestored',
  'catalogDrainPromise',
  'registeredCatalogRevisions',
  'inFlightStartsByRevision',
];

interface Violation {
  file: string;
  line: number;
  field: string;
  text: string;
}

const violations: Violation[] = [];
const glob = new Glob('src/core/engine/**/*.ts');

for await (const relPath of glob.scan({ cwd: repoRoot })) {
  if (relPath.endsWith('.test.ts') || relPath.endsWith('.spec.ts')) continue;
  const absPath = join(repoRoot, relPath);
  const source = await file(absPath).text();
  const lines = source.split('\n');

  for (const [index, lineText] of lines.entries()) {
    for (const fieldName of ENGINE_INTERNALS_FIELDS) {
      const regex = new RegExp(`this\\.#${fieldName}(?![a-zA-Z0-9_$])`, 'g');
      if (regex.test(lineText)) {
        violations.push({
          file: relPath,
          line: index + 1,
          field: fieldName,
          text: lineText.trim(),
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Found `this.#fieldName` references for EngineInternals fields:');
  for (const v of violations) {
    console.error(
      `  ${v.file}:${v.line}  this.#${v.field}  →  should be getInternals(this).${v.field}`,
    );
    console.error(`    ${v.text}`);
  }
  console.error(
    '\nThese fields live on EngineInternals. Replace `this.#field` with `getInternals(this).field`.',
  );
  process.exit(1);
}

console.log(
  `OK: no \`this.#fieldName\` references for ${ENGINE_INTERNALS_FIELDS.length} EngineInternals fields.`,
);
