import { describe, expect, it } from 'bun:test';

import type {
  ActivityInterceptor,
  Interceptor,
  WorkflowInterceptor,
} from './interceptor-interfaces.ts';
import { WORKFLOW_INTERCEPTOR_HOOKS } from './interceptor-interfaces.ts';

// Compile-time exhaustiveness checks. Each `_check` constant fails to
// type-check (and thus fails to compile) when the relationships drift.

// 1. Every key on `WorkflowInterceptor` must exist on `Interceptor`.
type _WorkflowKeysOnInterceptor = keyof WorkflowInterceptor extends keyof Interceptor
  ? true
  : never;
const _workflowKeysCheck: _WorkflowKeysOnInterceptor = true;

// 2. Every key on `ActivityInterceptor` must exist on `Interceptor`.
type _ActivityKeysOnInterceptor = keyof ActivityInterceptor extends keyof Interceptor
  ? true
  : never;
const _activityKeysCheck: _ActivityKeysOnInterceptor = true;

// 3. `Interceptor` must not have keys that don't appear in either narrow
//    interface (catches accidental widening of the unified shape).
type _InterceptorKeysSubsetOfNarrow = keyof Interceptor extends
  | keyof WorkflowInterceptor
  | keyof ActivityInterceptor
  ? true
  : never;
const _interceptorKeysCheck: _InterceptorKeysSubsetOfNarrow = true;

// 4. `WORKFLOW_INTERCEPTOR_HOOKS` must enumerate every key of
//    `WorkflowInterceptor`. If a new optional hook is added to the
//    interface but not to the const tuple, splitInterceptors silently
//    drops interceptors that implement only that hook.
type WorkflowHookName = keyof WorkflowInterceptor;
type DeclaredHookName = (typeof WORKFLOW_INTERCEPTOR_HOOKS)[number];
type _DeclaredCoversAllInterfaceKeys = WorkflowHookName extends DeclaredHookName ? true : never;
type _InterfaceCoversAllDeclaredKeys = DeclaredHookName extends WorkflowHookName ? true : never;
const _hooksDeclaredAreOnInterface: _DeclaredCoversAllInterfaceKeys = true;
const _hooksOnInterfaceAreDeclared: _InterfaceCoversAllDeclaredKeys = true;

// Surface them so unused-locals / dead-code detection cannot prune the checks.
void [
  _workflowKeysCheck,
  _activityKeysCheck,
  _interceptorKeysCheck,
  _hooksDeclaredAreOnInterface,
  _hooksOnInterfaceAreDeclared,
];

describe('Interceptor type drift', () => {
  it('compile-time exhaustiveness checks pass', () => {
    // The real assertions live in the type system above. Reaching here
    // means tsc accepted them.
    expect(true).toBe(true);
  });

  it('a runtime smoke test of the both-sided shape', () => {
    const interceptor: Interceptor = {
      *activity(interception, next) {
        return yield* next(interception);
      },
      async execute(interception, next) {
        return next(interception);
      },
    };
    expect(typeof interceptor.activity).toBe('function');
    expect(typeof interceptor.execute).toBe('function');
  });
});
