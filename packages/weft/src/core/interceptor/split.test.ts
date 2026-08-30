import { describe, expect, it } from 'bun:test';

import type {
  ActivityExecutionInterception,
  ActivityInterception,
} from './interception-contexts.ts';
import type { Interceptor } from './interceptor-interfaces.ts';
import { splitInterceptors } from './split.ts';

describe('splitInterceptors', () => {
  it('returns empty slices for an empty list', () => {
    expect(splitInterceptors([])).toEqual({ workflow: [], activity: [] });
  });

  it('splits workflow-only interceptors into the workflow side only', () => {
    const workflowInterceptor: Interceptor = {
      *activity(interception, next) {
        return yield* next(interception);
      },
    };

    expect(splitInterceptors([workflowInterceptor])).toEqual({
      workflow: [workflowInterceptor],
      activity: [],
    });
  });

  it('splits activity-only interceptors into the activity side only', () => {
    const activityInterceptor: Interceptor = {
      async execute(interception, next) {
        return next(interception);
      },
    };

    expect(splitInterceptors([activityInterceptor])).toEqual({
      workflow: [],
      activity: [activityInterceptor],
    });
  });

  it('includes both-sided interceptors in both slices', () => {
    const bothSidedInterceptor: Interceptor = {
      *activity(interception, next) {
        return yield* next(interception);
      },
      async execute(interception, next) {
        return next(interception);
      },
    };

    expect(splitInterceptors([bothSidedInterceptor])).toEqual({
      workflow: [bothSidedInterceptor],
      activity: [bothSidedInterceptor],
    });
  });

  it('detects class-based interceptors with prototype hooks', () => {
    class ClassInterceptor implements Interceptor {
      *activity(
        interception: ActivityInterception,
        next: (interception: ActivityInterception) => Generator<unknown, unknown, unknown>,
      ): Generator<unknown, unknown, unknown> {
        return yield* next(interception);
      }
    }

    const interceptor = new ClassInterceptor();

    expect(splitInterceptors([interceptor])).toEqual({
      workflow: [interceptor],
      activity: [],
    });
  });

  it('detects hooks inherited from a parent prototype', () => {
    class ParentInterceptor implements Interceptor {
      async execute(
        interception: ActivityExecutionInterception,
        next: (interception: ActivityExecutionInterception) => Promise<unknown>,
      ): Promise<unknown> {
        return next(interception);
      }
    }

    class ChildInterceptor extends ParentInterceptor {}

    const interceptor = new ChildInterceptor();

    expect(splitInterceptors([interceptor])).toEqual({
      workflow: [],
      activity: [interceptor],
    });
  });

  it('does not count execute when it is explicitly undefined', () => {
    const interceptor: Interceptor = {};
    Object.assign(interceptor, { execute: undefined });

    expect(splitInterceptors([interceptor])).toEqual({
      workflow: [],
      activity: [],
    });
  });

  it('skips interceptors with no recognized hooks', () => {
    const interceptor: Interceptor = {};

    expect(splitInterceptors([interceptor])).toEqual({
      workflow: [],
      activity: [],
    });
  });
});
