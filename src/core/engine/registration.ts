import type { AgentContextOptions } from '../context.ts';
import { compileStepWorkflow, isAsyncGeneratorFunction } from '../step-context.ts';
import type {
  StepWorkflowFunction,
  WorkflowDefinition,
  WorkflowFunction,
  WorkflowRegistration,
} from '../types.ts';
import { validateDefinitionSchemaMetadata } from '../types.ts';
import { collectToolVersions, type WorkflowVersionTuple } from '../workflow-version-tuple.ts';
import type { EngineInternals } from './internals.ts';
import { normalizeRetentionPolicy } from './validation.ts';

type RegistrationEntry =
  EngineInternals['registrations'] extends Map<string, infer Entry> ? Entry : never;

type AgentToolCollection = NonNullable<AgentContextOptions['tools']>;

type AgentDefinitionLike = {
  name: string;
  model: string;
  version?: string;
  description?: string;
  systemPrompt?: string;
  tools?: AgentToolCollection;
  maxTurns?: number;
};

type AgentRegistrationOptionsLike = {
  provider: AgentContextOptions['provider'];
};

export type RegistrationCallbacks = {
  ensureRetentionSweepInterval: () => void;
  isAgentDefinition: (value: unknown) => value is AgentDefinitionLike;
};

function copiedTags(tags: ReadonlyArray<string> | undefined): string[] | undefined {
  return tags === undefined ? undefined : [...tags];
}

