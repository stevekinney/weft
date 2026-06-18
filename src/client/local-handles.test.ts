import { describe, expect, it, mock } from 'bun:test';

import { LocalHandle, LocalScheduleHandle } from './local-handles.ts';

describe('LocalHandle', () => {
  it('delegates result and event listeners to the wrapped workflow handle', async () => {
    const result = mock(async () => 'wrapped-result');
    const addEventListener = mock(() => undefined);
    const removeEventListener = mock(() => undefined);
    const wrappedHandle = {
      id: 'workflow-1',
      result,
      addEventListener,
      removeEventListener,
    };
    const client = {} as never;
    const localHandle = new LocalHandle(wrappedHandle as never, client);
    const listener = () => undefined;

    await expect(localHandle.result()).resolves.toBe('wrapped-result');

    localHandle.addEventListener('workflow:completed', listener);
    localHandle.removeEventListener('workflow:completed', listener);
    expect(() => localHandle[Symbol.dispose]()).not.toThrow();

    expect(result).toHaveBeenCalledTimes(1);
    expect(addEventListener).toHaveBeenCalledWith('workflow:completed', listener, undefined);
    expect(removeEventListener).toHaveBeenCalledWith('workflow:completed', listener, undefined);
  });
});

describe('LocalScheduleHandle', () => {
  it('disposes as a no-op', () => {
    const scheduleHandle = new LocalScheduleHandle('schedule-1', {} as never);

    expect(() => scheduleHandle[Symbol.dispose]()).not.toThrow();
  });
});
