import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import type { FaultCode } from '../../core/fault-code.ts';
import type { OperationFault } from '../operation-fault.ts';
import { raiseFault } from './raise-fault.ts';

const originalNodeEnvironment = Bun.env['NODE_ENV'];
const originalStrictFaults = Bun.env['WEFT_STRICT_FAULTS'];

function restoreEnvironmentVariable(
  name: 'NODE_ENV' | 'WEFT_STRICT_FAULTS',
  value: string | undefined,
): void {
  if (value === undefined) {
    delete Bun.env[name];
    return;
  }
  Bun.env[name] = value;
}

function conflictFault(): OperationFault {
  return {
    code: 'Conflict',
    message: 'workflow already exists',
    data: { reason: 'workflow already exists' },
  };
}

function operationWithFaults(producibleFaults: readonly FaultCode[] = []): {
  readonly name: string;
  readonly producibleFaults?: readonly FaultCode[];
} {
  return { name: 'weft.test.operation', producibleFaults };
}

function captureThrown(callback: () => void): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error('expected callback to throw');
}

describe('raiseFault', () => {
  afterEach(() => {
    restoreEnvironmentVariable('NODE_ENV', originalNodeEnvironment);
    restoreEnvironmentVariable('WEFT_STRICT_FAULTS', originalStrictFaults);
  });

  it('throws declared faults as-is', () => {
    const fault = conflictFault();
    const thrown = captureThrown(() => raiseFault(operationWithFaults(['Conflict']), fault));

    expect(thrown).toBe(fault);
  });

  it('throws a hard error for undeclared faults in test and development mode', () => {
    delete Bun.env['NODE_ENV'];
    delete Bun.env['WEFT_STRICT_FAULTS'];
    const fault = conflictFault();

    const thrown = captureThrown(() => raiseFault(operationWithFaults(), fault));

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBe(fault);
    expect(String((thrown as Error).message)).toContain(
      'Operation "weft.test.operation" raised undeclared fault "Conflict"',
    );
  });

  it('throws the original undeclared fault and logs in production mode', () => {
    Bun.env['NODE_ENV'] = 'production';
    delete Bun.env['WEFT_STRICT_FAULTS'];
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    const fault = conflictFault();

    try {
      const thrown = captureThrown(() => raiseFault(operationWithFaults(), fault));

      expect(thrown).toBe(fault);
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError.mock.calls[0]?.[0]).toContain(
        'Operation "weft.test.operation" raised undeclared fault "Conflict"',
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('uses strict mode when WEFT_STRICT_FAULTS is set in production', () => {
    Bun.env['NODE_ENV'] = 'production';
    Bun.env['WEFT_STRICT_FAULTS'] = '1';
    const fault = conflictFault();

    const thrown = captureThrown(() => raiseFault(operationWithFaults(), fault));

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBe(fault);
  });

  it('allows universal fault defaults without explicit declarations', () => {
    const faults: OperationFault[] = [
      { code: 'Unauthorized', message: 'missing credentials', data: { reason: 'missing' } },
      { code: 'Forbidden', message: 'missing scope', data: { reason: 'scope' } },
      { code: 'InvalidParams', message: 'invalid params', data: { issues: [] } },
      { code: 'EngineFailure', message: 'internal error', data: {} },
    ];

    for (const fault of faults) {
      const thrown = captureThrown(() => raiseFault(operationWithFaults(), fault));
      expect(thrown).toBe(fault);
    }
  });
});
