/**
 * What a host adds to the judgement of a structurally valid workflow document: the trigger kind, the
 * activity handlers and workflows its steps name, the activities it may not call, and the versions
 * it pins. {@link hostIssues} lists every problem found; `validateWorkflowDocument` throws them.
 *
 * @module document-workflow/document-host-issues
 */

import { validateWorkflowOrActivityName } from '../core/types/name-grammar.ts';
import type { WorkflowDocumentIssue } from './document-errors.ts';
import type {
  DocumentWorkflowHost,
  WorkflowDocument,
  WorkflowDocumentStep,
  WorkflowDocumentValidationOptions,
} from './document.ts';

/** Why `name` cannot be a workflow name, or `undefined` when it can. */
function workflowNameIssue(name: string): string | undefined {
  try {
    validateWorkflowOrActivityName(name, 'workflow');
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Why `name` cannot be an activity name, or `undefined` when it can. */
function activityNameIssue(name: string): string | undefined {
  try {
    validateWorkflowOrActivityName(name, 'activity');
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** A document that declares a schema needs a host that checks it. */
function schemaHostIssues(
  document: WorkflowDocument,
  host: DocumentWorkflowHost,
): WorkflowDocumentIssue[] {
  if (host.checkSchema !== undefined) return [];
  return (['inputSchema', 'outputSchema'] as const)
    .filter((key) => document[key] !== undefined)
    .map((key) => ({
      path: key,
      message: `this host does not check schemas, so a document cannot declare "${key}"`,
    }));
}

/** Why a step may not call `handler`, or `undefined` when it may. */
function compensateIssue(handler: string, host: DocumentWorkflowHost): string | undefined {
  const registered = Object.hasOwn(host.activities, handler) ? host.activities[handler] : undefined;
  if (registered === undefined || typeof registered === 'function') return undefined;
  if (registered.compensate === undefined) return undefined;
  return `activity handler "${handler}" defines "compensate", which a document never runs; remove it from the activity or call another`;
}

function visitSteps(
  steps: readonly WorkflowDocumentStep[],
  path: string,
  visit: (step: WorkflowDocumentStep, path: string) => void,
): void {
  for (const [index, step] of steps.entries()) {
    const stepPath = `${path}[${String(index)}]`;
    visit(step, stepPath);
    if (step.kind === 'branch') {
      for (const [literal, nested] of Object.entries(step.cases)) {
        visitSteps(nested, `${stepPath}.cases.${literal}`, visit);
      }
      if (step.otherwise !== undefined) visitSteps(step.otherwise, `${stepPath}.otherwise`, visit);
    } else if (step.kind === 'map') {
      visitSteps(step.steps, `${stepPath}.steps`, visit);
    } else if (step.kind === 'parallel') {
      for (const [name, nested] of Object.entries(step.branches)) {
        visitSteps(nested, `${stepPath}.branches.${name}`, visit);
      }
    }
  }
}

/** The issues with a document's `activityVersions`: a pin for a handler no step uses, or one the host cannot honor. */
function pinIssues(
  document: WorkflowDocument,
  host: DocumentWorkflowHost,
): WorkflowDocumentIssue[] {
  if (document.activityVersions === undefined) return [];
  const used = new Set<string>();
  visitSteps(document.steps, 'steps', (step) => {
    if (step.kind === 'activity') used.add(step.handler);
  });
  const issues: WorkflowDocumentIssue[] = [];
  for (const [handler, version] of Object.entries(document.activityVersions)) {
    const path = `activityVersions.${handler}`;
    if (!used.has(handler)) {
      issues.push({ path, message: `no step uses the activity handler "${handler}"` });
      continue;
    }
    const loaded =
      host.activityVersions !== undefined && Object.hasOwn(host.activityVersions, handler)
        ? host.activityVersions[handler]
        : undefined;
    if (loaded !== version) {
      issues.push({
        path,
        message:
          loaded === undefined
            ? `activity handler "${handler}" is pinned at version "${version}", but this host has no version of it`
            : `activity handler "${handler}" is pinned at version "${version}", but this host has version "${loaded}"`,
      });
    }
  }
  return issues;
}

/** The issues with a document's `workflowVersions`: a pin for a workflow no step calls, or one the host cannot honor. */
function workflowPinIssues(
  document: WorkflowDocument,
  host: DocumentWorkflowHost,
): WorkflowDocumentIssue[] {
  if (document.workflowVersions === undefined) return [];
  const called = new Set<string>();
  visitSteps(document.steps, 'steps', (step) => {
    if (step.kind === 'workflow') called.add(step.workflow);
  });
  const issues: WorkflowDocumentIssue[] = [];
  for (const [name, version] of Object.entries(document.workflowVersions)) {
    const path = `workflowVersions.${name}`;
    if (!called.has(name)) {
      issues.push({ path, message: `no step calls the workflow "${name}"` });
      continue;
    }
    const loaded =
      host.workflowVersions !== undefined && Object.hasOwn(host.workflowVersions, name)
        ? host.workflowVersions[name]
        : undefined;
    if (loaded !== version) {
      issues.push({
        path,
        message:
          loaded === undefined
            ? `workflow "${name}" is pinned at version "${version}", but this host has no version of it`
            : `workflow "${name}" is pinned at version "${version}", but this host has version "${loaded}"`,
      });
    }
  }
  return issues;
}

/** Every way `document`, which is structurally valid, is refused by `host`. */
export function hostIssues(
  document: WorkflowDocument,
  host: DocumentWorkflowHost,
  options: WorkflowDocumentValidationOptions,
): WorkflowDocumentIssue[] {
  const issues: WorkflowDocumentIssue[] = schemaHostIssues(document, host);
  const validator = Object.hasOwn(host.triggerKinds, document.trigger.kind)
    ? host.triggerKinds[document.trigger.kind]
    : undefined;
  if (validator === undefined) {
    issues.push({
      path: 'trigger.kind',
      message: `trigger kind "${document.trigger.kind}" is not registered`,
    });
  } else {
    const reason = validator(document.trigger);
    if (reason !== undefined) issues.push({ path: 'trigger', message: reason });
  }
  visitSteps(document.steps, 'steps', (step, path) => {
    if (step.kind === 'workflow') {
      const nameIssue = workflowNameIssue(step.workflow);
      if (nameIssue !== undefined) {
        issues.push({ path: `${path}.workflow`, message: nameIssue });
      } else if (host.workflows === undefined || !host.workflows.includes(step.workflow)) {
        issues.push({
          path: `${path}.workflow`,
          message: `workflow "${step.workflow}" is not registered`,
        });
      }
      return;
    }
    if (step.kind !== 'activity') return;
    const nameIssue = activityNameIssue(step.handler);
    if (nameIssue !== undefined) {
      issues.push({ path: `${path}.handler`, message: nameIssue });
    } else if (!Object.hasOwn(host.activities, step.handler)) {
      issues.push({
        path: `${path}.handler`,
        message: `activity handler "${step.handler}" is not registered`,
      });
    } else if (options.allowCompensate !== true) {
      const message = compensateIssue(step.handler, host);
      if (message !== undefined) issues.push({ path: `${path}.handler`, message });
    }
  });
  issues.push(...pinIssues(document, host), ...workflowPinIssues(document, host));
  return issues;
}
