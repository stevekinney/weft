/**
 * Source tags for the compare-and-swap conditions a start's create batch commits
 * under. A `conditionalBatch` that returns `false` says only that SOME condition
 * missed, so `buildAndCommitStartBatch` re-reads the conditions by tag to
 * attribute the miss to a specific cause and answer it with the matching,
 * caller-visible outcome.
 *
 * @module core/engine/lifecycle/start-condition-tags
 */

import type { ConditionalBatchCondition } from '../../../storage/interface.ts';

export type TaggedStartCondition = {
  source:
    | 'workflow-concurrency'
    | 'start-precondition'
    | 'duplicate-id'
    | 'duplicate-id-generation'
    | 'worker-start-override'
    | 'catalog-entry';
  condition: ConditionalBatchCondition;
};

function tagStartPreconditions(
  conditions: ConditionalBatchCondition[] | undefined,
): TaggedStartCondition[] {
  return (conditions ?? []).map((condition) => ({
    source: 'start-precondition' as const,
    condition,
  }));
}

/** Separate `source` tags (not merged) so a WFT-153 generation-only conflict is distinguishable from an ordinary value conflict. Both undefined together (generated id), or both defined. */
function tagDuplicateIdConditions(
  condition: ConditionalBatchCondition | undefined,
  generationCondition: ConditionalBatchCondition | undefined,
): TaggedStartCondition[] {
  const tagged: TaggedStartCondition[] = [];
  if (condition !== undefined) tagged.push({ source: 'duplicate-id', condition });
  if (generationCondition !== undefined) {
    tagged.push({ source: 'duplicate-id-generation', condition: generationCondition });
  }
  return tagged;
}

function tagWorkflowConcurrencyConditions(
  conditions: ConditionalBatchCondition[],
): TaggedStartCondition[] {
  return conditions.map((condition) => ({
    source: 'workflow-concurrency' as const,
    condition,
  }));
}

function tagWorkerStartOverrideConditions(
  conditions: ConditionalBatchCondition[] | undefined,
): TaggedStartCondition[] {
  return (conditions ?? []).map((condition) => ({ source: 'worker-start-override', condition }));
}

/** Every condition one start attempt commits under, each carrying the tag that attributes a miss. */
export function tagStartConditions(conditions: {
  idempotency: ConditionalBatchCondition[] | undefined;
  duplicateId: ConditionalBatchCondition | undefined;
  duplicateIdGeneration: ConditionalBatchCondition | undefined;
  workflowConcurrency: ConditionalBatchCondition[] | undefined;
  workerStartOverride: ConditionalBatchCondition[] | undefined;
  catalogEntry: TaggedStartCondition | undefined;
}): TaggedStartCondition[] {
  return [
    ...tagStartPreconditions(conditions.idempotency),
    ...tagDuplicateIdConditions(conditions.duplicateId, conditions.duplicateIdGeneration),
    ...tagWorkflowConcurrencyConditions(conditions.workflowConcurrency ?? []),
    ...tagWorkerStartOverrideConditions(conditions.workerStartOverride),
    ...(conditions.catalogEntry === undefined ? [] : [conditions.catalogEntry]),
  ];
}
