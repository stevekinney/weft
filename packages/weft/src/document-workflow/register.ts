/**
 * Registering workflow documents with an engine. Each document becomes its own
 * workflow type through `registerSource()`, so it lists, runs, schedules, and
 * recovers like a code-defined workflow. Weft persists no documents: the host
 * supplies them, and this helper registers exactly what it is handed.
 *
 * @module document-workflow/register
 */

import { deriveWorkflowDefinitionRevision } from '../core/engine/definition-revision.ts';
import type { Engine } from '../core/engine/index.ts';
import { activateRegisteredSourceRevision } from '../core/engine/source-activation.ts';
import { listWorkflowSources } from '../core/engine/source-listing.ts';
import { workflowSource, type WorkflowSourceHandle } from '../core/source/index.ts';
import type { WorkflowDefinition } from '../core/types.ts';
import {
  WorkflowDocumentValidationError,
  validateWorkflowDocument,
  workflowDocumentVersion,
  type DocumentWorkflowHost,
  type WorkflowDocument,
} from './document.ts';
import { buildDocumentWorkflowDefinition } from './interpreter.ts';

/** The identity a registered document has in the engine. */
export type RegisteredWorkflowDocument = Readonly<{
  /** The workflow type name, taken from the document. */
  name: string;
  /** The document's version, `sha256:` plus the SHA-256 of its canonical JSON. */
  workflowVersion: string;
  /** The engine revision derived from the document's contract and version. */
  revision: string;
}>;

/** The documents a host hands {@link registerWorkflowDocuments}. */
export interface WorkflowDocumentSet {
  /** The revision each workflow type runs for new instances: one document per name. */
  readonly active: readonly unknown[];
  /**
   * Every other revision the host still holds a run or a pinned schedule on.
   * They are registered but never activated. A revision that has an in-flight
   * run and is not supplied here cannot be loaded when that run recovers, and
   * the run fails permanently. A name supplied only here has no active
   * document, so its sole registered revision still serves new starts and
   * `active-at-fire` schedules.
   */
  readonly retained?: readonly unknown[];
}

const DOCUMENT_SOURCE_EXPORT = 'workflow';

type PreparedDocument = Readonly<{
  identity: RegisteredWorkflowDocument;
  source: WorkflowSourceHandle;
}>;

function nameIssue(message: string): WorkflowDocumentValidationError {
  return new WorkflowDocumentValidationError([{ path: 'name', message }]);
}

/**
 * Check, before anything is registered, that every document can be registered:
 * no active name is repeated, and no name belongs to a code workflow.
 */
function assertRegistrable(
  engine: Engine,
  active: readonly WorkflowDocument[],
  retained: readonly WorkflowDocument[],
): void {
  const activeNames = new Set<string>();
  for (const document of active) {
    if (activeNames.has(document.name)) {
      throw nameIssue(
        `workflow "${document.name}" has more than one active document; supply one active document per name`,
      );
    }
    activeNames.add(document.name);
  }
  for (const document of [...active, ...retained]) {
    if (engine.getWorkflowDefinition(document.name) !== undefined) {
      throw nameIssue(
        `workflow "${document.name}" is already registered as a code workflow, so a document cannot use that name`,
      );
    }
  }
}

/** Build a document's definition and derive its revision. Registers nothing. */
async function prepareDocument(
  host: DocumentWorkflowHost,
  document: WorkflowDocument,
): Promise<PreparedDocument> {
  const workflowVersion = await workflowDocumentVersion(document);
  const definition: WorkflowDefinition = await buildDocumentWorkflowDefinition(document, host);
  const revision = await deriveWorkflowDefinitionRevision(definition);
  return {
    identity: { name: document.name, workflowVersion, revision },
    source: workflowSource(
      {
        name: document.name,
        location: `workflow-document:${workflowVersion}`,
        exportName: DOCUMENT_SOURCE_EXPORT,
        revision,
        workflowVersion,
      },
      async () => ({ [DOCUMENT_SOURCE_EXPORT]: definition }),
    ),
  };
}

function registerPrepared(engine: Engine, prepared: PreparedDocument): void {
  const { name, revision } = prepared.identity;
  const alreadyRegistered = listWorkflowSources(engine).some(
    (source) => source.name === name && source.revision === revision,
  );
  if (!alreadyRegistered) engine.registerSource(prepared.source);
}

/**
 * Register every document the host supplies, then make each `active` document
 * the revision that new instances of its type run. The batch is all or
 * nothing as far as validation goes: every document is validated, checked
 * against the engine's code workflows and against each other, and built before
 * the first one is registered.
 *
 * Call it before `recoverAll()`, so recovery can load the revision each
 * in-flight run is pinned to. `new Engine()` does not recover on its own, so
 * register and then call `recoverAll()`. `Engine.create()` recovers by default,
 * so pass `recover: false`, register, and then call `recoverAll()`.
 *
 * Activating a document revision moves the active pointer without the
 * compatibility check `engine.workflows.activate()` applies, as re-registering
 * changed code does. Runs that started on the previous revision stay on it.
 * Under sustained contention for the same catalog entry the activation can
 * throw `WorkflowCatalogActivationConflictError`.
 *
 * Registering a revision that is already registered keeps the first
 * registration's loader and handlers. A host that changes its handler map
 * registers into a new engine.
 *
 * Returns the `active` documents' identities, then the `retained` ones', in the
 * order given.
 */
export async function registerWorkflowDocuments(
  engine: Engine,
  host: DocumentWorkflowHost,
  documents: WorkflowDocumentSet,
): Promise<readonly RegisteredWorkflowDocument[]> {
  const active = documents.active.map((input) => validateWorkflowDocument(input, host));
  // A retained revision is already registered and has runs on it: it may call the activities it
  // was registered against, `compensate` included.
  const retained = (documents.retained ?? []).map((input) =>
    validateWorkflowDocument(input, host, { allowCompensate: true }),
  );
  assertRegistrable(engine, active, retained);

  const preparedActive = await Promise.all(
    active.map((document) => prepareDocument(host, document)),
  );
  const preparedRetained = await Promise.all(
    retained.map((document) => prepareDocument(host, document)),
  );

  for (const prepared of [...preparedRetained, ...preparedActive]) {
    registerPrepared(engine, prepared);
  }
  for (const { identity } of preparedActive) {
    await activateRegisteredSourceRevision(engine, identity.name, identity.revision);
  }
  return [...preparedActive, ...preparedRetained].map(({ identity }) => identity);
}
