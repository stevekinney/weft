/**
 * Shared operation factory for JSON-RPC transport tests.
 *
 * The transport-neutral dispatcher and the HTTP / stdio adapters all need to
 * register `ErasedOperation`s with permissive defaults. This factory builds one
 * from the required `name`/schemas/`invoke` plus any per-test overrides, so each
 * suite keeps its operation name and behavior visible at the call site while the
 * boilerplate defaults live in one place.
 */

import type { z } from 'zod';
import type { FaultCode } from '../core/fault-code.ts';

import type { AccessPolicy } from './authorization.ts';
import type {
  AuthorizationDecision,
  McpToolMetadata,
  OperationContext,
  ParameterizedAccessHint,
  StreamOperationInvocation,
  SubscriptionOperationInvocation,
  TransportAvailability,
  UnknownKeyPolicy,
} from './operation-catalog/types.ts';
import type { SchemaOperationDefinition } from './operation-registry.ts';
import { defineOperation } from './operation-registry.ts';

type CommonOverrides<IS extends z.ZodObject, OS extends z.ZodType> = {
  readonly name: string;
  readonly mcpExposable?: boolean;
  readonly mcpTool?: McpToolMetadata;
  readonly summary?: string;
  readonly description?: string;
  readonly destructive?: boolean;
  readonly access?: AccessPolicy;
  readonly parameterizedAccess?: ParameterizedAccessHint;
  readonly producibleFaults?: ReadonlyArray<FaultCode>;
  readonly discoverable?: boolean;
  readonly transports?: TransportAvailability;
  readonly unknownKeyPolicy?: UnknownKeyPolicy;
  readonly inputSchema: IS;
  readonly outputSchema: OS;
  readonly tags?: ReadonlyArray<string>;
  readonly authorize?: (context: OperationContext<z.output<IS>>) => Promise<AuthorizationDecision>;
  readonly kind?: 'unary';
  readonly eventSchema?: never;
  readonly invoke: (context: OperationContext<z.output<IS>>) => Promise<z.input<OS>>;
};

type StreamOverrides<IS extends z.ZodObject, OS extends z.ZodType, ES extends z.ZodType> = Omit<
  CommonOverrides<IS, OS>,
  'kind' | 'eventSchema' | 'invoke'
> & {
  readonly kind: 'stream';
  readonly eventSchema: ES;
  readonly invoke: (
    context: OperationContext<z.output<IS>>,
  ) => Promise<z.input<OS> | StreamOperationInvocation<z.input<ES>>>;
};

type SubscriptionOverrides<
  IS extends z.ZodObject,
  OS extends z.ZodType,
  ES extends z.ZodType,
> = Omit<CommonOverrides<IS, OS>, 'kind' | 'eventSchema' | 'invoke'> & {
  readonly kind: 'subscription';
  readonly eventSchema: ES;
  readonly invoke: (
    context: OperationContext<z.output<IS>>,
  ) => Promise<SubscriptionOperationInvocation<z.input<ES>, z.input<OS>>>;
};

/**
 * Build an `ErasedOperation` with permissive defaults for transport tests.
 *
 * Defaults all metadata (`summary`, `tags`, `access`, `transports`,
 * `unknownKeyPolicy`, `mcpExposable`) so a test only supplies the parts it
 * exercises. Any field may be overridden, including `transports` for suites
 * that pin a single transport.
 */
export function makeOperation<IS extends z.ZodObject, OS extends z.ZodType>(
  overrides: CommonOverrides<IS, OS>,
): SchemaOperationDefinition<IS, OS>;
export function makeOperation<IS extends z.ZodObject, OS extends z.ZodType, ES extends z.ZodType>(
  overrides: StreamOverrides<IS, OS, ES>,
): SchemaOperationDefinition<IS, OS, ES>;
export function makeOperation<IS extends z.ZodObject, OS extends z.ZodType, ES extends z.ZodType>(
  overrides: SubscriptionOverrides<IS, OS, ES>,
): SchemaOperationDefinition<IS, OS, ES>;
export function makeOperation(
  overrides:
    | CommonOverrides<z.ZodObject, z.ZodType>
    | StreamOverrides<z.ZodObject, z.ZodType, z.ZodType>
    | SubscriptionOverrides<z.ZodObject, z.ZodType, z.ZodType>,
): SchemaOperationDefinition<z.ZodObject, z.ZodType, z.ZodType> {
  const defaultTags: string[] = [];
  const defaultTransports: TransportAvailability = {
    http: true,
    jsonRpcHttp: true,
    jsonRpcWebSocket: true,
    jsonRpcStdio: true,
  };
  const defaultUnknownKeyPolicy: UnknownKeyPolicy = { http: 'reject', jsonRpc: 'reject' };
  const defaults = {
    mcpExposable: false,
    destructive: false,
    summary: 'test op',
    tags: defaultTags,
    access: { kind: 'public' } satisfies AccessPolicy,
    transports: defaultTransports,
    unknownKeyPolicy: defaultUnknownKeyPolicy,
  };
  if (overrides.kind === 'stream') return defineOperation({ ...defaults, ...overrides });
  if (overrides.kind === 'subscription') return defineOperation({ ...defaults, ...overrides });
  return defineOperation({ ...defaults, ...overrides });
}
