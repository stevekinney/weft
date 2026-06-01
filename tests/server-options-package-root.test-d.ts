import { createMetricsCollectorExporter, Engine } from '@lostgradient/weft';
import type { ServeOptions } from '@lostgradient/weft/server';
import type { HandlerOptions } from '@lostgradient/weft/server/handler';

const packageRootEngine = new Engine();
const packageRootPrometheusExporter = createMetricsCollectorExporter(undefined);

const packageRootServeOptions: ServeOptions = {
  engine: packageRootEngine,
  prometheusExporter: packageRootPrometheusExporter,
};
void packageRootServeOptions;

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
