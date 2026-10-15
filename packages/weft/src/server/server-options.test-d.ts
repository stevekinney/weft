import { Engine } from '../core/engine.ts';
import { workflow } from '../core/types.ts';
import { createMetricsCollectorExporter, MetricsCollector } from '../observability/metrics.ts';
import { MemoryStorage } from '../storage/memory.ts';
import type { HandlerOptions } from './handler.ts';
import {
  serve,
  TaskQueue,
  WorkerRegistry,
  type AuthConfig,
  type DiscoveryInfo,
  type PrometheusExporter,
  type RetryPolicy,
  type RoutingPolicy,
  type SchedulingPolicy,
  type ServeOptions,
  type ServeRoutes,
  type TaskDispatch,
  type TaskResultView,
  type WeftServer,
  type WorkerAdmissionDecision,
  type WorkerAdmissionPolicy,
  type WorkerAdmissionRequest,
} from './index.ts';

const engine = new Engine({ storage: new MemoryStorage() });
const prometheusExporter = createMetricsCollectorExporter(new MetricsCollector());

const serveOptions: ServeOptions = { engine, prometheusExporter };
void serveOptions;

const lockedDownServeOptions: ServeOptions = {
  engine,
  auth: { apiKeys: ['test-key'] },
  unauthenticatedAccess: 'reject',
};
void lockedDownServeOptions;

const staticRoutes: ServeRoutes = { '/status': new Response('ok') };
void staticRoutes;

const handlerRoutes: ServeRoutes = {
  '/reports/:id': (request, server) => {
    void server.upgrade;
    return Response.json({ id: request.params['id'] });
  },
  '/uploads': { POST: () => new Response(null, { status: 202 }) },
};
void handlerRoutes;

const routesServeOptions: ServeOptions = { engine, routes: { ...staticRoutes, ...handlerRoutes } };
void routesServeOptions;

const invalidRoutesServeOptions: ServeOptions = {
  engine,
  // @ts-expect-error each route must be a Bun route value.
  routes: { '/status': { shell: true } },
};
void invalidRoutesServeOptions;

const removedDashboardServeOptions: ServeOptions = {
  engine,
  // @ts-expect-error `dashboard` is no longer a server option; dashboard() mounts the dashboard.
  dashboard: new Response('<html></html>'),
};
void removedDashboardServeOptions;

// @ts-expect-error `metricsCollector` is no longer a public server option.
const rejectedServeOptions: ServeOptions = { engine, metricsCollector: new MetricsCollector() };
void rejectedServeOptions;

const handlerOptions: HandlerOptions = { prometheusExporter };
void handlerOptions;

// @ts-expect-error `metricsCollector` is no longer a public handler option.
const rejectedHandlerOptions: HandlerOptions = { metricsCollector: new MetricsCollector() };
void rejectedHandlerOptions;

// Every option/handle TYPE named in ServeOptions / WeftServer / TaskDispatch is
// importable from the '@lostgradient/weft' entry point — a consumer never
// reaches into a deep internal path to name one. The `Engine` instance passed to
// `serve()` is the exception: it comes from the root '@lostgradient/weft' (its
// canonical home, imported above), by design.
const routingPolicy: RoutingPolicy = 'round-robin';
const schedulingPolicy: SchedulingPolicy = 'priority';
const discoveryInfo: DiscoveryInfo = { description: 'Example API' };
const reexportedExporter: PrometheusExporter = prometheusExporter;
const auth: AuthConfig = { apiKeys: ['secret'] };

// WorkerAdmissionRequest and WorkerAdmissionDecision are nameable from the
// same '@lostgradient/weft' entry as WorkerAdmissionPolicy, so a
// consumer can type its own policy function without reaching into internals.
const workerAdmissionPolicy: WorkerAdmissionPolicy = (request: WorkerAdmissionRequest) => {
  const decision: WorkerAdmissionDecision =
    request.manifest.deployment.name === 'billing'
      ? { status: 'accepted' }
      : { status: 'rejected', reason: 'only the billing deployment may register' };
  return decision;
};

