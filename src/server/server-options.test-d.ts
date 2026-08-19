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
  type DashboardAssets,
  type DashboardRouteTarget,
  type DiscoveryInfo,
  type PrometheusExporter,
  type RetryPolicy,
  type RoutingPolicy,
  type SchedulingPolicy,
  type ServeOptions,
  type TaskDispatch,
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

const dashboardTarget: DashboardRouteTarget = new Response('<html></html>');
void dashboardTarget;

const dashboardAssets: DashboardAssets = { prefix: '/assets', directory: './dist/assets' };
void dashboardAssets;

const dashboardHandlerTarget: DashboardRouteTarget = (_request, server) => {
  void server;
  return new Response('<html></html>');
};
void dashboardHandlerTarget;

const dashboardServeOptions: ServeOptions = {
  engine,
  dashboard: new Response('<html></html>'),
};
void dashboardServeOptions;

const functionDashboardServeOptions: ServeOptions = {
  engine,
  dashboard: dashboardHandlerTarget,
  dashboardAssets,
};
void functionDashboardServeOptions;

const invalidDashboardServeOptions: ServeOptions = {
  engine,
  // @ts-expect-error dashboard must be a Bun route target.
  dashboard: { shell: true },
};
void invalidDashboardServeOptions;

// @ts-expect-error `metricsCollector` is no longer a public server option.
const rejectedServeOptions: ServeOptions = { engine, metricsCollector: new MetricsCollector() };
void rejectedServeOptions;

const handlerOptions: HandlerOptions = { prometheusExporter };
void handlerOptions;

// @ts-expect-error `metricsCollector` is no longer a public handler option.
const rejectedHandlerOptions: HandlerOptions = { metricsCollector: new MetricsCollector() };
void rejectedHandlerOptions;

// Every option/handle TYPE named in ServeOptions / WeftServer / TaskDispatch is
// importable from the '@lostgradient/weft/server' entry point — a consumer never
// reaches into a deep internal path to name one. The `Engine` instance passed to
// `serve()` is the exception: it comes from the root '@lostgradient/weft' (its
// canonical home, imported above), by design.
const routingPolicy: RoutingPolicy = 'round-robin';
const schedulingPolicy: SchedulingPolicy = 'priority';
const discoveryInfo: DiscoveryInfo = { description: 'Example API' };
const reexportedExporter: PrometheusExporter = prometheusExporter;
const auth: AuthConfig = { apiKeys: ['secret'] };

// WorkerAdmissionRequest and WorkerAdmissionDecision are nameable from the
// same '@lostgradient/weft/server' entry as WorkerAdmissionPolicy, so a
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
