/**
 * The interpreter: one workflow definition bound to one validated document.
 * It runs the document's steps in order, so no agent-written code runs: the
 * only code involved is the host's registered activity handlers.
 *
 * @module document-workflow/interpreter
 */

import {
  advanceBranchesOf,
  canAdvanceBranches,
  inLockstep,
  markAdvancingRun,
} from '../core/context/advancing-operations.ts';
import type { ContextOperationRequest } from '../core/context/operation-request.ts';
import {
  activity,
  signal,
  workflow,
  type ActivityCallable,
  type ActivityContext,
  type WorkflowContext,
  type WorkflowDefinition,
} from '../core/types.ts';
import { runMapBatch } from './document-batch.ts';
import {
  WorkflowDocumentBranchError,
  WorkflowDocumentMapError,
  WorkflowDocumentReviewRejectedError,
  WorkflowDocumentSchemaError,
} from './document-errors.ts';
import {
  containsWait,
  distinctStepValues,
  documentStepIndexes,
  parallelBranches,
} from './document-step-tree.ts';
import type {
  DocumentActivity,
  DocumentActivityArgument,
  DocumentWorkflowHost,
  WorkflowDocument,
} from './document.ts';
import {
  documentChildWorkflowId,
  documentStepAddress,
  workflowDocumentVersion,
} from './document.ts';

function* documentOperation<T>(
  operation: Generator<unknown, T, unknown>,
  documentStep: number,
  stepAddress: string,
): Generator<ContextOperationRequest, T, unknown> {
  let input: unknown;
  while (true) {
    const result = operation.next(input);
    if (result.done) return result.value;
    const request = result.value as ContextOperationRequest;
    if (request.type === 'activity' || request.type === 'sleep' || request.type === 'wait-signal') {
      request.documentStep = documentStep;
      request.documentStepAddress = stepAddress;
    }
    input = yield request;
  }
}

/**
 * Activity retry backoff is an engine operation, not a document step. Mark only
 * the activity dispatches yielded by the retry generator so a retry does not
 * create a file-workflow sleep event or inherit the engine's step counter.
 */
export function* documentActivityOperation<T>(
  operation: Generator<unknown, T, unknown>,
  documentStep: number,
  stepAddress: string,
): Generator<ContextOperationRequest, T, unknown> {
  let input: unknown;
  while (true) {
    const result = operation.next(input);
    if (result.done) return result.value;
    const request = result.value as ContextOperationRequest;
    if (request.type === 'activity') {
      request.documentStep = documentStep;
      request.documentStepAddress = stepAddress;
    }
    try {
      input = yield request;
    } catch (error) {
      if (operation.throw === undefined) throw error;
      const thrown = operation.throw(error);
      if (thrown.done) return thrown.value;
      const thrownRequest = thrown.value as ContextOperationRequest;
      if (thrownRequest.type === 'activity') {
        thrownRequest.documentStep = documentStep;
        thrownRequest.documentStepAddress = stepAddress;
      }
      input = yield thrownRequest;
    }
  }
}

function mapSource(
  step: Extract<WorkflowDocument['steps'][number], { kind: 'map' }>,
  index: number,
  previous: unknown,
): readonly unknown[] {
  const source =
    typeof previous === 'object' && previous !== null
      ? Object.getOwnPropertyDescriptor(previous, step.over)?.value
      : undefined;
  if (!Array.isArray(source)) {
    throw new WorkflowDocumentMapError(
      'not-array',
      `Map step ${String(index)} requires field "${step.over}" of the previous result to be an array`,
    );
  }
  if (source.length > 1000) {
    throw new WorkflowDocumentMapError(
      'too-many',
      `Map step ${String(index)} cannot iterate more than 1000 items (received ${String(source.length)})`,
    );
  }
  return source;
}

function branchSteps(
  step: Extract<WorkflowDocument['steps'][number], { kind: 'branch' }>,
  previous: unknown,
): readonly WorkflowDocument['steps'][number][] {
  const candidate =
    typeof previous === 'object' && previous !== null && Object.hasOwn(previous, step.on)
      ? Object.getOwnPropertyDescriptor(previous, step.on)?.value
      : undefined;
  const literal = String(candidate);
  const selected = Object.hasOwn(step.cases, literal) ? step.cases[literal] : step.otherwise;
  if (selected === undefined) throw new WorkflowDocumentBranchError(step.on, candidate);
  return selected;
}

