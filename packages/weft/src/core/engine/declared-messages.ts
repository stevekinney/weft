/**
 * Closed message sets: once a workflow declares signals, updates, or queries
 * with `.signals({...})`/`.updates({...})`/`.queries({...})`, a message of
 * that kind under any other name is rejected before anything is buffered,
 * persisted, or dispatched. A workflow that declares none of a kind keeps
 * accepting any name of that kind, because nothing in its definition says
 * which names it handles.
 *
 * Each kind closes independently, so declaring signals does not close
 * updates or queries. Declared names are the messages' own wire names (the
 * `.name` each `signal()`/`update()`/`query()` handle carries, which the
 * contract lists) together with the keys the builder map aliases them to.
 *
 * A workflow whose definition this process does not have for the run's own
 * revision — a client-only engine, a dynamic source revision not resolved
 * here, or a run pinned to an older revision than the one registered here — is
 * not checked: the engine cannot tell what that revision declared.
 *
 * @module core/engine/declared-messages
 */

import { WeftError } from '../weft-error.ts';
import type { WorkflowExecutionIdentity } from './engine-internal-types.ts';
import type { EngineInternals } from './internals.ts';

/** The three message kinds a workflow can declare. */
export type WorkflowMessageKind = 'signal' | 'update' | 'query';

/**
 * Thrown when a signal, update, or query names a message the target workflow
 * did not declare, although it declared others of that kind. Raised before
 * the message is buffered or dispatched, so nothing about the run changes.
 *
 * @example
 * ```ts
 * import { UndeclaredWorkflowMessageError } from '@lostgradient/weft';
 *
 * function isUndeclaredMessage(error: unknown): boolean {
 *   return error instanceof UndeclaredWorkflowMessageError;
 * }
 * console.log(isUndeclaredMessage(new Error('other'))); // false
 * ```
 */
export class UndeclaredWorkflowMessageError extends WeftError<'UndeclaredWorkflowMessageError'> {
  readonly workflowId: string;
  readonly workflowType: string;
  readonly messageKind: WorkflowMessageKind;
  readonly messageName: string;
  /** The names of this kind the workflow declared, sorted. */
  readonly declaredNames: readonly string[];

  constructor(options: {
    workflowId: string;
    workflowType: string;
    messageKind: WorkflowMessageKind;
    messageName: string;
    declaredNames: readonly string[];
  }) {
    const declared = options.declaredNames.map((name) => JSON.stringify(name)).join(', ');
    super(
      'UndeclaredWorkflowMessageError',
      `Workflow "${options.workflowId}" (type "${options.workflowType}") does not declare ` +
        `${options.messageKind} "${options.messageName}"; it declares ${declared}. ` +
        `Add it to the workflow's .${options.messageKind === 'query' ? 'queries' : `${options.messageKind}s`}({...}) declaration.`,
    );
    this.workflowId = options.workflowId;
    this.workflowType = options.workflowType;
    this.messageKind = options.messageKind;
    this.messageName = options.messageName;
    this.declaredNames = options.declaredNames;
  }
}

type NamedMessages = Readonly<Record<string, { readonly name: string }>> | undefined;

/** The message maps a builder definition carries; absent on a hand-rolled one. */
type DeclaredMessageMaps = Partial<Record<'signals' | 'updates' | 'queries', NamedMessages>>;

const MESSAGE_FIELDS = {
  signal: 'signals',
  update: 'updates',
  query: 'queries',
} as const satisfies Record<WorkflowMessageKind, 'signals' | 'updates' | 'queries'>;

/**
 * The builder definition that declares messages for a run of `type` at
 * `revision`: the eagerly registered one when its registered revision is the
 * run's (or the run predates revisions), or the dynamic source resolved at
 * `revision`. `undefined` when this process has no definition for that exact
 * revision. In a rolling deployment a run pinned to an older revision may still
 * be executing elsewhere, and this process's newer definition can declare a
 * different set, so such a run is left unchecked rather than judged by it.
 */
function declaringDefinition(
  internals: EngineInternals,
  type: string,
  revision: string | undefined,
): DeclaredMessageMaps | undefined {
  if (internals.registrations.has(type)) {
    const registered = internals.registeredCatalogRevisions.get(type);
    if (revision !== undefined && registered !== revision) return undefined;
    return internals.workflowDefinitionsByName.get(type);
  }
  if (revision === undefined) return undefined;
  return internals.sources.resolved.get(type)?.get(revision)?.definition as
    DeclaredMessageMaps | undefined;
}

/**
 * The names of `kind` the workflow `type` (at `revision`, for a dynamic
 * source) declared, or `undefined` when this process does not know the
 * definition or the workflow declared none of that kind. Both the builder
 * key and the message's wire name are admitted, since a declaration may alias
 * one to the other (`.signals({ localAlias: signal('wireName') })`) and the
 * builder types the alias for `ctx.waitForSignal()` and handlers.
 */
function declaredMessageNames(
  internals: EngineInternals,
  kind: WorkflowMessageKind,
  type: string,
  revision: string | undefined,
): readonly string[] | undefined {
  const messages = declaringDefinition(internals, type, revision)?.[MESSAGE_FIELDS[kind]];
  if (messages === undefined) return undefined;
  const names = new Set<string>();
  for (const [key, message] of Object.entries(messages)) {
    names.add(key);
    names.add(message.name);
  }
  return names.size === 0 ? undefined : [...names].toSorted();
}

/**
 * Throw {@link UndeclaredWorkflowMessageError} when the workflow identified
 * by `identity` declared messages of `kind` and `name` is not one of them.
 */
export function assertWorkflowMessageDeclared(
  internals: EngineInternals,
  kind: WorkflowMessageKind,
  workflowId: string,
  identity: WorkflowExecutionIdentity,
  name: string,
): void {
  const declaredNames = declaredMessageNames(internals, kind, identity.type, identity.revision);
  if (declaredNames === undefined || declaredNames.includes(name)) return;
  throw new UndeclaredWorkflowMessageError({
    workflowId,
    workflowType: identity.type,
    messageKind: kind,
    messageName: name,
    declaredNames,
  });
}

/**
 * {@link assertWorkflowMessageDeclared} against the identity this process
 * caches for a run it is executing, with no storage read. A query uses this:
 * it is served only from a live context here, and a query must never pay a
 * storage read on the hot path. A run not live here is not checked.
 */
export function assertLiveWorkflowMessageDeclared(
  internals: EngineInternals,
  kind: WorkflowMessageKind,
  workflowId: string,
  name: string,
): void {
  const cached = internals.workflowTypeByWorkflowId.get(workflowId);
  if (cached !== undefined) {
    assertWorkflowMessageDeclared(internals, kind, workflowId, cached, name);
  }
}
