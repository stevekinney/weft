import type { LLMProvider } from '../../ai/agent/index.ts';
import type { Storage as WeftStorage } from '../../storage/interface.ts';
import type { ConstraintDefinition } from '../constraint.ts';
import type { ExecutionStrategy } from '../execution-strategy.ts';
import type { InlineExecutionStrategy } from '../inline-execution-strategy.ts';
import type { TenantContext } from '../tenant.ts';
import type {
  Checkpoint,
  DefinitionSchema,
  EngineOptions,
  NormalizedRetentionPolicy,
  SearchAttributeSchema,
  WorkflowFunction,
  WorkflowTimelineEntry,
} from '../types.ts';
import type { WorkflowVersionTuple } from '../workflow-version-tuple.ts';

export interface RegistrationEntry {
  handler: WorkflowFunction;
  version: string;
  description?: string;
  tags?: ReadonlyArray<string>;
  inputSchema?: DefinitionSchema;
  outputSchema?: DefinitionSchema;
  migrate?: (checkpoint: unknown, fromVersion: string) => unknown;
  searchAttributes?: SearchAttributeSchema;
  retention?: NormalizedRetentionPolicy;
  isAgent?: boolean;
  provider?: LLMProvider;
  constraints?: ConstraintDefinition[];
  versionTupleForTenant?: (
    tenant: import('../tenant.ts').TenantContext | undefined,
  ) => WorkflowVersionTuple;
}

export interface ResolvedOptions {
  storage: WeftStorage;
  development: boolean;
  checkpointHistory: number;
  checkpointSizeWarningThreshold: number;
  maxNestingDepth: number;
  broadcastEvents: boolean;
  suspendOnLlmWait: boolean;
  retention: NormalizedRetentionPolicy | null;
  retentionSweepIntervalMs: number;
  retentionSweepBatchSize: number;
  getNow: () => number;
  tenantResolver: import('../tenant.ts').TenantResolver | undefined;
}

export interface WorkflowResultWaiter {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export type EngineConstructorOptions = Partial<EngineOptions> & { getNow?: () => number };

export type ExecutionStrategyBundle = {
  strategy: ExecutionStrategy;
  inlineStrategy: InlineExecutionStrategy | null;
};

export type TrackedWaiterKeys = string | Set<string>;

export type PendingTimelineEntry = {
  startedAt: number;
  entry: WorkflowTimelineEntry;
};

export type QueuedInlineWorkflowExecutionStart = {
  workflowId: string;
  workflowType: string;
  input: unknown;
  checkpoint: Checkpoint;
  nestingDepth: number;
  executionDeadline: number | undefined;
  executionStateOwnerId: string;
  tenant: TenantContext | undefined;
};