/** The name of the activity that runs {@link DocumentWorkflowHost.workflowAdmission}. */
const WORKFLOW_ADMISSION_ACTIVITY = 'document-workflow-admission';

function documentAdmissionActivity(
  admission: DocumentActivity,
): ActivityCallable<DocumentActivityArgument, unknown> {
  const settings = typeof admission === 'function' ? {} : admission;
  const execute = typeof admission === 'function' ? admission : admission.execute;
  return activity({
    ...settings,
    name: WORKFLOW_ADMISSION_ACTIVITY,
    execute: (argument: DocumentActivityArgument, activityContext?: ActivityContext) =>
      execute(argument, activityContext),
  });
}

/**
 * Build the workflow definition that interprets `document`. Its version is the
 * document's {@link workflowDocumentVersion}. Its `.activities()` map holds
 * exactly the handlers the document's activity steps name, and its
 * `.signals()` map exactly the signals its `await-signal` steps wait for, so
 * both appear in the contract.
 */
export async function buildDocumentWorkflowDefinition(
  document: WorkflowDocument,
  host: DocumentWorkflowHost,
): Promise<WorkflowDefinition> {
  const stepIndexes = documentStepIndexes(document);
  const activities = new Map(
    distinctStepValues(document, (step) =>
      step.kind === 'activity' ? step.handler : undefined,
    ).map((name) => {
      const registered = host.activities[name]!;
      const settings = typeof registered === 'function' ? {} : registered;
      const execute = typeof registered === 'function' ? registered : registered.execute;
      return [
        name,
        // The settings are spread under the name and the execute wrapper, so a definition's
        // retry, timeout, verifier and the rest are the activity's own, as in a code workflow.
        activity({
          ...settings,
          name,
          execute: (argument: DocumentActivityArgument, activityContext?: ActivityContext) =>
            execute(argument, activityContext),
        }),
      ] as const;
    }),
  );
  // Only a document that calls a child carries the admission activity, so no other document's
  // contract (and so its derived revision) changes.
  const admission =
    host.workflowAdmission === undefined ||
    distinctStepValues(document, (step) => (step.kind === 'workflow' ? step.workflow : undefined))
      .length === 0
      ? undefined
      : documentAdmissionActivity(host.workflowAdmission);
  if (admission !== undefined) activities.set(WORKFLOW_ADMISSION_ACTIVITY, admission);
  const signalNames = distinctStepValues(document, (step) =>
    step.kind === 'await-signal' ? step.signal : undefined,
  );
  const workflowVersion = await workflowDocumentVersion(document);
  const revision = { name: document.name, workflowVersion };

  /** Throws when the host finds `value` outside the schema; a no-op for a document with none. */
  const checkSchema = (point: 'input' | 'output', value: unknown): void => {
    const schema = point === 'input' ? document.inputSchema : document.outputSchema;
    if (schema === undefined || host.checkSchema === undefined) return;
    const issues = host.checkSchema(point, schema, value);
    if (issues.length > 0) throw new WorkflowDocumentSchemaError(`${point}-invalid`, issues);
  };

  const run = async function* (context: WorkflowContext, trigger: unknown) {
    const firedBy = trigger === undefined ? null : trigger;
    // Pure, and the same on a replay: it reads the recorded input and yields nothing.
    checkSchema('input', firedBy);
    // A run that begins now says so in its checkpoint, so its parallel steps advance on their own
    // whatever a recovered checkpoint holds (see `canAdvanceBranches`).
    markAdvancingRun(context);
    type RunState = { previous: unknown; pendingSignal: unknown; lastStepWasSignal: boolean };
    type RunSteps = (
      steps: readonly WorkflowDocument['steps'][number][],
      iteration: readonly (string | number)[],
      state: RunState,
    ) => Generator<ContextOperationRequest, unknown, unknown>;
    const indexOf = (step: WorkflowDocument['steps'][number]): number => {
      const index = stepIndexes.get(step);
      if (index === undefined) throw new Error('Document step is missing from its static index');
      return index;
    };
    function* runMap(
      step: Extract<WorkflowDocument['steps'][number], { kind: 'map' }>,
      index: number,
      iteration: readonly (string | number)[],
      state: RunState,
      runNested: RunSteps,
    ): Generator<ContextOperationRequest, void, unknown> {
      const source = mapSource(step, index, state.previous);
      const results: unknown[] = [];
      if (containsWait(step.steps)) {
        for (const [offset, value] of source.entries()) {
          const itemState: RunState = {
            previous: value,
            pendingSignal: undefined,
            lastStepWasSignal: false,
          };
          yield* runNested(step.steps, [...iteration, offset], itemState);
          results.push(itemState.lastStepWasSignal ? itemState.pendingSignal : itemState.previous);
        }
      } else {
        const batchSize = step.concurrency ?? 4;
        for (let start = 0; start < source.length; start += batchSize) {
          const generators = source.slice(start, start + batchSize).map((value, offset) => {
            const itemState: RunState = {
              previous: value,
              pendingSignal: undefined,
              lastStepWasSignal: false,
            };
            return (function* (): Generator<ContextOperationRequest, unknown, unknown> {
              return yield* runNested(step.steps, [...iteration, start + offset], itemState);
            })();
          });
          results.push(...(yield* runMapBatch(context, generators)));
        }
      }
      state.previous = results;
      state.pendingSignal = undefined;
    }
    /**
     * One `parallel` step. Each branch advances on its own, as soon as its current step settles,
     * and commits each step it settles, so a restart resumes every branch where it stopped.
     *
     * A run persisted before branches advanced on their own kept its parallel step as lockstep
     * rounds, numbered through the shared step counter, and holds that step's results where this
     * step would count its own: such a step finishes the way it began.
     */
    function* runParallel(
      step: Extract<WorkflowDocument['steps'][number], { kind: 'parallel' }>,
      iteration: readonly (string | number)[],
      state: RunState,
      runNested: RunSteps,
    ): Generator<ContextOperationRequest, void, unknown> {
      const branches = parallelBranches(step);
      const generators = branches.map(([name, nested]) => {
        const branchState: RunState = {
          previous: state.previous,
          pendingSignal: undefined,
          lastStepWasSignal: false,
        };
        return (function* (): Generator<ContextOperationRequest, unknown, unknown> {
          return yield* runNested(nested, [...iteration, name], branchState);
        })();
      });
      const results = canAdvanceBranches(context, generators.length)
        ? yield* advanceBranchesOf(context, generators)
        : yield* inLockstep(context, runMapBatch(context, generators));
      state.previous = Object.fromEntries(
        branches.map(([name], offset) => [name, results[offset]]),
      );
      state.pendingSignal = undefined;
    }
    /** One `activity` step: the handler runs with the step before it as `previous`. */
    function* runActivity(
      step: Extract<WorkflowDocument['steps'][number], { kind: 'activity' }>,
      index: number,
      iteration: readonly (string | number)[],
      address: string,
      state: RunState,
    ): Generator<ContextOperationRequest, void, unknown> {
      state.previous = yield* documentActivityOperation(
        context.run(activities.get(step.handler)!, {
          input: step.input ?? null,
          trigger: firedBy,
          previous: state.previous,
          ...(state.pendingSignal === undefined ? {} : { signal: state.pendingSignal }),
          workflowId: context.workflowId,
          step: index,
          iteration,
          stepAddress: address,
        }),
        index,
        address,
      );
      state.pendingSignal = undefined;
    }
    /**
     * One `workflow` step: the host's admission check runs first, as an activity of the step, then
     * the child starts under an id that derives from the instance and the step address, so a step a
     * restart re-issues re-attaches to its child. Its result is the step's result.
     */
    function* runWorkflow(
      step: Extract<WorkflowDocument['steps'][number], { kind: 'workflow' }>,
      index: number,
      iteration: readonly (string | number)[],
      address: string,
      state: RunState,
    ): Generator<ContextOperationRequest, void, unknown> {
      const input = step.input ?? null;
      if (admission !== undefined) {
        yield* documentActivityOperation(
          context.run(admission, {
            input,
            trigger: firedBy,
            previous: state.previous,
            workflowId: context.workflowId,
            step: index,
            iteration,
            stepAddress: address,
          }),
          index,
          address,
        );
      }
      const childInput =
        host.childInput === undefined
          ? input
          : host.childInput({
              workflow: step.workflow,
              workflowId: context.workflowId,
              trigger: firedBy,
              input,
              step: index,
              stepAddress: address,
            });
      state.previous = yield* context.startChild(step.workflow, childInput, {
        id: documentChildWorkflowId(context.workflowId, address),
      }) as unknown as Generator<ContextOperationRequest, unknown, unknown>;
      state.pendingSignal = undefined;
    }
    /** One `await-signal` step: a plain wait, or one that races a sleep when it has a `timeout`. */
    function* runAwaitSignal(
      step: Extract<WorkflowDocument['steps'][number], { kind: 'await-signal' }>,
      index: number,
      address: string,
      state: RunState,
    ): Generator<ContextOperationRequest, void, unknown> {
      if (step.timeout === undefined) {
        state.pendingSignal = yield* documentOperation(
          context.waitForSignal(step.signal),
          index,
          address,
        );
      } else {
        // The wait races a sleep: whichever finishes first is the recorded winner, so a
        // replay takes the same side without asking the clock again.
        const outcome = yield* documentOperation(
          context.raceKeyed({
            signal: documentOperation(context.waitForSignal(step.signal), index, address),
            timeout: context.sleep(step.timeout),
          }),
          index,
          address,
        );
        if (outcome.key === 'timeout') {
          // The marker takes the place of `previous`, exactly as an activity's result would.
          state.previous = { timedOut: true };
          state.pendingSignal = undefined;
          state.lastStepWasSignal = false;
          return;
        }
        state.pendingSignal = outcome.value;
      }
      // Pure and replayed from the recorded payload: a rejection ends the run before any later step.
      if (host.isRejection?.(state.pendingSignal, { ...revision, step: index }) === true) {
        throw new WorkflowDocumentReviewRejectedError();
      }
    }
    const runSteps = function* (
      steps: readonly WorkflowDocument['steps'][number][],
      iteration: readonly (string | number)[],
      state: RunState,
    ): Generator<ContextOperationRequest, unknown, unknown> {
      for (const step of steps) {
        const index = indexOf(step);
        const address = documentStepAddress(index, iteration);
        state.lastStepWasSignal = step.kind === 'await-signal';
        switch (step.kind) {
          case 'activity':
            yield* runActivity(step, index, iteration, address, state);
            break;
          case 'workflow':
            yield* runWorkflow(step, index, iteration, address, state);
            break;
          case 'sleep':
            yield* documentOperation(context.sleep(step.duration), index, address);
            break;
          case 'await-signal':
            yield* runAwaitSignal(step, index, address, state);
            break;
          case 'branch': {
            yield* runSteps(branchSteps(step, state.previous), iteration, state);
            break;
          }
          case 'map': {
            yield* runMap(step, index, iteration, state, runSteps);
            break;
          }
          case 'parallel': {
            yield* runParallel(step, iteration, state, runSteps);
            state.lastStepWasSignal = false;
            break;
          }
        }
      }
      return state.lastStepWasSignal ? state.pendingSignal : state.previous;
    };
    const state: RunState = { previous: null, pendingSignal: undefined, lastStepWasSignal: false };
    const output = yield* runSteps(document.steps, [], state);
    checkSchema('output', output);
    return output;
  };

  const builder = workflow({
    name: document.name,
    version: workflowVersion,
    tags: ['file-workflow'],
  }).activities(Object.fromEntries(activities));
  // A document that awaits no signal declares none, so its contract carries no `signals` entry.
  return signalNames.length === 0
    ? builder.execute(run)
    : builder
        .signals(Object.fromEntries(signalNames.map((name) => [name, signal(name)])))
        .execute(run);
}
