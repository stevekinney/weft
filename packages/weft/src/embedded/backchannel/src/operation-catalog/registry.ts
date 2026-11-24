import { z } from 'zod';
import type { OperationInterceptor } from './operation-interceptors.ts';

import { snapshotOperationMetadata } from './operation-metadata.ts';
import { UNSAFE_PROTOTYPE_KEYS } from './pipeline-helpers.ts';
import {
  type ErasedOperation,
  type FaultPolicy,
  type OperationRegistry,
  type RegistrableOperation,
  validateOperationName,
} from './types.ts';

function objectInputSchema<Host>(operation: RegistrableOperation<Host>): z.ZodObject {
  if (!(operation.inputSchema instanceof z.ZodObject)) {
    throw new Error(
      `operation "${operation.name}" inputSchema must be a z.ZodObject (got ${operation.inputSchema.constructor.name}); wrappers like .optional() / transforms hide the top-level shape from the unknown-key policy check`,
    );
  }
  return operation.inputSchema;
}

function assertSafeDeclaredKeys<Host>(operation: RegistrableOperation<Host>): void {
  const inputSchema = objectInputSchema(operation);
  const declaredKeys = Object.keys(inputSchema.shape);
  const unsafeDeclared = declaredKeys.filter((key) => UNSAFE_PROTOTYPE_KEYS.has(key));
  if (unsafeDeclared.length > 0) {
    throw new Error(
      `operation "${operation.name}" inputSchema declares unsafe top-level keys: ${unsafeDeclared.join(', ')}. Names that match a prototype-pollution vector (__proto__, constructor, prototype) are forbidden as schema keys.`,
    );
  }
}

/**
 * Mirror the `OperationDefinition` discriminated union at runtime:
 * `kind: 'stream'` and `kind: 'subscription'` MUST carry an `eventSchema`,
 * and `kind: 'unary'` (or absent) MUST NOT. The TypeScript discriminated
 * union enforces this for callers using `defineOperation`, but
 * `createOperationRegistry` accepts any `RegistrableOperation`-shaped
 * value — including hand-rolled object literals constructed in test
 * fixtures or third-party adapters that bypass `defineOperation`. Without
 * this assertion a malformed registry would produce a runtime
 * `EngineFailure` only on the first request, not at registry assembly.
 */
function assertKindAndEventSchemaAgree<Host>(operation: RegistrableOperation<Host>): void {
  const kind = operation.kind ?? 'unary';
  if (kind === 'unary') {
    if (operation.eventSchema !== undefined) {
      throw new Error(
        `operation "${operation.name}" has kind: 'unary' (or unset) but declares an eventSchema. eventSchema is reserved for kind: 'stream' or kind: 'subscription'.`,
      );
    }
    return;
  }
  if (operation.eventSchema === undefined) {
    throw new Error(
      `operation "${operation.name}" has kind: '${kind}' but no eventSchema. Stream and subscription operations must declare an eventSchema so the dispatcher can validate each yielded element.`,
    );
  }
}

/**
 * Mirror the required `destructive` field at runtime. The TypeScript type
 * forces every `defineOperation` caller to declare it, but
 * `createOperationRegistry` accepts any `RegistrableOperation`-shaped value —
 * including hand-rolled object literals from test fixtures or third-party
 * adapters that bypass `defineOperation`. A missing or non-boolean
 * `destructive` would let an operation slip past the explicit-declaration
 * quality floor that the CLI confirmation gate, dashboard bulk-action
 * confirmations, and MCP exposure all depend on. Reject at assembly so the
 * error points at the registry, not at the first request.
 */
function assertDestructiveDeclared<Host>(operation: RegistrableOperation<Host>): void {
  if (typeof operation.destructive !== 'boolean') {
    throw new Error(
      `operation "${operation.name}" must declare an explicit boolean "destructive" flag (got ${typeof operation.destructive}). Every operation has to state whether it irreversibly mutates state — there is no implicit default. Mark cancel/purge/bulk-delete/raw-storage-write style operations true and read-only operations false.`,
    );
  }
}

