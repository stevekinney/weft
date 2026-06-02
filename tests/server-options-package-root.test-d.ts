import { createMetricsCollectorExporter, Engine } from '@lostgradient/weft';
import type { DashboardRouteTarget, ServeOptions } from '@lostgradient/weft/server';
import type { HandlerOptions } from '@lostgradient/weft/server/handler';

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

const legacyPackageRootServeOptions: ServeOptions = {
  engine: packageRootEngine,
  // @ts-expect-error `metricsCollector` is no longer a public package server option.
  metricsCollector: undefined,
};
void legacyPackageRootServeOptions;

const packageRootHandlerOptions: HandlerOptions = {
  prometheusExporter: packageRootPrometheusExporter,
};
void packageRootHandlerOptions;

// @ts-expect-error `metricsCollector` is no longer a public package handler option.
const legacyPackageRootHandlerOptions: HandlerOptions = { metricsCollector: undefined };
void legacyPackageRootHandlerOptions;
