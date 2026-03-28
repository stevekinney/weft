export class AgentTurnStartedEvent extends Event {
  static readonly type = 'agent:turn:started' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly model: string;
  readonly inputTokenEstimate: number;
  readonly conversationLength: number;

  constructor(
    workflowId: string,
    agentId: string,
    turnIndex: number,
    model: string,
    inputTokenEstimate: number,
    conversationLength: number,
  ) {
    super(AgentTurnStartedEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.turnIndex = turnIndex;
    this.model = model;
    this.inputTokenEstimate = inputTokenEstimate;
    this.conversationLength = conversationLength;
  }
}

export class AgentTurnCompletedEvent extends Event {
  static readonly type = 'agent:turn:completed' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly model: string;
  readonly selectedModel: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost: number;
  readonly cumulativeCost: number;
  readonly duration: number;
  readonly toolCallCount: number;
  readonly fallbackAttempts: number;
  readonly reasoningTrace: string | undefined;

  constructor(
    workflowId: string,
    agentId: string,
    turnIndex: number,
    model: string,
    selectedModel: string,
    inputTokens: number,
    outputTokens: number,
    cost: number,
    cumulativeCost: number,
    duration: number,
    toolCallCount: number,
    fallbackAttempts: number,
    reasoningTrace: string | undefined,
  ) {
    super(AgentTurnCompletedEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.turnIndex = turnIndex;
    this.model = model;
    this.selectedModel = selectedModel;
    this.inputTokens = inputTokens;
    this.outputTokens = outputTokens;
    this.cost = cost;
    this.cumulativeCost = cumulativeCost;
    this.duration = duration;
    this.toolCallCount = toolCallCount;
    this.fallbackAttempts = fallbackAttempts;
    this.reasoningTrace = reasoningTrace;
  }
}

export class AgentToolCalledEvent extends Event {
  static readonly type = 'agent:tool:called' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly source: 'local' | 'mcp';
  readonly operationId: string;

  constructor(
    workflowId: string,
    agentId: string,
    turnIndex: number,
    toolName: string,
    toolInput: unknown,
    source: 'local' | 'mcp',
    operationId: string,
  ) {
    super(AgentToolCalledEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.turnIndex = turnIndex;
    this.toolName = toolName;
    this.toolInput = toolInput;
    this.source = source;
    this.operationId = operationId;
  }
}

export class AgentToolReturnedEvent extends Event {
  static readonly type = 'agent:tool:returned' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly toolName: string;
  readonly duration: number;
  readonly success: boolean;
  readonly operationId: string;

  constructor(
    workflowId: string,
    agentId: string,
    turnIndex: number,
    toolName: string,
    duration: number,
    success: boolean,
    operationId: string,
  ) {
    super(AgentToolReturnedEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.turnIndex = turnIndex;
    this.toolName = toolName;
    this.duration = duration;
    this.success = success;
    this.operationId = operationId;
  }
}

export class AgentBudgetWarningEvent extends Event {
  static readonly type = 'agent:budget:warning' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly budgetUsedPercent: number;
  readonly tokensRemaining: number;
  readonly costRemaining: number;
  readonly threshold: number;

  constructor(
    workflowId: string,
    agentId: string,
    budgetUsedPercent: number,
    tokensRemaining: number,
    costRemaining: number,
    threshold: number,
  ) {
    super(AgentBudgetWarningEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.budgetUsedPercent = budgetUsedPercent;
    this.tokensRemaining = tokensRemaining;
    this.costRemaining = costRemaining;
    this.threshold = threshold;
  }
}

export class AgentBudgetExceededEvent extends Event {
  static readonly type = 'agent:budget:exceeded' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly tokensUsed: number;
  readonly costUsed: number;
  readonly tokenBudget: number;
  readonly maxCost: number;

  constructor(
    workflowId: string,
    agentId: string,
    tokensUsed: number,
    costUsed: number,
    tokenBudget: number,
    maxCost: number,
  ) {
    super(AgentBudgetExceededEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.tokensUsed = tokensUsed;
    this.costUsed = costUsed;
    this.tokenBudget = tokenBudget;
    this.maxCost = maxCost;
  }
}

export class AgentContextCompactedEvent extends Event {
  static readonly type = 'agent:context:compacted' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly strategy: string;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly messagesDropped: number;

  constructor(
    workflowId: string,
    agentId: string,
    strategy: string,
    tokensBefore: number,
    tokensAfter: number,
    messagesDropped: number,
  ) {
    super(AgentContextCompactedEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.strategy = strategy;
    this.tokensBefore = tokensBefore;
    this.tokensAfter = tokensAfter;
    this.messagesDropped = messagesDropped;
  }
}

export class AgentModelFallbackEvent extends Event {
  static readonly type = 'agent:model:fallback' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly failedModel: string;
  readonly failedReason: string;
  readonly nextModel: string;
  readonly attemptIndex: number;

  constructor(
    workflowId: string,
    agentId: string,
    turnIndex: number,
    failedModel: string,
    failedReason: string,
    nextModel: string,
    attemptIndex: number,
  ) {
    super(AgentModelFallbackEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.turnIndex = turnIndex;
    this.failedModel = failedModel;
    this.failedReason = failedReason;
    this.nextModel = nextModel;
    this.attemptIndex = attemptIndex;
  }
}

export class AgentProviderCircuitOpenEvent extends Event {
  static readonly type = 'agent:provider:circuit-open' as const;
  readonly provider: string;
  readonly errorRate: number;
  readonly threshold: number;
  readonly windowDuration: number;

  constructor(provider: string, errorRate: number, threshold: number, windowDuration: number) {
    super(AgentProviderCircuitOpenEvent.type);
    this.provider = provider;
    this.errorRate = errorRate;
    this.threshold = threshold;
    this.windowDuration = windowDuration;
  }
}

export class HumanReviewRequestedEvent extends Event {
  static readonly type = 'human-review:requested' as const;
  readonly workflowId: string;
  readonly reviewId: string;
  readonly reviewType: string;
  readonly reviewers: string[];

  constructor(workflowId: string, reviewId: string, reviewType: string, reviewers: string[]) {
    super(HumanReviewRequestedEvent.type);
    this.workflowId = workflowId;
    this.reviewId = reviewId;
    this.reviewType = reviewType;
    this.reviewers = reviewers;
  }
}

export class HumanReviewCompletedEvent extends Event {
  static readonly type = 'human-review:completed' as const;
  readonly workflowId: string;
  readonly reviewId: string;
  readonly decision: string;
  readonly reviewer: string;
  readonly duration: number;

  constructor(
    workflowId: string,
    reviewId: string,
    decision: string,
    reviewer: string,
    duration: number,
  ) {
    super(HumanReviewCompletedEvent.type);
    this.workflowId = workflowId;
    this.reviewId = reviewId;
    this.decision = decision;
    this.reviewer = reviewer;
    this.duration = duration;
  }
}

export type WeftAgentEventMap = {
  'agent:turn:started': AgentTurnStartedEvent;
  'agent:turn:completed': AgentTurnCompletedEvent;
  'agent:tool:called': AgentToolCalledEvent;
  'agent:tool:returned': AgentToolReturnedEvent;
  'agent:budget:warning': AgentBudgetWarningEvent;
  'agent:budget:exceeded': AgentBudgetExceededEvent;
  'agent:context:compacted': AgentContextCompactedEvent;
  'agent:model:fallback': AgentModelFallbackEvent;
  'agent:provider:circuit-open': AgentProviderCircuitOpenEvent;
  'human-review:requested': HumanReviewRequestedEvent;
  'human-review:completed': HumanReviewCompletedEvent;
};
