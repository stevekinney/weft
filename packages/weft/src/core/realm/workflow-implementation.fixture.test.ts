import { describe, expect, it } from 'bun:test';

import {
  runFixtureWorkflow,
  WORKFLOW_IMPLEMENTATION_SENTINEL,
} from './__fixtures__/workflow-implementation.fixture.ts';

describe('revision-realm workflow implementation fixture', () => {
  it('echoes its input beside the sentinel a realm test looks for in the result', () => {
    const input = { orderId: 'order-1', lines: [1, 2] };

    expect(runFixtureWorkflow(input)).toEqual({
      echoed: input,
      sentinel: WORKFLOW_IMPLEMENTATION_SENTINEL,
    });
    expect(runFixtureWorkflow(undefined).echoed).toBeUndefined();
  });
});
