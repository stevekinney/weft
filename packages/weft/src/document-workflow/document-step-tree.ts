/**
 * Walks over the steps of a workflow document, in the order the interpreter indexes them: the
 * preorder of the steps, with the cases of a `branch` and the branches of a `parallel` step in the
 * UTF-16 key order of the document's canonical JSON.
 *
 * @module document-workflow/document-step-tree
 */

import type { WorkflowDocument } from './document.ts';

type Step = WorkflowDocument['steps'][number];

/** The distinct values `pick` selects from the document's steps, in first-seen order. */
export function distinctStepValues(
  document: WorkflowDocument,
  pick: (step: Step) => string | undefined,
): string[] {
  const values = new Set<string>();
  const visit = (steps: readonly Step[]): void => {
    for (const step of steps) {
      const value = pick(step);
      if (value !== undefined) values.add(value);
      if (step.kind === 'branch') {
        branchCaseSteps(step).forEach(visit);
        if (step.otherwise !== undefined) visit(step.otherwise);
      } else if (step.kind === 'map') visit(step.steps);
      else if (step.kind === 'parallel')
        parallelBranches(step).forEach(([, nested]) => visit(nested));
    }
  };
  visit(document.steps);
  return [...values];
}

/** Traverse branch cases in the same UTF-16 key order used by canonical document JSON. */
export function branchCaseSteps(
  step: Extract<Step, { kind: 'branch' }>,
): readonly (readonly Step[])[] {
  return Object.keys(step.cases)
    .toSorted()
    .map((literal) => Object.getOwnPropertyDescriptor(step.cases, literal)?.value ?? []);
}

/** A parallel step's branches in the UTF-16 key order of canonical document JSON. */
export function parallelBranches(
  step: Extract<Step, { kind: 'parallel' }>,
): readonly (readonly [string, readonly Step[]])[] {
  return Object.keys(step.branches)
    .toSorted()
    .map((name) => [name, Object.getOwnPropertyDescriptor(step.branches, name)?.value ?? []]);
}

/** Every step of the document with its preorder index, the number a step's address starts with. */
export function documentStepIndexes(document: WorkflowDocument): Map<Step, number> {
  const indexes = new Map<Step, number>();
  let next = 0;
  const visit = (steps: readonly Step[]): void => {
    for (const step of steps) {
      indexes.set(step, next++);
      if (step.kind === 'branch') {
        branchCaseSteps(step).forEach(visit);
        if (step.otherwise !== undefined) visit(step.otherwise);
      } else if (step.kind === 'map') visit(step.steps);
      else if (step.kind === 'parallel')
        parallelBranches(step).forEach(([, nested]) => visit(nested));
    }
  };
  visit(document.steps);
  return indexes;
}

/** Whether any step of `steps`, however deeply nested, waits for a signal. */
export function containsWait(steps: readonly Step[]): boolean {
  return steps.some(
    (step) =>
      step.kind === 'await-signal' ||
      (step.kind === 'branch' &&
        (Object.values(step.cases).some(containsWait) ||
          (step.otherwise !== undefined && containsWait(step.otherwise)))) ||
      (step.kind === 'map' && containsWait(step.steps)) ||
      (step.kind === 'parallel' && Object.values(step.branches).some(containsWait)),
  );
}