function assertMcpMetadataAgrees<Host>(operation: RegistrableOperation<Host>): void {
  // `mcpTool` describes an engine-served workflow tool; it means nothing on an operation that is
  // not exposed. An exposable operation without it is served by dispatch (`createOperationMcpMount`).
  if (!operation.mcpExposable && operation.mcpTool !== undefined) {
    throw new Error(
      `operation "${operation.name}" declares mcpTool metadata but is not mcpExposable`,
    );
  }
}

/**
 * The single point where an operation's `Host` is erased. `dispatch` is
 * contravariant in `Host`, so an operation registered against `BureauHost`
 * is not assignable to the `unknown`-hosted `ErasedOperation` the pipeline
 * works with, and no transport can name a host type for a registry that
 * mixes operations. Erasing here is sound because the host a transport puts
 * into every `DispatchContext` is the one the registry's operations were
 * registered against: `createOperationRegistry<Host>` took them as
 * `RegistrableOperation<Host>`, and the handler that owns the registry is
 * constructed with that same `Host`.
 */
function eraseHost<Host>(operation: RegistrableOperation<Host>): ErasedOperation['dispatch'] {
  return operation.dispatch as ErasedOperation['dispatch'];
}

/** Policies shared by every operation registered by this host. */
export type OperationRegistryOptions = {
  /** Classification and masking settings for operation faults. */
  readonly faultPolicy?: FaultPolicy | undefined;
  /** Ordered interceptors for authorized operation invocations. */
  readonly interceptors?: readonly OperationInterceptor[] | undefined;
};

function freezeOperation<Host>(
  operation: RegistrableOperation<Host>,
  { faultPolicy, interceptors }: OperationRegistryOptions,
): ErasedOperation {
  const metadata = snapshotOperationMetadata(operation);
  const invoke = eraseHost(operation);
  const dispatch: ErasedOperation['dispatch'] = (input, context) =>
    invoke(input, {
      ...context,
      ...(context.faultPolicy === undefined && faultPolicy !== undefined ? { faultPolicy } : {}),
      ...(interceptors === undefined ? {} : { interceptors }),
    });
  if (operation.kind === 'stream' || operation.kind === 'subscription') {
    return Object.freeze({
      ...metadata,
      kind: operation.kind,
      eventSchema: operation.eventSchema,
      dispatch,
    });
  }
  return Object.freeze({ ...metadata, kind: 'unary', dispatch });
}

/**
 * Build an immutable registry. Throws on duplicate names, invalid names,
 * non-object input schemas, and unsafe top-level schema keys.
 *
 * `faultPolicy` is the host's say over thrown faults (see {@link FaultPolicy}); omitted, a
 * thrown fault that its operation does not declare answers `EngineFailure`.
 */
export function createOperationRegistry<Host = unknown>(
  operations: ReadonlyArray<RegistrableOperation<Host>>,
  options: OperationRegistryOptions = {},
): OperationRegistry {
  const policies = {
    faultPolicy: options.faultPolicy,
    interceptors:
      options.interceptors === undefined ? undefined : Object.freeze([...options.interceptors]),
  };
  const byName = new Map<string, ErasedOperation>();
  for (const operation of operations) {
    if (byName.has(operation.name)) {
      throw new Error(`duplicate operation name in registry: ${operation.name}`);
    }
    validateOperationName(operation.name);
    assertSafeDeclaredKeys(operation);
    assertKindAndEventSchemaAgree(operation);
    assertDestructiveDeclared(operation);
    assertMcpMetadataAgrees(operation);
    byName.set(operation.name, freezeOperation(operation, policies));
  }
  const ordered = Object.freeze([...byName.values()]);
  return {
    get(name) {
      return byName.get(name);
    },
    list() {
      return ordered;
    },
  };
}
