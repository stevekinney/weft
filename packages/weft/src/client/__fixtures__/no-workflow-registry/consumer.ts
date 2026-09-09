// Regression fixture for PR #953: proves WeftClient/LocalClient/HttpClient's
// start/startOrSignal/schedule fallback overload stays generic over its own
// <TName extends string>, even when a real caller in a real, unaugmented
// project supplies an explicit type argument.
//
// This lives in its own directory with its own tsconfig.json — a separate
// TypeScript program from tsconfig.test-d.json and tsconfig.package-test-d.json
// — specifically because BOTH of those shared programs include a file that
// augments WorkflowRegistry (src/core/type-ergonomics.test-d.ts and
// tests/package-root-type-ergonomics.test-d.ts respectively). Module
// augmentation is program-wide, not file-scoped, so KnownWorkflowName is
// never actually `never` in either shared compilation unit. Only a genuinely
// separate tsc invocation against this directory (no augmenting file in its
// `include`) reproduces the unaugmented-registry state a real downstream
// consumer has before running `weft codegen`.
//
// Verified (see empty-registry-overloads-typecheck.test.ts and its
// companion PR commit) that removing this overload's own <TName extends
// string> and rewriting UnknownNameWhenRegistryEmpty<TName> to
// UnknownNameWhenRegistryEmpty<string> makes every call below fail to
// compile with "Type '...' does not satisfy the constraint 'never'" against
// the FIRST (KnownWorkflowName) overload, because TypeScript only matches an
// overload against a call carrying explicit type arguments when that
// overload itself declares matching-arity type parameters.

import type { HttpClient, LocalClient, WeftClient } from '@lostgradient/weft';

declare const client: WeftClient;
void client.start<'my-workflow'>('my-workflow', null);
void client.startOrSignal<'my-workflow'>('my-workflow', null, { name: 'go' });
void client.schedule<'my-workflow'>('my-workflow', null, '0 9 * * 1');

declare const localClient: LocalClient;
void localClient.start<'my-workflow'>('my-workflow', null);
void localClient.startOrSignal<'my-workflow'>('my-workflow', null, { name: 'go' });
void localClient.schedule<'my-workflow'>('my-workflow', null, '0 9 * * 1');

declare const httpClient: HttpClient;
void httpClient.start<'my-workflow'>('my-workflow', null);
void httpClient.startOrSignal<'my-workflow'>('my-workflow', null, { name: 'go' });
void httpClient.schedule<'my-workflow'>('my-workflow', null, '0 9 * * 1');
