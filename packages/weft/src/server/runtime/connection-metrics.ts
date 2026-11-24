import { METRICS } from '../../observability/metrics-catalog.ts';
import { MetricsCollector } from '../../observability/metrics.ts';
import type { ServerConnectionCounts } from './context.ts';

export function createConnectionMetrics(metricsCollector: MetricsCollector): {
  readonly connectionCounts: ServerConnectionCounts;
  readonly refreshConnectionMetrics: () => void;
} {
  const connectionCounts: ServerConnectionCounts = {
    fleetSse: 0,
    fleetWebSocket: 0,
    workflowSse: 0,
    workflowWebSocket: 0,
    workers: 0,
  };
  const refreshConnectionMetrics = (): void => {
    metricsCollector.gauge(METRICS.fleetSseConnections.name, connectionCounts.fleetSse);
    metricsCollector.gauge(METRICS.fleetWebSocketConnections.name, connectionCounts.fleetWebSocket);
    metricsCollector.gauge(METRICS.workflowSseConnections.name, connectionCounts.workflowSse);
    metricsCollector.gauge(
      METRICS.workflowWebSocketConnections.name,
      connectionCounts.workflowWebSocket,
    );
    metricsCollector.gauge(METRICS.workerConnections.name, connectionCounts.workers);
  };
  return { connectionCounts, refreshConnectionMetrics };
}