const fullyTypedServeOptions: ServeOptions = {
  engine,
  auth,
  maxRequestBodyBytes: 1_048_576,
  maxStreamConnectionsPerWorkflow: 100,
  workerShutdownTimeoutMs: 30_000,
  routingPolicy,
  schedulingPolicy,
  discoveryInfo,
  prometheusExporter: reexportedExporter,
  workerAdmissionPolicy,
};
void fullyTypedServeOptions;

// TaskDispatch and its RetryPolicy field type are nameable from the same entry.
const taskDispatch: TaskDispatch = {
  operationId: 'op-1',
  activityName: 'sendEmail',
  workflowType: 'exampleWorkflow',
  input: {},
  retryPolicy: {
    maxAttempts: 3,
    initialBackoff: '1s',
    backoffMultiplier: 2,
    maxBackoff: '30s',
  } satisfies RetryPolicy,
};
void taskDispatch;

// `registry` and `taskQueue` field types resolve to the re-exported types.
declare const server: WeftServer;
const registry: WorkerRegistry = server.registry;
const taskQueue: TaskQueue = server.taskQueue;
void registry;
void taskQueue;

// TaskResultView is nameable from the same entry — it is the return type of
// WeftServer.getTaskResult, WFT-24's adoption/retention read surface.
async function verifyTaskResultViewNameable(): Promise<void> {
  const result: TaskResultView | null = await server.getTaskResult('op-1');
  if (result?.status === 'terminal' && result.disposition === 'resolved') {
    const digest: string = result.resultDigest;
    void digest;
  }
  if (result?.status === 'terminal' && result.disposition !== 'resolved') {
    // @ts-expect-error Synthetic terminal digests are intentionally excluded from the public view.
    void result.resultDigest;
    const adoptionToken: string = result.adoptionToken;
    const adopted: boolean = await server.adoptTaskResult('op-1', adoptionToken);
    void adopted;
  }
  void result;
}
void verifyTaskResultViewNameable;

// WorkerRegistry is re-exported as a VALUE (matching the root export), so it is
// constructable from `/server` — not merely nameable as a type.
const constructedRegistry = new WorkerRegistry();
void constructedRegistry;

// TaskQueue is also a VALUE because direct handleRequest() hosts must construct
// the matching live queue and registry without importing server internals.
const constructedTaskQueue = new TaskQueue();
const liveHandlerOptions: HandlerOptions = {
  workerRegistry: constructedRegistry,
  taskQueue: constructedTaskQueue,
};
void liveHandlerOptions;
void constructedTaskQueue;

// Regression guard for #455: Engine.create({ storage, workflows: {} }) must
// produce an Engine<DefaultWorkflowRegistry> and therefore satisfy
// ServeOptions['engine'] — identical to Engine.create({ storage }) with no
// workflows map. Before the fix, the empty-object map routed to a custom
// registry overload returning Engine<{}>, which was missing the
// [defaultWorkflowRegistry] brand and therefore could not satisfy ServeOptions.
async function verifyEmptyWorkflowsEngineAcceptedByServe(): Promise<void> {
  const emptyMapEngine = await Engine.create({ storage: new MemoryStorage(), workflows: {} });
  const options: ServeOptions = { engine: emptyMapEngine };
  void options;
}
void verifyEmptyWorkflowsEngineAcceptedByServe;

// Regression guard for #708: `ServeOptions.engine` must accept BOTH
// documented construction patterns without a call-site cast —
// `new Engine({ storage })` (the default, empty registry — covered by
// `serveOptions` above) and `Engine.create({ workflows })` (a concretely
// narrowed, non-empty registry — the README "Hello, World" pattern, which
// used to fail with TS2322 before the fix). `serve()` itself is called, not
// just `ServeOptions`, so this also pins that `serve({ engine, port })`
// type-checks end to end.
async function verifyConcreteWorkflowRegistryEngineAcceptedByServe(): Promise<void> {
  const greet = workflow({ name: 'greet' }).execute(async function* (_ctx, input: { a: number }) {
    return { b: input.a };
  });
  const concreteEngine = await Engine.create({
    storage: new MemoryStorage(),
    workflows: { greet },
  });
  const options: ServeOptions = { engine: concreteEngine };
  void options;

  await using concreteEngineServer = serve({ engine: concreteEngine, port: 0 });
  void concreteEngineServer;
}
void verifyConcreteWorkflowRegistryEngineAcceptedByServe;
