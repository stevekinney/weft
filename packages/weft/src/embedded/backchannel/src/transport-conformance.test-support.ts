import { waitUntil } from "../../../../test-support/embedded/testing/src/wait-until.ts";
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { join } from 'node:path';
import {
  CatalogClientError,
  createCatalogClient,
  createSubscriptionClient,
  type CatalogTransport,
  type SubscriptionTransport,
} from './client/index.ts';
import {
  FAULT_ENVELOPE_GOLDEN_DIRECTORY,
  GOLDEN_FAULTS,
} from './fault-envelope-golden.test-support.ts';
import { createTestHost, testEventSchema } from './handler/operation-handler.test-support.ts';
import { makeOperation } from './json-rpc-operation.test-support.ts';
import type { OperationFault } from './operation-fault.ts';

const faultCodes = Object.keys(GOLDEN_FAULTS) as Array<keyof typeof GOLDEN_FAULTS>;
const faultCode = z.enum(faultCodes);
const goldenPath = join(FAULT_ENVELOPE_GOLDEN_DIRECTORY, 'fault-envelopes.json');

type GoldenEnvelopes = Record<
  keyof typeof GOLDEN_FAULTS,
  {
    jsonRpc: { code: number; message: string; data: unknown };
    http: { status: number; body: unknown };
  }
>;

const throwGoldenFault = (code: keyof typeof GOLDEN_FAULTS): never => {
  throw { ...GOLDEN_FAULTS[code], remediation: 'golden' } satisfies OperationFault;
};

/** Builds the same catalog and replayable feed for each adapter under test. */
export function createTransportConformanceFixture() {
  const host = createTestHost();
  const operations = [
    makeOperation({
      name: 'probe.echo',
      inputSchema: z.object({ message: z.string() }),
      outputSchema: z.object({ message: z.string() }),
      invoke: async ({ input }) => input,
    }),
    makeOperation({
      name: 'probe.fault',
      inputSchema: z.object({ code: faultCode }),
      outputSchema: z.never(),
      producibleFaults: faultCodes,
      invoke: async ({ input }) => throwGoldenFault(input.code),
    }),
    makeOperation({
      name: 'probe.events',
      kind: 'subscription',
      inputSchema: z.object({ fromCursor: z.string().optional(), fault: faultCode.optional() }),
      outputSchema: z.object({ subscriptionId: z.string(), cursor: z.string() }),
      eventSchema: testEventSchema,
      producibleFaults: faultCodes,
      invoke: async ({ input }) => {
        if (input.fault !== undefined) throwGoldenFault(input.fault);
        const controller = new AbortController();
        const cursor = input.fromCursor ?? '0';
        return {
          subscriptionId: 'probe-subscription',
          envelope: { subscriptionId: 'probe-subscription', cursor },
          iterable: host.feed.subscribe(cursor, controller.signal),
          close: async () => {
            host.closed.count += 1;
            controller.abort();
          },
        };
      },
    }),
  ];
  return { host, operations };
}

/** A connected client/server pair, with an optional subscription channel. */
export type TransportConformancePair = {
  /** The connected unary client transport. */
  readonly call: CatalogTransport;
  /** The connected subscription client transport, when offered. */
  readonly subscribe?: SubscriptionTransport;
  /** HTTP SSE reports faults at subscription start as HTTP responses. */
  readonly expectHttpSubscriptionFaults?: boolean;
  /** Close the pair and release connected resources. */
  readonly close?: () => Promise<void>;
};

/** Runs shared unary, fault, replay and cancellation checks against a transport. */
export function describeTransportConformance(
  name: string,
  connect: (
    fixture: ReturnType<typeof createTransportConformanceFixture>,
  ) => TransportConformancePair,
  options: { readonly subscriptions?: boolean } = {},
): void {
  async function withPair(
    run: (
      pair: TransportConformancePair,
      fixture: ReturnType<typeof createTransportConformanceFixture>,
    ) => Promise<void>,
  ): Promise<void> {
    const fixture = createTransportConformanceFixture();
    const pair = connect(fixture);
    try {
      await run(pair, fixture);
    } finally {
      await pair.close?.();
    }
  }

  describe(name, () => {
    it('dispatches a typed unary call', () =>
      withPair(async ({ call }) => {
        const client = createCatalogClient<{
          'probe.echo': { input: { message: string }; output: { message: string } };
        }>(['probe.echo'], call);
        expect(await client['probe.echo']({ message: 'hello' })).toEqual({ message: 'hello' });
      }));

    it('reports an unknown method and invalid params', () =>
      withPair(async ({ call }) => {
        expect(await rejected(() => call('probe.missing', {}))).toMatchObject({
          code: -32601,
          data: { weftCode: 'MethodNotFound' },
        });
        expect(await rejected(() => call('probe.echo', { message: 1 }))).toMatchObject({
          code: -32602,
          data: { weftCode: 'InvalidParams', issues: [{ path: ['message'] }] },
        });
      }));

    for (const code of faultCodes) {
      it(`preserves the ${code} envelope`, () =>
        withPair(async (pair) => {
          const envelopes = (await Bun.file(goldenPath).json()) as GoldenEnvelopes;
          const golden = envelopes[code];
          const error = await rejected(() => pair.call('probe.fault', { code }));
          expect({ code: error.code, message: error.message, data: error.data }).toEqual(
            golden.jsonRpc,
          );
          if (pair.expectHttpSubscriptionFaults && pair.subscribe !== undefined) {
            const stream = pair.subscribe('probe.events', { fault: code });
            const iterator = stream[Symbol.asyncIterator]();
            const failed = await rejected(() => iterator.next());
            expect(failed.code).toBe(golden.http.status);
            expect(failed.data).toEqual(golden.http.body);
          }
        }));
    }

    if (options.subscriptions === false) return;
    it('delivers in order, resumes after the cursor and ends on cancellation', () =>
      withPair(async ({ subscribe }, { host }) => {
        if (subscribe === undefined)
          throw new Error('The transport did not provide a subscription channel');
        const client = createSubscriptionClient<{
          'probe.events': { input: Record<string, never>; event: { kind: string; cursor: string } };
        }>(['probe.events'], subscribe);
        const watch = client['probe.events'];
        host.feed.publish('one');
        host.feed.publish('two');
        host.feed.publish('three');

        let cursor: string | undefined;
        for await (const message of watch({})) {
          if (message.type !== 'event') continue;
          expect(message.data.kind).toBe(cursor === undefined ? 'one' : 'two');
          const previous = cursor;
          cursor = message.id;
          expect(cursor).toBe(message.data.cursor);
          if (previous !== undefined) break;
        }
        expect(cursor).toBe('2');

        const controller = new AbortController();
        const resumed = watch({}, { lastEventId: cursor, signal: controller.signal })[
          Symbol.asyncIterator
        ]();
        try {
          let next = await resumed.next();
          while (next.done !== true && next.value.type === 'replay-complete')
            next = await resumed.next();
          expect(next).toMatchObject({
            done: false,
            value: { type: 'event', id: '3', data: { kind: 'three' } },
          });
          const pending = resumed.next();
          controller.abort();
          expect(await pending).toMatchObject({ done: true });
        } finally {
          controller.abort();
          await resumed.return?.();
        }
        await waitUntil(() => host.closed.count === 2, { message: 'both subscriptions to close' });
      }));
  });
}

async function rejected(call: () => Promise<unknown>): Promise<CatalogClientError> {
  try {
    await call();
  } catch (error) {
    if (error instanceof CatalogClientError) return error;
    throw error;
  }
  throw new Error('Expected a catalog fault');
}
