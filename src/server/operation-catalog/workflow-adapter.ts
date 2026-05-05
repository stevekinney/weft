import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import {
  WorkflowAlreadyExistsError,
  WorkflowNotRegisteredError,
} from '../../core/engine/errors.ts';
import { StartWorkflowValidationError } from '../../core/start-workflow-validation.ts';
import { QuotaExceededError } from '../../core/tenant-quotas.ts';
import type { WorkflowRegistration } from '../../core/types.ts';
import type { AccessPolicy } from '../authorization.ts';
import type { OperationFault } from '../operation-fault.ts';
import { invalidParamsFault } from '../operations/operation-helpers.ts';
import type {
  AuthorizationDecision,
  OperationContext,
  OperationDefinition,
  TransportAvailability,
  UnknownKeyPolicy,
} from './types.ts';
import { validateOperationName } from './types.ts';

const StartHandleSchema = z.object({
  workflowId: z.string(),
  status: z.string(),
});

type StartHandle = z.infer<typeof StartHandleSchema>;

type CatalogWorkflowRegistrationMetadata<Input> = Pick<
  WorkflowRegistration<Input>,
  'description' | 'inputSchema' | 'tags'
>;

/**
 * Options accepted by {@link catalogWorkflow}.
 *
 * `mcpExposable` is REQUIRED. There is no default. The plan's MCP-readiness
 * ratchet enforces explicit per-operation declaration of MCP exposability
 * (see `mcp-readiness.test.ts`); the adapter forwards the caller's choice
 * verbatim so cataloged workflows participate in the same ratchet.
 *
 * No `engine` field. The engine instance comes from the runtime dispatch
 * context (the same `Engine` that runs `executeOperation`). Binding the
 * adapter to a specific engine instance was a footgun: an adapter created
 * for engine A could be dispatched by engine B and silently start the
 * workflow on the wrong engine. The dispatch context is the single source
 * of truth.
 *
 * No `outputSchema` field. The response shape is fixed at
 * `{ workflowId, status }` — the workflow's own result schema belongs on a
 * future `getResult`-shaped operation.
 *
 * No `mode` field. v1 ships start-only semantics.
 */
export type CatalogWorkflowOptions<Input> = {
  readonly name: string;
  readonly mcpExposable: boolean;
  readonly workflowType: string;
  readonly summary?: string;
  readonly tags?: ReadonlyArray<string>;
  readonly inputSchema?: z.ZodObject<z.ZodRawShape>;
  readonly registration?: CatalogWorkflowRegistrationMetadata<Input>;
  readonly access: AccessPolicy;
  readonly transports: TransportAvailability;
  readonly unknownKeyPolicy: UnknownKeyPolicy;
  readonly authorize?: (context: OperationContext<Input>) => Promise<AuthorizationDecision>;
};

/**
 * `catalogWorkflow()` — wrap a registered workflow as a typed
 * `OperationDefinition`. Produces one cataloged `start` operation per
 * workflow. Always returns the start handle ({ workflowId, status });
 * never blocks awaiting the workflow result.
 *
 * Schemas are opt-in for v1; required when the operation is later flagged
 * as MCP-exposable (see `mcpExposable` ratchet in PR 6).
 */
export function catalogWorkflow<Input>(
  options: CatalogWorkflowOptions<Input>,
): OperationDefinition<Input, StartHandle> {
  const presentation = resolveCatalogWorkflowPresentation(options);
  validateOperationName(options.name);

  return {
    name: options.name,
    mcpExposable: options.mcpExposable,
    summary: presentation.summary,
    tags: presentation.tags,
    inputSchema: presentation.inputSchema,
    outputSchema: StartHandleSchema,
    access: copyAccessPolicy(options.access),
    // The adapter classifies engine errors into Conflict (workflow ID
    // already exists) and RateLimited (tenant quota exceeded), in
    // addition to the universal-default fault set.
    producibleFaults: ['Conflict', 'RateLimited'],
    transports: { ...options.transports },
    unknownKeyPolicy: { ...options.unknownKeyPolicy },
    ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
    invoke: async ({ input, engine }): Promise<StartHandle> => {
      // Engine is supplied by the dispatch context. The cast to `Engine`
      // matches the project-accepted pattern in start-workflow.ts; it
      // narrows from the dispatcher's `unknown` engine slot.
      const typedEngine = engine as Engine;

      try {
        const handle = await typedEngine.start(options.workflowType, input);
        return { workflowId: handle.id, status: 'started' };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        // Typed engine errors first; the engine throws these for the
        // canonical failure modes (workflow type not registered, workflow
        // ID collision). String-matching the message would silently
        // misclassify the fault if the message text is ever changed.
        if (error instanceof WorkflowNotRegisteredError) {
          throw invalidParamsFault(message);
        }
        if (error instanceof WorkflowAlreadyExistsError) {
          const fault: OperationFault = {
            code: 'Conflict',
            message,
            data: { reason: message },
          };
          throw fault;
        }
        if (error instanceof StartWorkflowValidationError) {
          throw invalidParamsFault(message);
        }
        if (error instanceof QuotaExceededError) {
          const fault: OperationFault = {
            code: 'RateLimited',
            message,
            data: {},
          };
          throw fault;
        }

        const fault: OperationFault = {
          code: 'EngineFailure',
          message,
          data: {},
        };
        throw fault;
      }
    },
  };
}

function resolveCatalogWorkflowPresentation<Input>(options: CatalogWorkflowOptions<Input>): {
  inputSchema: z.ZodType<Input>;
  summary: string;
  tags: string[];
} {
  const inputSchema = (options.inputSchema ??
    zodObjectFromRegistrationSchema(options.registration?.inputSchema) ??
    z.object({}).passthrough()) as z.ZodType<Input>;
  const summary =
    options.summary ??
    options.registration?.description ??
    `Start ${options.workflowType} workflow`;
  const tags = options.tags ?? options.registration?.tags ?? [];
  return { inputSchema, summary, tags: [...tags] };
}

function zodObjectFromRegistrationSchema(schema: unknown): z.ZodObject<z.ZodRawShape> | undefined {
  if (schema === undefined) return undefined;
  if (schema instanceof z.ZodObject) {
    return schema as z.ZodObject<z.ZodRawShape>;
  }
  throw new TypeError(
    'catalogWorkflow() can reuse registration.inputSchema only when it is a Zod object. Pass inputSchema explicitly for other DefinitionSchema implementations.',
  );
}

function copyAccessPolicy(policy: AccessPolicy): AccessPolicy {
  if (policy.kind === 'scoped') {
    return {
      kind: 'scoped',
      scopes: {
        kind: policy.scopes.kind,
        scopes: [...policy.scopes.scopes] as [
          (typeof policy.scopes.scopes)[number],
          ...(typeof policy.scopes.scopes)[number][],
        ],
      },
    };
  }
  if (policy.kind === 'optionalAuth') {
    return {
      kind: 'optionalAuth',
      authenticatedScopes: {
        kind: policy.authenticatedScopes.kind,
        scopes: [...policy.authenticatedScopes.scopes] as [
          (typeof policy.authenticatedScopes.scopes)[number],
          ...(typeof policy.authenticatedScopes.scopes)[number][],
        ],
      },
    };
  }
  return { ...policy };
}