// oxlint-disable-next-line complexity -- ID:core-engine-register-complexity
export function register(
  internals: EngineInternals,
  nameOrAgent: unknown,
  handlerOrRegistrationOrOptions:
    | WorkflowFunction
    | StepWorkflowFunction
    | WorkflowDefinition
    | WorkflowRegistration
    | AgentRegistrationOptionsLike
    | undefined,
  callbacks: RegistrationCallbacks,
): void {
  // --- AgentDefinition overload ---
  if (callbacks.isAgentDefinition(nameOrAgent)) {
    const agentDef = nameOrAgent;
    const agentOptions = handlerOrRegistrationOrOptions as AgentRegistrationOptionsLike;
    const agentVersion = agentDef.version ?? '0.0.0';
    const workflowVersion = '1';
    const resolveVersionTuple = (): WorkflowVersionTuple => {
      return {
        workflowVersion,
        agentVersion,
        ...(agentDef.tools &&
          agentDef.tools.length > 0 && {
            toolVersions: collectToolVersions(agentDef.tools),
          }),
      };
    };

    // Build a workflow function that delegates to ctx.agent(), ensuring the
    // agent execution flows through the engine's operation handler for
    // observability and durable checkpointing.
    const handler: WorkflowFunction = async function* (ctx, input) {
      const prompt = typeof input === 'string' ? input : JSON.stringify(input);
      const agentOpts: AgentContextOptions = {
        model: agentDef.model,
        prompt,
        provider: agentOptions.provider,
      };
      if (agentDef.systemPrompt) agentOpts.systemPrompt = agentDef.systemPrompt;
      if (agentDef.tools) agentOpts.tools = agentDef.tools;
      if (agentDef.maxTurns !== undefined) agentOpts.maxTurns = agentDef.maxTurns;

      return yield* ctx.agent(agentOpts);
    };

    const agentRegistrationEntry: RegistrationEntry = {
      handler,
      version: workflowVersion,
      ...(agentDef.description === undefined ? {} : { description: agentDef.description }),
      isAgent: true,
      provider: agentOptions.provider,
      versionTupleForTenant: resolveVersionTuple,
    };

    internals.registrations.set(agentDef.name, agentRegistrationEntry);
    callbacks.ensureRetentionSweepInterval();
    internals.workflowTypesByHandler.set(handler, agentDef.name);
    return;
  }

  if (
    typeof nameOrAgent === 'object' &&
    nameOrAgent !== null &&
    'name' in nameOrAgent &&
    'handler' in nameOrAgent
  ) {
    const definition = nameOrAgent as WorkflowDefinition;
    register(internals, definition.name, definition, callbacks);
    return;
  }

  // --- Existing overloads (name + handler/registration) ---
  const name = nameOrAgent as string;
  const handlerOrRegistration = handlerOrRegistrationOrOptions as
    | WorkflowFunction
    | StepWorkflowFunction
    | WorkflowRegistration;

  const isRegistration =
    typeof handlerOrRegistration === 'object' &&
    handlerOrRegistration !== null &&
    'handler' in handlerOrRegistration;

  if (isRegistration) {
    const registration = handlerOrRegistration;
    const tags = copiedTags(registration.tags);
    const normalizedRetention = normalizeRetentionPolicy(
      registration.retention,
      `registration("${name}").retention`,
    );
    const entry: RegistrationEntry = {
      handler: registration.handler,
      version: registration.version ?? '1',
      ...(registration.description === undefined ? {} : { description: registration.description }),
      ...(tags === undefined ? {} : { tags }),
      ...(registration.inputSchema === undefined
        ? {}
        : {
            inputSchema: validateDefinitionSchemaMetadata(
              registration.inputSchema,
              `registration("${name}").inputSchema`,
            ),
          }),
      ...(registration.outputSchema === undefined
        ? {}
        : {
            outputSchema: validateDefinitionSchemaMetadata(
              registration.outputSchema,
              `registration("${name}").outputSchema`,
            ),
          }),
      ...(normalizedRetention !== null && { retention: normalizedRetention }),
    };
    if (registration.migrate) {
      entry.migrate = registration.migrate;
    }
    if (registration.searchAttributes) {
      entry.searchAttributes = registration.searchAttributes;
    }
    if (registration.constraints && registration.constraints.length > 0) {
      // Constraints are only evaluated by the inline execution strategy —
      // `evaluateConstraints` reads per-workflow context via
      // `internals.inlineStrategy.getContext(...)`. In worker execution mode the
      // inline strategy is absent, so every constraint would be silently
      // skipped. Fail loud at registration time rather than swallowing the
      // invariant at runtime.
      if (internals.inlineStrategy === null) {
        throw new Error(
          `Cannot register workflow "${name}" with constraints: constraints are not supported in worker execution mode. ` +
            `The engine was constructed with \`workerExecution\`, which runs workflows in a Web Worker where the inline ` +
            `execution context required by constraint evaluation is unavailable. Remove the \`constraints\` option, or ` +
            `construct the engine without \`workerExecution\` to run workflows inline.`,
        );
      }
      entry.constraints = registration.constraints;
    }
    internals.registrations.set(name, entry);
    callbacks.ensureRetentionSweepInterval();
    internals.workflowTypesByHandler.set(registration.handler, name);
  } else {
    // Auto-detect step-based (non-generator) workflow functions and compile them
    const originalHandler = handlerOrRegistration;
    let handler = handlerOrRegistration;
    if (typeof handler === 'function' && !isAsyncGeneratorFunction(handler)) {
      handler = compileStepWorkflow(handler as StepWorkflowFunction);
    }

    internals.registrations.set(name, {
      handler: handler as WorkflowFunction,
      version: '1',
    });
    callbacks.ensureRetentionSweepInterval();
    if (typeof originalHandler === 'function') {
      internals.workflowTypesByHandler.set(originalHandler, name);
    }
    if (typeof handler === 'function') {
      internals.workflowTypesByHandler.set(handler, name);
    }
  }
}

export function resolveWorkflowTypeTarget(
  internals: EngineInternals,
  target: string | Function,
  _callbacks: RegistrationCallbacks,
): string {
  if (typeof target === 'string') {
    return target;
  }

  const registeredType = internals.workflowTypesByHandler.get(target);
  if (registeredType) {
    return registeredType;
  }

  throw new Error(
    'Workflow functions used in composition operators must be registered before use. ' +
      'Pass the registered workflow type string or register the function on the engine first.',
  );
}
