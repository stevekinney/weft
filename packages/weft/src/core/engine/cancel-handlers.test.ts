import { describe, expect, it } from 'bun:test';

import { Engine } from '../engine.ts';
import { registerCancelHandler, takeCancelHandlers } from './cancel-handlers.ts';
import { getInternals } from './internals.ts';

describe('cancel handler registration', () => {
  it('unregisters a handler without dropping later handlers for the same workflow', () => {
    const engine = new Engine();
    const internals = getInternals(engine);
    const workflowId = 'workflow-with-cancel-handlers';
    const firstHandler = () => {};
    const secondHandler = () => {};

    const unregisterFirstHandler = registerCancelHandler(internals, workflowId, firstHandler);
    registerCancelHandler(internals, workflowId, secondHandler);

    unregisterFirstHandler();

    expect(takeCancelHandlers(internals, workflowId)).toEqual([secondHandler]);

    engine[Symbol.dispose]();
  });

  it('removes the workflow entry when the last handler unregisters', () => {
    const engine = new Engine();
    const internals = getInternals(engine);
    const workflowId = 'workflow-with-one-cancel-handler';
    const unregisterHandler = registerCancelHandler(internals, workflowId, () => {});

    unregisterHandler();

    expect(internals.cancelHandlersByWorkflow.has(workflowId)).toBe(false);

    engine[Symbol.dispose]();
  });
});
