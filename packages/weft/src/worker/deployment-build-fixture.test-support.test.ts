import { describe, expect, it } from 'bun:test';

import { rejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { faultOf } from './deployment-build-fixture.test-support.ts';

describe('faultOf', () => {
  it('returns the operation fault a promise rejects with', async () => {
    const fault = { code: 'EngineFailure' as const, message: 'internal error', data: {} };

    expect(await faultOf(Promise.reject(fault))).toBe(fault);
  });

  it('refuses a rejection that is not an operation fault, keeping it as the cause', async () => {
    const failure = new Error('engine exploded');

    const refusal = await rejectionOf(faultOf(Promise.reject(failure)));

    expect((refusal as Error).message).toBe(
      'Expected an OperationFault, received Error: engine exploded',
    );
    expect((refusal as Error).cause).toBe(failure);
  });

  it('refuses a promise that resolves instead of faulting', async () => {
    const refusal = await rejectionOf(faultOf(Promise.resolve('fine')));

    expect((refusal as Error).message).toBe('Expected the operation to fault, but it succeeded.');
  });
});
