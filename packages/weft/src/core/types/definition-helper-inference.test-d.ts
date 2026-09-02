/**
 * Type-level tests asserting that the schema-driven inference overloads on
 * the definition helpers produce the right `TInput` / `TOutput` types when a
 * Standard Schema is supplied — without requiring an explicit generic.
 *
 * Every assertion uses `Equals<actual, expected>` to catch silent `unknown`
 * widening, which `expectType<T>(value)` (assignability only) would miss.
 */

import { z } from 'zod';

import { Engine } from '../engine/index.ts';
import { activity, type ActivityCallable } from './activity.ts';
import {
  query,
  signal,
  update,
  type QueryDefinition,
  type SignalDefinition,
  type UpdateDefinition,
} from './message-handles.ts';
import type { BuiltWorkflowDefinition } from './workflow-builder.ts';
import { workflow } from './workflow-function.ts';

// ---------------------------------------------------------------------------
// Helper: strict type equality
// ---------------------------------------------------------------------------

type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

// Each `_check_*: Equals<...> = true` line is the assertion. If inference
// regresses to `unknown`, the conditional resolves to `false` and the
// assignment fails, surfacing the regression at typecheck time.

// ---------------------------------------------------------------------------
// signal() — inference + transform
// ---------------------------------------------------------------------------

const approvalSchema = z.object({ approved: z.boolean() });
const inferredSignal = signal('approval', { inputSchema: approvalSchema });
const _check_signal_inference: Equals<
  typeof inferredSignal,
  SignalDefinition<{ approved: boolean }>
> = true;
void _check_signal_inference;

const explicitSignal = signal<{ approved: boolean }>('approval');
const _check_signal_explicit_equals_inferred: Equals<typeof explicitSignal, typeof inferredSignal> =
  true;
void _check_signal_explicit_equals_inferred;

// Transform: handler should receive the schema's *output* type (post-parse),
// not the raw input. `z.string().transform(s => s.length)` parses string ->
// number; the handler reads `number`.
const transformedSchema = z.string().transform((s) => s.length);
const transformedSignal = signal('count', { inputSchema: transformedSchema });
const _check_signal_transform: Equals<typeof transformedSignal, SignalDefinition<number>> = true;
void _check_signal_transform;

// ---------------------------------------------------------------------------
// update() — input + output, input-only, transform
// ---------------------------------------------------------------------------

const updateInputSchema = z.object({ id: z.string() });
const updateOutputSchema = z.object({ accepted: z.boolean() });

const inferredUpdate = update('approve', {
  inputSchema: updateInputSchema,
  outputSchema: updateOutputSchema,
});
const _check_update_both: Equals<
  typeof inferredUpdate,
  UpdateDefinition<{ id: string }, { accepted: boolean }>
> = true;
void _check_update_both;

const inferredUpdateInputOnly = update('approve', {
  inputSchema: updateInputSchema,
});
const _check_update_input_only: Equals<
  typeof inferredUpdateInputOnly,
  UpdateDefinition<{ id: string }>
> = true;
void _check_update_input_only;

// ---------------------------------------------------------------------------
// query() — output-only, both
// ---------------------------------------------------------------------------

const queryOutputSchema = z.object({ state: z.string() });

const inferredQueryOutputOnly = query('status', { outputSchema: queryOutputSchema });
const _check_query_output_only: Equals<
  typeof inferredQueryOutputOnly,
  QueryDefinition<void, { state: string }>
> = true;
void _check_query_output_only;

const inferredQueryBoth = query('status', {
  inputSchema: z.object({ id: z.string() }),
  outputSchema: queryOutputSchema,
});
const _check_query_both: Equals<
  typeof inferredQueryBoth,
  QueryDefinition<{ id: string }, { state: string }>
> = true;
void _check_query_both;

// ---------------------------------------------------------------------------
// workflow() — input + output via schema
// ---------------------------------------------------------------------------

const workflowInputSchema = z.object({ orderId: z.string() });
const workflowOutputSchema = z.object({ shipped: z.boolean() });

// The builder infers `TInput` / `TOutput` from the `.execute(fn)` handler
// signature, not from the `inputSchema` / `outputSchema` options. Annotating
// the handler parameters is the source of truth.
const inferredWorkflow = workflow({
  name: 'checkout',
  inputSchema: workflowInputSchema,
  outputSchema: workflowOutputSchema,
}).execute(async function* (_ctx, input: { orderId: string }) {
  const _check_workflow_input: Equals<typeof input, { orderId: string }> = true;
  void _check_workflow_input;
  yield;
  return { shipped: true };
});
const _check_workflow_definition: Equals<
  typeof inferredWorkflow,
  BuiltWorkflowDefinition<{ orderId: string }, { shipped: boolean }, 'checkout', {}, {}, {}, {}, {}>
