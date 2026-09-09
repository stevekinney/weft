/**
 * Type-level tests for `workflowSource()`'s literal-import inference —
 * written before any runtime code, per this batch's TDD requirement. Proves
 * "a literal import preserves the definition's input and output inference"
 * (WFT-13 acceptance criterion) at the type level.
 */

import { workflowSource } from './workflow-source.ts';

type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

// ---------------------------------------------------------------------------
// Positive: a valid literal import + a real exportName infers TInput/TOutput/
// TName exactly, with no casts required at the call site.
// ---------------------------------------------------------------------------

const checkoutSource = workflowSource(
  {
    name: 'checkout',
    location: './__fixtures__/checkout-workflow.test-support.ts',
    exportName: 'checkout',
    revision: 'r1',
  },
  () => import('./__fixtures__/checkout-workflow.test-support.ts'),
);

const _check_input: Equals<NonNullable<typeof checkoutSource._input>, { orderId: string }> = true;
void _check_input;

const _check_output: Equals<
  NonNullable<typeof checkoutSource._output>,
  { shipped: boolean; orderId: string }
> = true;
void _check_output;

const _check_name: Equals<NonNullable<typeof checkoutSource._name>, 'checkout'> = true;
void _check_name;

// ---------------------------------------------------------------------------
// Negative: `exportName` that is not a key of the module fails at the call
// site — TS narrows the property's literal-union constraint.
// ---------------------------------------------------------------------------

void workflowSource(
  {
    name: 'checkout',
    location: './__fixtures__/checkout-workflow.test-support.ts',
    // @ts-expect-error 'doesNotExist' is not a key of the imported module.
    exportName: 'doesNotExist',
    revision: 'r1',
  },
  () => import('./__fixtures__/checkout-workflow.test-support.ts'),
);

// ---------------------------------------------------------------------------
// Negative: `exportName` IS a real key but not a WorkflowDefinition-shaped
// export. Compiles at the call site (real key), but TInput/TOutput/TName
// collapse to `never` — misuse fails at first *use* of the handle rather
// than at the workflowSource() call itself.
// ---------------------------------------------------------------------------

const nonWorkflowSource = workflowSource(
  {
    name: 'notAWorkflow',
    location: './__fixtures__/non-workflow-export.test-support.ts',
    exportName: 'notAWorkflow',
    revision: 'r1',
  },
  () => import('./__fixtures__/non-workflow-export.test-support.ts'),
);

const _check_non_workflow_input: Equals<NonNullable<typeof nonWorkflowSource._input>, never> = true;
void _check_non_workflow_input;
const _check_non_workflow_output: Equals<
  NonNullable<typeof nonWorkflowSource._output>,
  never
> = true;
void _check_non_workflow_output;
const _check_non_workflow_name: Equals<NonNullable<typeof nonWorkflowSource._name>, never> = true;
void _check_non_workflow_name;

// An export that is itself a module namespace object ("ambiguous export")
// is also not WorkflowDefinition-shaped, and collapses the same way.
const barrelSource = workflowSource(
  {
    name: 'namespaceBarrel',
    location: './__fixtures__/non-workflow-export.test-support.ts',
    exportName: 'namespaceBarrel',
    revision: 'r1',
  },
  () => import('./__fixtures__/non-workflow-export.test-support.ts'),
);
const _check_barrel_input: Equals<NonNullable<typeof barrelSource._input>, never> = true;
void _check_barrel_input;

// ---------------------------------------------------------------------------
// Negative: an untyped/dynamic import (TModule inferred as `any`) is
// rejected via the `IsAny` guard collapsing the descriptor parameter itself.
// ---------------------------------------------------------------------------

declare const dynamicPath: string;

void workflowSource(
  // @ts-expect-error a dynamic import path types the module as `any`, rejected by IsAny<TModule>.
  {
    name: 'checkout',
    location: dynamicPath,
    exportName: 'checkout',
    revision: 'r1',
  },
  () => import(dynamicPath),
);
