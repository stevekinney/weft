import { z } from 'zod';

import {
  createTestHost,
  readerContext,
  testEventSchema,
  type TestEvent,
  type TestHost,
} from '../src/handler/operation-handler.test-support.ts';
import {
  createOperationHandler,
  defineOperation,
  type CatalogSnapshot,
  type OperationHandler,
} from '../src/index.ts';
import { createOperationRegistry, snapshotOperationCatalog } from '../src/internals.ts';
import { createReplayAwareClosableIterable } from '../src/operations/closable-iterable.ts';
import type { OperationClientOptions } from './generate-operation-client.ts';

/** A formatter that returns its input, so a test reads the generator's own text. */
export function identityFormat(source: string): Promise<string> {
  return Promise.resolve(source);
}

const transports = {
  http: true,
  jsonRpcHttp: true,
  jsonRpcStdio: true,
  jsonRpcWebSocket: true,
} as const;

/** An operation served over JSON-RPC, with names no real catalog uses. */
const listJobs = defineOperation({
  name: 'probe.jobs.list',
  mcpExposable: false,
  summary: 'List jobs',
  destructive: false,
  tags: ['Jobs'],
  inputSchema: z.object({ limit: z.number().optional() }),
  outputSchema: z.object({
    jobs: z.array(z.object({ id: z.string(), state: z.enum(['open', 'done']) })),
  }),
  access: { kind: 'public' },
  transports,
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async () => ({ jobs: [] }),
});

const cancelJob = defineOperation({
  name: 'probe.jobs.cancel',
  mcpExposable: false,
  summary: 'Cancel a job',
  destructive: true,
  tags: ['Jobs'],
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.null(),
  access: { kind: 'public' },
  transports,
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async () => null,
});

/** An operation served over REST only, so the snapshot carries its binding. */
const getUser = defineOperation({
  name: 'probe.users.get',
  mcpExposable: false,
  summary: 'Get a user',
  destructive: false,
  tags: ['Users'],
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ id: z.string(), name: z.string() }),
  access: { kind: 'public' },
  transports: { ...transports, jsonRpcHttp: false, jsonRpcStdio: false, jsonRpcWebSocket: false },
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async ({ input }) => ({ id: input.id, name: 'Ada' }),
});

const watchInput = z.object({
  topic: z.string().optional(),
  kinds: z.union([z.string(), z.array(z.string())]).optional(),
  fromCursor: z.string().min(1).optional(),
});
const watchEnvelope = z.object({ subscriptionId: z.string(), cursor: z.string() });

/** Replays the feed after `fromCursor`, says so once the replay is delivered, then follows it live. */
async function* replayThenLive(
  host: TestHost,
  fromCursor: string | undefined,
  signal: AbortSignal,
  onReplayComplete: () => void,
): AsyncGenerator<TestEvent> {
  let index = fromCursor === undefined ? 0 : Number(fromCursor);
  const tail = host.feed.events.length;
  while (index < tail) {
    const event = host.feed.events[index];
    index += 1;
    if (event !== undefined) yield event;
  }
  onReplayComplete();
  yield* host.feed.subscribe(String(index), signal);
}

function watchOperation(name: string, httpRoute: boolean) {
  return defineOperation<typeof watchInput, typeof watchEnvelope, typeof testEventSchema, TestHost>(
    {
      name,
      kind: 'subscription',
      mcpExposable: false,
      summary: 'Follow the feed',
      destructive: false,
      tags: ['Jobs'],
      inputSchema: watchInput,
      outputSchema: watchEnvelope,
      eventSchema: testEventSchema,
      access: { kind: 'public' },
      transports: {
        http: httpRoute,
        jsonRpcHttp: false,
        jsonRpcWebSocket: true,
        jsonRpcStdio: false,
      },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async ({ input, host }) => {
        const controller = new AbortController();
        const iterable = createReplayAwareClosableIterable<TestEvent>(
          (onReplayComplete) =>
            replayThenLive(host, input.fromCursor, controller.signal, onReplayComplete),
          {
            close: () => {
              host.closed.count += 1;
              controller.abort();
            },
          },
        );
        return {
          subscriptionId: 'sub_1',
          envelope: { subscriptionId: 'sub_1', cursor: input.fromCursor ?? '0' },
          iterable,
          close: () => iterable.close(),
        };
      },
    },
  );
}

/** A subscription on the generic route: it replays, marks the end of the replay, then follows. */
export const watchJobs = watchOperation('probe.jobs.watch', true);

/** A subscription with no HTTP route, which a client over Server-Sent Events cannot open. */
export const auditJobs = watchOperation('probe.jobs.audit', false);

/** A subscription of another host, which a catalog composed from two hosts may leave out. */
export const watchOtherHost = watchOperation('other.feed.watch', true);

/** The operations the fixture catalog holds. */
export const fixtureOperations = [
  listJobs,
  cancelJob,
  getUser,
  watchJobs,
  auditJobs,
  watchOtherHost,
] as const;

/** A catalog snapshot of fixture operations whose names, tags and routes are not Weft's. */
export function fixtureSnapshot(): CatalogSnapshot {
  return snapshotOperationCatalog({
    operations: createOperationRegistry(fixtureOperations).list(),
    restBindings: [
      {
        method: 'GET',
        path: '/api/users/:id',
        pathParamNames: ['id'],
        operationName: 'probe.users.get',
        inputSources: { id: { kind: 'path', pathParam: 'id' } },
        success: { kind: 'json', status: 200 },
      },
    ],
  });
}

/** A handler that serves the fixture operations over a fresh feed the test can publish to. */
export function fixtureHandler(): { readonly host: TestHost; readonly handler: OperationHandler } {
  const host = createTestHost();
  const handler = createOperationHandler({
    operations: [watchJobs, auditJobs, watchOtherHost],
    host,
    authenticate: async () => readerContext(),
  });
  return { host, handler };
}

/** Options for the fixture catalog: a made-up package, server and factory. */
export function fixtureOptions(
  overrides: Partial<OperationClientOptions> = {},
): OperationClientOptions {
  return {
    packageName: '@example/probe',
    serverName: 'Probe',
    factoryName: 'createProbeClient',
    outputDirectory: 'src/generated',
    restPathPrefix: '/api',
    format: identityFormat,
    ...overrides,
  };
}