> = true;
void _check_workflow_definition;

// ---------------------------------------------------------------------------
// activity() — input + output, transform on input
// ---------------------------------------------------------------------------

const activityInputSchema = z.object({ to: z.string() });
const activityOutputSchema = z.object({ sent: z.boolean() });

const inferredActivity = activity({
  name: 'sendEmail',
  inputSchema: activityInputSchema,
  outputSchema: activityOutputSchema,
  execute: async (input) => {
    const _check_activity_input: Equals<typeof input, { to: string }> = true;
    void _check_activity_input;
    return { sent: true };
  },
});
const _check_activity_callable: Equals<
  typeof inferredActivity,
  ActivityCallable<{ to: string }, { sent: boolean }, 'sendEmail'>
> = true;
void _check_activity_callable;

// Calling the activity with the inferred input type should typecheck.
void inferredActivity({ to: 'a@b.co' });

// Transform: input schema may parse string -> number; the handler reads number.
const transformedActivityInput = z.string().transform((s) => Number(s));
const transformedActivity = activity({
  name: 'parseNumber',
  inputSchema: transformedActivityInput,
  execute: async (input: number) => input * 2,
});
const _check_activity_transform: Equals<
  typeof transformedActivity,
  ActivityCallable<number, number, 'parseNumber'>
> = true;
void _check_activity_transform;

// ---------------------------------------------------------------------------
// Transform on outputSchema — caller-visible result is the schema's *output*
// (post-parse) type. This guards against regressing back to using
// `InferSchemaInput<TOutputSchema>` for the definition's TOutput position.
// ---------------------------------------------------------------------------

const transformedOutputSchema = z.string().transform(() => 42);

const updateTransformOutput = update('compute', {
  inputSchema: z.object({ x: z.number() }),
  outputSchema: transformedOutputSchema,
});
const _check_update_transform_output: Equals<
  typeof updateTransformOutput,
  UpdateDefinition<{ x: number }, number>
> = true;
void _check_update_transform_output;

const queryTransformOutputOnly = query('count', { outputSchema: transformedOutputSchema });
const _check_query_transform_output_only: Equals<
  typeof queryTransformOutputOnly,
  QueryDefinition<void, number>
> = true;
void _check_query_transform_output_only;

const queryTransformBoth = query('count', {
  inputSchema: z.object({ kind: z.string() }),
  outputSchema: transformedOutputSchema,
});
const _check_query_transform_both: Equals<
  typeof queryTransformBoth,
  QueryDefinition<{ kind: string }, number>
> = true;
void _check_query_transform_both;

const workflowTransformOutput = workflow({
  name: 'project',
  inputSchema: z.object({ x: z.number() }),
  outputSchema: transformedOutputSchema,
}).execute(async function* (_ctx, _input: { x: number }) {
  yield;
  return 42;
});
const _check_workflow_transform_output: Equals<
  typeof workflowTransformOutput,
  BuiltWorkflowDefinition<{ x: number }, number, 'project', {}, {}, {}, {}, {}>
> = true;
void _check_workflow_transform_output;

const activityTransformOutput = activity({
  name: 'project',
  inputSchema: z.object({ x: z.number() }),
  outputSchema: transformedOutputSchema,
  execute: async (_input) => 42,
});
const _check_activity_transform_output: Equals<
  typeof activityTransformOutput,
  ActivityCallable<{ x: number }, number, 'project'>
> = true;
void _check_activity_transform_output;

// ---------------------------------------------------------------------------
// Literal-import inference through `engine.register()` / `engine.start()` /
// `WorkflowHandle.result()` (WFT-5 regression pin — no new functionality;
// proves `core/contract`'s changes do not narrow or widen this inference).
// ---------------------------------------------------------------------------

const literalImportWorkflow = workflow({ name: 'literalImportRegressionCheck' }).execute(
  async function* (_ctx, input: { orderId: string }) {
    return { total: input.orderId.length };
  },
);

declare const literalImportEngine: Engine;
const literalImportRegistered = literalImportEngine.register(literalImportWorkflow);
const literalImportHandlePromise = literalImportRegistered.start('literalImportRegressionCheck', {
  orderId: 'ord_123',
});
const _check_literal_import_result: Equals<
  Awaited<ReturnType<Awaited<typeof literalImportHandlePromise>['result']>>,
  { total: number }
> = true;
void _check_literal_import_result;

// Input inference flows from the same literally-imported definition: a wrong
// input shape is a type error, not a silent `unknown` widening.
// @ts-expect-error: { orderId: string } expected, { total: number } given.
void literalImportRegistered.start('literalImportRegressionCheck', { total: 1 });
