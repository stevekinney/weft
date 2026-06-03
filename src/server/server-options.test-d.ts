import { Engine } from '../core/engine.ts';
import { createMetricsCollectorExporter, MetricsCollector } from '../observability/metrics.ts';
import { MemoryStorage } from '../storage/memory.ts';
import type { HandlerOptions } from './handler.ts';
import {
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
};
void functionDashboardServeOptions;

const invalidDashboardServeOptions: ServeOptions = {
  engine,
  // @ts-expect-error dashboard must be a Bun route target.
  dashboard: { shell: true },
};
void invalidDashboardServeOptions;

// @ts-expect-error `metricsCollector` is no longer a public server option.
const legacyServeOptions: ServeOptions = { engine, metricsCollector: new MetricsCollector() };
void legacyServeOptions;

const handlerOptions: HandlerOptions = { prometheusExporter };
void handlerOptions;

// @ts-expect-error `metricsCollector` is no longer a public handler option.
const legacyHandlerOptions: HandlerOptions = { metricsCollector: new MetricsCollector() };
void legacyHandlerOptions;

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

const fullyTypedServeOptions: ServeOptions = {
  engine,
  auth,
  routingPolicy,
  schedulingPolicy,
  discoveryInfo,
  prometheusExporter: reexportedExporter,
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
