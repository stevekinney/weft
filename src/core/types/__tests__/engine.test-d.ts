// Phase 3 — type-only fixtures for `Engine.register(builderWorkflow)` and
// `Engine.create({ workflows })` flows. Every "test" is either an
// `@ts-expect-error` on a line that must fail to compile, or a `satisfies`
// assertion on a value whose inferred type must match the expected shape.
//
// Conventions inherited from `workflow-builder.test-d.ts`:
//   - No runtime assertions.
//   - One assertion per block. Comments explain the "why".
//
// Workflow names used here must NOT appear in any sibling `*.test-d.ts`
// augmentation of the global `WorkflowRegistry` (e.g. `type-ergonomics.test-d.ts`
// augments `welcome` and `registered`). The bun:test test-d config compiles all
// test-d files together, so any name in those augmentations would trip the
// `WorkflowAlreadyRegistered<TName>` guard on a freshly-typed `Engine`.

import { Engine } from '../../engine/index.ts';
import { signal } from '../message-handles.ts';
import { workflow } from '../workflow-function.ts';

// ---------------------------------------------------------------------------
// engine.register(builderWorkflow) — bare-expression name-conflict guard
// ---------------------------------------------------------------------------

const onboarding = workflow({ name: 'onboarding' }).execute(async function* (
  _ctx,
  input: { name: string },
) {
  return { greeting: `hello ${input.name}` };
});

const ordering = workflow({ name: 'ordering' }).execute(async function* (
  _ctx,
  input: { id: number },
) {
  return input.id;
});

declare const engineOne: Engine;
const engineWithOnboarding = engineOne.register(onboarding);
const engineWithBoth = engineWithOnboarding.register(ordering);

// New names widen the typed workflow registry. Both `start` lines must
// typecheck on the engine returned by the chained `register` calls.
void engineWithBoth.start('onboarding', { name: 'Ada' });
void engineWithBoth.start('ordering', { id: 1 });

const release = signal('engine-test-release');
void engineWithBoth.signal('workflow-id', release, undefined, { signalId: 'release-1' });

// engine.start with an unknown workflow name is a type error.
// @ts-expect-error: 'unknown-workflow' is not in the typed registry.
void engineWithBoth.start('unknown-workflow', {});

// Wrong input type fails to compile (input inference flows from the builder's
// generator function back through `Engine.register`).
// @ts-expect-error: { name } expected, number given.
void engineWithBoth.start('onboarding', 42);

// The WorkflowAlreadyRegistered brand actually fires when a name is already
// in the engine's typed workflow registry. Re-registering `onboarding` after
// the previous register call has widened the engine type must fail to compile
// on the call line itself.
// @ts-expect-error: 'onboarding' is already in the engine's workflow registry.
void engineWithBoth.register(onboarding);

// ---------------------------------------------------------------------------
// engine.registerWorkflows(map) widens just like Engine.create({ workflows })
// ---------------------------------------------------------------------------

declare const freshEngine: Engine;
const engineFromMap = freshEngine.registerWorkflows({ onboarding, ordering });
void engineFromMap.start('onboarding', { name: 'Ada' });
void engineFromMap.start('ordering', { id: 1 });
