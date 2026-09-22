import { afterEach, expect, test } from 'bun:test';
import { resolveFixtureEnvironment } from './environment-configuration.ts';

const originalValues = new Map<string, string | undefined>();

function setEnvironment(name: string, value: string | undefined): void {
  if (!originalValues.has(name)) originalValues.set(name, Bun.env[name]);
  if (value === undefined) delete Bun.env[name];
  else Bun.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of originalValues) {
    if (value === undefined) delete Bun.env[name];
    else Bun.env[name] = value;
  }
  originalValues.clear();
});

test('conformance configuration preserves numeric defaults and Number semantics', () => {
  setEnvironment('WEFT_WORKER_PROTOCOL_VERSION', undefined);
  setEnvironment('WEFT_CONFORMANCE_HEARTBEAT_INTERVAL_MS', undefined);
  expect(resolveFixtureEnvironment().protocolVersion).toBe(6);
  expect(resolveFixtureEnvironment().heartbeatIntervalMs).toBe(10_000);
  setEnvironment('WEFT_WORKER_PROTOCOL_VERSION', '');
  expect(resolveFixtureEnvironment().protocolVersion).toBe(0);
  setEnvironment('WEFT_WORKER_PROTOCOL_VERSION', 'invalid');
  expect(resolveFixtureEnvironment().protocolVersion).toBeNaN();
  setEnvironment('WEFT_WORKER_PROTOCOL_VERSION', 'Infinity');
  expect(resolveFixtureEnvironment().protocolVersion).toBe(Infinity);
});

test('conformance activities are trimmed and empty entries are omitted', () => {
  setEnvironment('WEFT_WORKER_ACTIVITIES', ' first, , second ,');
  expect(resolveFixtureEnvironment().activities).toEqual(['first', 'second']);
  setEnvironment('WEFT_WORKER_ACTIVITIES', undefined);
  expect(resolveFixtureEnvironment().activities).toEqual([]);
});
