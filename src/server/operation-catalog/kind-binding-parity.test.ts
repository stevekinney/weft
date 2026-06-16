import { describe, expect, it } from 'bun:test';

import { REST_BINDINGS, createLiveOperationRegistry } from '../rest-bindings.ts';

type LongLivedBindingKind = 'sse' | 'websocket-subscription';

type LongLivedBinding = {
  readonly operationName: string;
  readonly transportKind: LongLivedBindingKind;
};

const WEBSOCKET_SUBSCRIPTION_BINDINGS = [
  {
    operationName: 'weft.events.subscribe',
    transportKind: 'websocket-subscription',
  },
  {
    operationName: 'weft.workflows.events',
    transportKind: 'websocket-subscription',
  },
] as const satisfies ReadonlyArray<LongLivedBinding>;

function longLivedBindings(): ReadonlyArray<LongLivedBinding> {
  const bindings: LongLivedBinding[] = [...WEBSOCKET_SUBSCRIPTION_BINDINGS];
  for (const binding of REST_BINDINGS) {
    if (binding.transportKind !== 'sse' && binding.transportKind !== 'websocket-subscription') {
      continue;
    }
    bindings.push({
      operationName: binding.operationName,
      transportKind: binding.transportKind,
    });
  }
  return bindings;
}

describe('operation kind and transport binding parity', () => {
  it('declares a long-lived transport binding for every long-lived operation', () => {
    const registry = createLiveOperationRegistry();
    const bindings = longLivedBindings();

    for (const operation of registry.list()) {
      if (operation.kind !== 'stream' && operation.kind !== 'subscription') continue;
      const expectedTransportKind = operation.kind === 'stream' ? 'sse' : 'websocket-subscription';
      expect(
        bindings.some(
          (binding) =>
            binding.operationName === operation.name &&
            binding.transportKind === expectedTransportKind,
        ),
      ).toBe(true);
    }
  });

  it('keeps SSE bindings attached only to stream operations', () => {
    const registry = createLiveOperationRegistry();

    for (const binding of REST_BINDINGS) {
      if (binding.transportKind !== 'sse') continue;
      expect(registry.get(binding.operationName)?.kind).toBe('stream');
    }
  });

  it('keeps WebSocket subscription bindings attached only to subscription operations', () => {
    const registry = createLiveOperationRegistry();

    for (const binding of WEBSOCKET_SUBSCRIPTION_BINDINGS) {
      expect(registry.get(binding.operationName)?.kind).toBe('subscription');
    }
  });
});
