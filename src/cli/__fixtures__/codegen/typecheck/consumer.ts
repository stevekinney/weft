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

import type { Engine } from '@lostgradient/weft';
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
