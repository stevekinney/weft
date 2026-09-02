// This file exists to prove the generated `.d.ts` lands on the real
// `'@lostgradient/weft'` module identity. The tsconfig `paths` mapping resolves
// `'@lostgradient/weft'` to the in-repo source, so the module augmentation in
// `weft.generated.d.ts` extends the real `WorkflowRegistry`
// interface, not a hand-authored stub.
//
// `Engine` is imported as a TYPE (`import type` + `declare const`) rather than
// constructed (`new Engine()`). This test verifies *types* — that the augmented
// registry narrows `start`'s input/output — so it never needs a runtime
// instance. A value import pulled the entire engine runtime closure into the
// type-check graph, which made the compile take 60–110s and flake under
// parallel load in the pre-commit suite. The type-only import drops that to
// ~3s while exercising the exact same type machinery (verified: removing the
// `@ts-expect-error` below reports TS2769, and breaking the output narrowing
// reports TS2339 — the check is non-vacuous).
//
// `welcome` and `farewell` share the SAME generated input schema, so
// `weft.generated.d.ts` hoists it into one `__WeftSchema_...` alias
// referenced from both entries — this file is the only place that proves
// the alias syntax actually type-checks and narrows both call sites, not
// just that its string content looks right.

import type { Engine, WorkflowRegistry } from '@lostgradient/weft';
import type { WeftClient } from '@lostgradient/weft/client';

declare const engine: Engine;

// Positive: known workflow with the correct input shape narrows.
async function knownWorkflow(): Promise<void> {
  const handle = await engine.start('welcome', { name: 'Steve' });
  const output = await handle.result();
  output.greeting.toUpperCase();
}
void knownWorkflow;

// @ts-expect-error workflow input must match the augmented input type.
void engine.start('welcome', { wrongShape: true });

// A second workflow sharing `welcome`'s exact input schema, through the
// alias, still narrows correctly and independently from its own (distinct)
// output schema.
async function knownWorkflowViaAliasedInput(): Promise<void> {
  const handle = await engine.start('farewell', { name: 'Steve' });
  const output = await handle.result();
  output.message.toUpperCase();
}
void knownWorkflowViaAliasedInput;

// @ts-expect-error the aliased input type still rejects a mismatched shape.
void engine.start('farewell', { wrongShape: true });

// `welcome`'s output shape and `farewell`'s output shape are NOT aliased
// together (distinct schemas) — a `farewell` result has no `greeting`
// property.
void (async () => {
  const handle = await engine.start('farewell', { name: 'Steve' });
  const output = await handle.result();
  // @ts-expect-error a `farewell` result has no `greeting` property.
  void output.greeting;
})();

// The same generated augmentation also types the CLIENT surface. A client
// typed as `WeftClient` narrows `start`'s input to the registered workflow's
// input schema and `handle.result()` to its output schema — proving the
// generated `.d.ts` covers client call sites, not just `engine.start`.
declare const client: WeftClient;

async function knownWorkflowViaClient(): Promise<void> {
  const handle = await client.start('welcome', { name: 'Steve' });
  const output = await handle.result();
  output.greeting.toUpperCase();
}
void knownWorkflowViaClient;

// @ts-expect-error client workflow input must match the augmented input type.
void client.start('welcome', { wrongShape: true });

// Schedules consume the same registry-driven input typing.
async function scheduledWorkflowViaClient(): Promise<void> {
  await client.schedule('welcome', { name: 'Steve' }, '0 9 * * 1');
}
void scheduledWorkflowViaClient;

// @ts-expect-error client schedule input must match the augmented input type.
void client.schedule('welcome', { wrongShape: true }, '0 9 * * 1');

// `revision`/`workflowVersion` are compile-time-introspectable literal
// types on the augmented entry — never required by `start`/`schedule`
// (proven above: every call site omits them), but available for a
// consumer's own tooling to read.
type WelcomeRevision = WorkflowRegistry['welcome']['revision'];
type WelcomeWorkflowVersion = WorkflowRegistry['welcome']['workflowVersion'];
const welcomeRevision: WelcomeRevision =
  'sha256:459490e35ec0c6cab26b944ac5d023f0d3a581f3ab8229cd2ac3b500f779f924';
const welcomeWorkflowVersion: WelcomeWorkflowVersion = '0.0.0';
void welcomeRevision;
void welcomeWorkflowVersion;

// @ts-expect-error revision is a specific string-literal type, not plain `string`.
const wrongRevision: WelcomeRevision = 'not-the-real-revision';
void wrongRevision;
