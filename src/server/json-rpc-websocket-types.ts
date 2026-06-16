import type { FleetEventFeed } from './fleet-event-feed.ts';
import type { OperationRegistry } from './operation-catalog.ts';
import type { Principal } from './principal.ts';
import type { WorkflowEventFeed } from './workflow-event-feed.ts';

export type JsonRpcWebSocketEmitter = {
  send(message: string): void;
};

export type JsonRpcWebSocketSessionOptions = {
  readonly registry: OperationRegistry;
  readonly engine: unknown;
  readonly principal: Principal;
  readonly emitter: JsonRpcWebSocketEmitter;
  readonly feed: WorkflowEventFeed;
  readonly fleetFeed?: FleetEventFeed;
  readonly maxSubscriptions?: number;
  readonly maxFrameBytes?: number;
  readonly transport?: 'jsonRpcHttp' | 'jsonRpcWebSocket' | 'jsonRpcStdio';
};

export type JsonRpcWebSocketSession = {
  handleMessage(frame: string): Promise<void>;
  close(): Promise<void>;
};
