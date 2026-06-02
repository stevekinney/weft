import { Engine } from '../core/engine.ts';
import { createMetricsCollectorExporter, MetricsCollector } from '../observability/metrics.ts';
import { MemoryStorage } from '../storage/memory.ts';
import type { HandlerOptions } from './handler.ts';
import type { DashboardRouteTarget, ServeOptions } from './index.ts';

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
