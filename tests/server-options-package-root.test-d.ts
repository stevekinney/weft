import { createMetricsCollectorExporter, Engine, workflow } from '@lostgradient/weft';
import {
  serve,
  WorkerRegistry,
  type AuthConfig,
  type DashboardRouteTarget,
  type DiscoveryInfo,
  type PrometheusExporter,
  type RetryPolicy,
  type RoutingPolicy,
  type SchedulingPolicy,
  type ServeOptions,
  type TaskDispatch,
  type TaskQueue,
  type WeftServer,
} from '@lostgradient/weft/server';
import { handleRequest, type HandlerOptions } from '@lostgradient/weft/server/handler';

const packageRootEngine = new Engine();
const packageRootPrometheusExporter = createMetricsCollectorExporter(undefined);

const packageRootServeOptions: ServeOptions = {
  engine: packageRootEngine,
  prometheusExporter: packageRootPrometheusExporter,
};
void packageRootServeOptions;

const packageRootDashboardTarget: DashboardRouteTarget = new Response('<html></html>');
void packageRootDashboardTarget;

const packageRootDashboardHandlerTarget: DashboardRouteTarget = (_request, server) => {
  void server;
  return new Response('<html></html>');
};
void packageRootDashboardHandlerTarget;

const packageRootDashboardServeOptions: ServeOptions = {
  engine: packageRootEngine,
  dashboard: new Response('<html></html>'),
};
void packageRootDashboardServeOptions;

const packageRootDashboardHandlerServeOptions: ServeOptions = {
  engine: packageRootEngine,
  dashboard: packageRootDashboardHandlerTarget,
};
void packageRootDashboardHandlerServeOptions;

const invalidPackageRootDashboardServeOptions: ServeOptions = {
  engine: packageRootEngine,
  // @ts-expect-error dashboard must be a Bun route target.
  dashboard: { shell: true },
};
void invalidPackageRootDashboardServeOptions;

const removedMetricsCollectorServeOptions: ServeOptions = {
  engine: packageRootEngine,
  // @ts-expect-error `metricsCollector` is no longer a public package server option.
  metricsCollector: undefined,
};
void removedMetricsCollectorServeOptions;

const packageRootHandlerOptions: HandlerOptions = {
  prometheusExporter: packageRootPrometheusExporter,
};
void packageRootHandlerOptions;

// @ts-expect-error `metricsCollector` is no longer a public package handler option.
const removedMetricsCollectorHandlerOptions: HandlerOptions = { metricsCollector: undefined };
void removedMetricsCollectorHandlerOptions;

// Every option/handle TYPE named in ServeOptions / WeftServer / TaskDispatch is
// importable from the published '@lostgradient/weft/server' subpath. The `Engine`
// instance passed to `serve()` is the exception: it comes from the root
// '@lostgradient/weft' (imported on line 1), its canonical home, by design.
const packageRootRoutingPolicy: RoutingPolicy = 'least-loaded';
const packageRootSchedulingPolicy: SchedulingPolicy = 'fifo';
const packageRootDiscoveryInfo: DiscoveryInfo = { description: 'Example API' };
const packageRootReexportedExporter: PrometheusExporter = packageRootPrometheusExporter;
const packageRootAuth: AuthConfig = { apiKeys: ['secret'] };

const fullyTypedPackageRootServeOptions: ServeOptions = {
  engine: packageRootEngine,
  auth: packageRootAuth,
  maxRequestBodyBytes: 1_048_576,
  maxStreamConnectionsPerWorkflow: 100,
  workerShutdownTimeoutMs: 30_000,
  routingPolicy: packageRootRoutingPolicy,
  schedulingPolicy: packageRootSchedulingPolicy,
  discoveryInfo: packageRootDiscoveryInfo,
  prometheusExporter: packageRootReexportedExporter,
};
void fullyTypedPackageRootServeOptions;

const packageRootTaskDispatch: TaskDispatch = {
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
void packageRootTaskDispatch;

declare const packageRootServer: WeftServer;
const packageRootRegistry: WorkerRegistry = packageRootServer.registry;
const packageRootTaskQueue: TaskQueue = packageRootServer.taskQueue;
void packageRootRegistry;
void packageRootTaskQueue;

// WorkerRegistry is re-exported as a VALUE from the published subpath, so it is
// constructable — not merely nameable as a type.
const packageRootConstructedRegistry = new WorkerRegistry();
void packageRootConstructedRegistry;

// Regression guard for #708: `ServeOptions.engine` must accept BOTH
// documented construction patterns from the published package without a
// call-site cast — `new Engine({ storage })` (the default, empty registry —
// covered by `packageRootServeOptions` above) and `Engine.create({ workflows })`
// (a concretely narrowed, non-empty registry — the README "Hello, World"
// pattern, which used to fail with TS2322 before the fix).
async function verifyPackageRootConcreteWorkflowRegistryEngineAcceptedByServe(): Promise<void> {
  const greet = workflow({ name: 'greet' }).execute(async function* (_ctx, input: { a: number }) {
    return { b: input.a };
  });
  const concreteEngine = await Engine.create({ workflows: { greet } });
  const options: ServeOptions = { engine: concreteEngine };
  void options;

  await using server = serve({ engine: concreteEngine, port: 0 });
  void server;

  // Copilot review on #708 (PR #715): pin the same invariant for
  // `handleRequest`, symmetric with `ServeOptions.engine` above.
  void handleRequest(new Request('http://localhost/v1/health'), concreteEngine);
}
void verifyPackageRootConcreteWorkflowRegistryEngineAcceptedByServe;
