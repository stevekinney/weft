/**
 * The declarative workflow document: an agent-authored JSON description of a
 * workflow as a trigger plus an ordered list of steps. Weft validates it,
 * derives its version from its canonical JSON, and (see `register.ts`) runs
 * it through one interpreter. Weft persists no documents and attaches no
 * owner to one: the host supplies the content and keeps whatever record of
 * authorship it needs.
 *
 * @module document-workflow/document
 */

import { z } from 'zod';

import { isJSONValue, type JSONValue } from '../core/json.ts';
import { parseDuration } from '../core/scheduler.ts';
import type { ActivityContext, ActivityDefinition } from '../core/types/activity.ts';
import { validateWorkflowOrActivityName } from '../core/types/name-grammar.ts';
import { canonicalJsonStringify } from '../worker/manifest/canonical-json.ts';
import { sha256Hex, sha256HexSync } from '../worker/manifest/content-digest.ts';
import type { WorkflowDocumentIssue } from './document-errors.ts';
import { hostIssues } from './document-host-issues.ts';
import type { DocumentRejectionStep } from './document-rejection.ts';

/**
 * The argument every document activity handler receives: the step's static
 * `input`, the `trigger` that started the instance, and `previous`, the most
 * recent activity result or `null` before the first activity. Waits preserve
 * that result. The next activity also receives the latest awaited signal's
 * payload in `signal` when a payload is present.
 *
 * `workflowId` and `step` identify the step being run: the instance's workflow
 * id, and the zero-based index of the step among all of the document's steps
 * (sleeps and signal waits count). The pair is the same every time that step
 * runs, including when a restart re-executes an activity that was in flight, so
 * a handler with an external effect can derive a deterministic key from it and
 * recognise its own earlier attempt instead of repeating the effect.
 */
export type DocumentActivityArgument = Readonly<{
  input: JSONValue;
  trigger: unknown;
  previous: unknown;
  signal?: unknown;
  workflowId: string;
  step: number;
  /** Stable iteration path for this step; absent for flat documents. */
  iteration?: readonly (string | number)[];
  /** Canonical address combining the preorder step and iteration path. */
  stepAddress?: string;
}>;

/** Canonical address for a document step. Dots are encoded to preserve path boundaries. */
export function documentStepAddress(
  step: number,
  iteration?: readonly (string | number)[],
): string {
  if (iteration === undefined || iteration.length === 0) return String(step);
  return `${String(step)}#${iteration.map((segment) => encodeURIComponent(String(segment)).replaceAll('.', '%2E')).join('.')}`;
}

/**
 * The id of the child a `workflow` step starts: a function of the instance and the step address,
 * so a step a restart re-issues finds the child it already started instead of starting another,
 * and two instances of one document never share one. Hashed, because an instance id can already
 * be close to the 128 characters an id may have and an address holds characters an id may not.
 */
export function documentChildWorkflowId(workflowId: string, stepAddress: string): string {
  return `workflow-child-${sha256HexSync(`${workflowId}:${stepAddress}`).slice('sha256:'.length, 'sha256:'.length + 32)}`;
}

/** What {@link DocumentWorkflowHost.childInput} is asked to build a child's input from. */
export type DocumentChildWorkflowArgument = Readonly<{
  /** The child the step calls, as the document names it. */
  workflow: string;
  /** The instance that is running the step. */
  workflowId: string;
  /** The trigger that started the instance. */
  trigger: unknown;
  /** The step's `input`, or `null` when it gives none. */
  input: JSONValue;
  step: number;
  stepAddress: string;
}>;
/**
 * A host-registered activity handler a document names by key. A thrown error
 * fails the instance with that error. The optional `context` is the activity's
 * {@link ActivityContext}, whose `signal` aborts when an attempt is abandoned (a
 * `timeout` fired, or the instance was cancelled), so a handler that stops on it
 * does not keep running beside its retry. A bare handler runs once, with no timeout;
 * register a {@link DocumentActivityDefinition} to give it a retry policy or a
 * per-attempt timeout.
 */
export type DocumentActivityHandler = (
  argument: DocumentActivityArgument,
  context?: ActivityContext,
) => unknown;

/**
 * A host-registered activity that declares how Weft runs it, as a Weft
 * `ActivityDefinition` does for a code workflow: `retry`, `timeout`,
 * `scheduleToCloseTimeout`, `idempotencyKey`, `verify`, `compensate`,
 * `resourceScope`, `queue`, `visibilityTimeout`, and the descriptive `description`,
 * `tags`, `inputSchema` and `outputSchema`. Its `execute` and its callbacks receive
 * a {@link DocumentActivityArgument}. The activity's name is the key it is
 * registered under, so a definition carries none. Weft applies every setting the
 * same way it does for a code workflow's activity, because the interpreter runs the
 * step through the definition and not through its `execute` alone.
 */
export type DocumentActivityDefinition = Omit<
  ActivityDefinition<DocumentActivityArgument>,
  'name' | 'execute'
> & {
  /** Runs the step. */
  execute: DocumentActivityHandler;
};
/** What a host registers under a handler key: a bare handler, or a definition with settings. */
export type DocumentActivity = DocumentActivityHandler | DocumentActivityDefinition;

/**
 * Validates one document's `trigger` object for its kind. Return `undefined`
 * when the trigger is acceptable, or a message explaining why it is not. Weft
 * never interprets a trigger beyond its `kind`: what a trigger means belongs
 * to the host.
 */
export type DocumentTriggerValidator = (
  trigger: Readonly<Record<string, JSONValue>>,
) => string | undefined;

/** Where in a run a schema is checked: the instance's start input, or the value it finishes with. */
export type DocumentSchemaPoint = 'input' | 'output';

/**
 * Checks `value` against a document's `inputSchema` or `outputSchema` and returns every way it
 * fails, or `[]` when it satisfies the schema. At the `'input'` point `value` is the instance's
 * start input, the trigger the engine started it with, and the host decides which part of it the
 * schema describes. At the `'output'` point `value` is the result of the document's last step.
 * Weft never reads a schema itself: what a schema means and which rules it is held to belong to
 * the host.
 */
export type DocumentSchemaChecker = (
  point: DocumentSchemaPoint,
  schema: Readonly<Record<string, JSONValue>>,
  value: unknown,
) => readonly WorkflowDocumentIssue[];

/** What a host registers so documents can name its activities and trigger kinds. */
export interface DocumentWorkflowHost {
  /** Activity handlers keyed by the name a document's `activity` step uses. */
  readonly activities: Readonly<Record<string, DocumentActivity>>;
  /** Trigger validators keyed by the `kind` a document's `trigger` uses. */
  readonly triggerKinds: Readonly<Record<string, DocumentTriggerValidator>>;
  /**
   * Checks a value against a document's `inputSchema` or `outputSchema`. A document that declares
   * either needs a host that has this, and is refused by {@link validateWorkflowDocument}
   * otherwise, because a schema nothing checks would promise a guarantee nobody keeps.
   */
  readonly checkSchema?: DocumentSchemaChecker | undefined;
  /**
   * The version each handler in {@link DocumentWorkflowHost.activities} is at, keyed by handler
   * name. A handler absent here has no version. A document that pins a handler in its
   * {@link WorkflowDocument.activityVersions} is refused unless the host has that handler at
   * exactly the pinned version, so a run recovered from a pinned revision never executes another
   * version of an activity.
   */
  readonly activityVersions?: Readonly<Record<string, string>> | undefined;
  /**
   * The workflows a document's `workflow` step may call, by the name the step uses. The host
   * registers each on the engine as a workflow of that type; a step naming any other is refused by
   * {@link validateWorkflowDocument}. Absent, no document may call a child.
   */
  readonly workflows?: readonly string[] | undefined;
  /**
   * The version each workflow in {@link DocumentWorkflowHost.workflows} is at, keyed by name, as
   * {@link DocumentWorkflowHost.activityVersions} is for handlers. A document that pins a workflow
   * in its {@link WorkflowDocument.workflowVersions} is refused unless the host has exactly that
   * version.
   */
  readonly workflowVersions?: Readonly<Record<string, string>> | undefined;
  /**
   * The input a `workflow` step starts its child with. Without it the child receives the step's
   * `input` (`null` when it has none). It must be pure: a re-issued step asks again, and a child
   * already started under the step's id is only re-attached to when its input is the same.
   */
  readonly childInput?: ((argument: DocumentChildWorkflowArgument) => JSONValue) | undefined;
  /**
   * An activity the interpreter runs, with the step's {@link DocumentActivityArgument}, before it
   * starts each child. A host that must check something at that moment (that the run still holds
   * its authority) does it here, as it does in its activities, and a throw fails the step with no
   * child started. Only a document that has a `workflow` step carries it.
   */
  readonly workflowAdmission?: DocumentActivity | undefined;
  /**
   * Whether the payload an `await-signal` step received is a rejection: when it is, the run ends
   * without running a later step, as `failed` with {@link WorkflowDocumentReviewRejectedError}.
   * What a rejection looks like, and at which steps, belongs to the host: the call names the step.
   * Without this hook every payload continues. It must be pure: a replay asks it again.
   */
  readonly isRejection?: ((payload: unknown, step: DocumentRejectionStep) => boolean) | undefined;
}

/** One step of a {@link WorkflowDocument}. */
export type WorkflowDocumentStep =
  | Readonly<{ kind: 'activity'; handler: string; input?: JSONValue | undefined }>
  | Readonly<{
      /**
       * Starts the registered workflow `workflow` as a child (`ctx.startChild`) and continues with
       * its result as `previous`. The child fails the step by failing. Its id derives from the
       * instance and the step address ({@link documentChildWorkflowId}).
       */
      kind: 'workflow';
      workflow: string;
      input?: JSONValue | undefined;
    }>
  | Readonly<{ kind: 'sleep'; duration: string | number }>
  | Readonly<{
      kind: 'await-signal';
      signal: string;
      /** How long to wait; on expiry the run continues with `{ timedOut: true }` as `previous`. */
      timeout?: string | number | undefined;
    }>
  | Readonly<{
      kind: 'branch';
      on: string;
      cases: Readonly<Record<string, readonly WorkflowDocumentStep[]>>;
      otherwise?: readonly WorkflowDocumentStep[] | undefined;
    }>
  | Readonly<{
      kind: 'map';
      over: string;
      steps: readonly WorkflowDocumentStep[];
      concurrency?: number | undefined;
    }>
  | Readonly<{
      kind: 'parallel';
      /**
       * Step lists that run together, each from the step before the `parallel` step. The step's
       * result is an object keyed by branch name, each value the result of that branch's last step.
       * Each branch moves on as soon as its own current step settles, without waiting for the
       * others', and every step a branch settles is committed while a sibling is still running: a
       * restart resumes each branch where it stopped, so a finished activity beside an open wait
       * does not run again (an activity that was running at the crash does, at-least-once as in
       * `ctx.all`). Two branches may not wait on the same signal at once. A failing branch fails
       * the step once its siblings have settled.
       */
      branches: Readonly<Record<string, readonly WorkflowDocumentStep[]>>;
    }>;

/** A declarative workflow: a name, an opaque trigger, and ordered steps. */
export interface WorkflowDocument {
  /** Becomes the workflow type name; must satisfy the wire-safe name grammar. */
  readonly name: string;
  /** Host-defined trigger. Only `kind` is read, to pick the host's validator. */
  readonly trigger: Readonly<{ kind: string } & Record<string, JSONValue>>;
  /** Run in order; at least one. */
  readonly steps: readonly WorkflowDocumentStep[];
  /**
   * A JSON Schema describing the input an instance starts with, checked by the host's
   * {@link DocumentWorkflowHost.checkSchema} when the instance begins. Optional: a document
   * without it is the document it always was, with the version it always had.
   */
  readonly inputSchema?: Readonly<Record<string, JSONValue>>;
  /**
   * A JSON Schema describing the value the instance finishes with, checked by the host's
   * {@link DocumentWorkflowHost.checkSchema} when the last step is done. An instance whose result
   * does not satisfy it fails with {@link WorkflowDocumentSchemaError}. Optional like
   * `inputSchema`.
   */
  readonly outputSchema?: Readonly<Record<string, JSONValue>>;
  /**
   * The version of each activity handler the steps use, keyed by handler name. Weft hashes it into
   * the document's version, so the same steps pinned to another version of a handler are another
   * revision, and {@link validateWorkflowDocument} refuses a pin the host cannot honor (see
   * {@link DocumentWorkflowHost.activityVersions}). Optional like `inputSchema`: a document that
   * pins nothing is the document it always was, with the version it always had. Every key names a
   * handler one of the steps uses.
   */
  readonly activityVersions?: Readonly<Record<string, string>>;
  /**
   * The version of each workflow a `workflow` step calls, keyed by workflow name, as
   * {@link WorkflowDocument.activityVersions} is for handlers: hashed into the document's version,
   * and refused when the host cannot honor it (see {@link DocumentWorkflowHost.workflowVersions}).
   * Optional: a document that pins no child keeps the version it always had. Every key names a
   * workflow one of the steps calls.
   */
  readonly workflowVersions?: Readonly<Record<string, string>>;
}

const jsonValueSchema = z.custom<JSONValue>(isJSONValue, 'must be a JSON value');

const jsonObjectSchema = z.custom<Record<string, JSONValue>>(
  (value) =>
    typeof value === 'object' && value !== null && !Array.isArray(value) && isJSONValue(value),
  'must be a JSON object',
);

const nameSchema = z.string().superRefine((name, context) => {
  try {
    validateWorkflowOrActivityName(name, 'workflow');
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

const durationSchema = z.union([z.string(), z.number()]).superRefine((duration, context) => {
  try {
    parseDuration(duration);
  } catch {
    context.addIssue({
      code: 'custom',
      message: 'must be a finite, non-negative number of milliseconds or a duration string',
    });
  }
});

const mapConcurrencySchema = z.number().int().positive().optional();

/** The schema of one document step, exposed so workflow editors can derive its field catalog. */
export const workflowDocumentStepSchema: z.ZodType<WorkflowDocumentStep> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('activity'),
      handler: z.string().min(1),
      input: jsonValueSchema.optional(),
    }),
    z.strictObject({ kind: z.literal('sleep'), duration: durationSchema }),
    z.strictObject({
      kind: z.literal('await-signal'),
      signal: z.string().min(1),
      timeout: durationSchema.optional(),
    }),
    z.strictObject({
      kind: z.literal('branch'),
      on: z.string().min(1),
      cases: z
        .record(z.string(), z.array(workflowDocumentStepSchema))
        .superRefine((cases, context) => {
          if (Object.keys(cases).length === 0) {
            context.addIssue({ code: 'custom', message: 'must contain at least one case' });
          }
        }),
      otherwise: z.array(workflowDocumentStepSchema).optional(),
    }),
    z.strictObject({
      kind: z.literal('map'),
      over: z.string().min(1),
      steps: z.array(workflowDocumentStepSchema).min(1),
      concurrency: mapConcurrencySchema,
    }),
    z.strictObject({
      kind: z.literal('parallel'),
      branches: z
        .record(z.string().min(1), z.array(workflowDocumentStepSchema).min(1))
        .superRefine((branches, context) => {
          if (Object.keys(branches).length === 0) {
            context.addIssue({ code: 'custom', message: 'must contain at least one branch' });
          }
        }),
    }),
    // Last, so the editor catalog lists the kinds it always did in the order it always did.
    z.strictObject({
      kind: z.literal('workflow'),
      workflow: z.string().min(1),
      input: jsonValueSchema.optional(),
    }),
  ]),
);

/**
 * Structural schema for a {@link WorkflowDocument}. It does not know the
 * host's registered handlers and trigger kinds: {@link validateWorkflowDocument}
 * checks those as well.
 */
export const workflowDocumentSchema = z.strictObject({
  name: nameSchema,
  trigger: z.looseObject({ kind: z.string().min(1) }).superRefine((trigger, context) => {
    if (!isJSONValue(trigger)) {
      context.addIssue({ code: 'custom', message: 'must contain only JSON values' });
    }
  }),
  steps: z.array(workflowDocumentStepSchema).min(1),
  inputSchema: jsonObjectSchema.optional(),
  outputSchema: jsonObjectSchema.optional(),
  activityVersions: z.record(z.string().min(1), z.string().min(1)).optional(),
  workflowVersions: z.record(z.string().min(1), z.string().min(1)).optional(),
});

/** Thrown by {@link validateWorkflowDocument} with every reason the document was rejected. */
export class WorkflowDocumentValidationError extends Error {
  readonly issues: readonly WorkflowDocumentIssue[];

  constructor(issues: readonly WorkflowDocumentIssue[]) {
    const summary = issues
      .map((issue) => (issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`))
      .join('; ');
    super(`Invalid workflow document: ${summary}`);
    this.name = 'WorkflowDocumentValidationError';
    this.issues = issues;
  }
}
function formatPath(path: readonly PropertyKey[]): string {
  let formatted = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      formatted += `[${String(segment)}]`;
    } else {
      formatted += formatted === '' ? String(segment) : `.${String(segment)}`;
    }
  }
  return formatted;
}

/** What {@link validateWorkflowDocument} may be told about the document it validates. */
export type WorkflowDocumentValidationOptions = Readonly<{
  /**
   * Accept an activity that defines `compensate`. A document never runs `compensate`, so a
   * document written now may not name such an activity; a revision that is already registered
   * keeps working with the activities it was registered against, so a host that re-validates one
   * (to register it as retained, or to read its manifest) sets this.
   */
  allowCompensate?: boolean;
}>;

/**
 * Validate `input` as a {@link WorkflowDocument} against what `host` has
 * registered, and return a detached copy. Call it when a document is written:
 * a document naming an unregistered activity handler, workflow or trigger kind throws a
 * {@link WorkflowDocumentValidationError} listing every problem found. A new document may not
 * name an activity that defines `compensate`; see {@link WorkflowDocumentValidationOptions}.
 */
export function validateWorkflowDocument(
  input: unknown,
  host: DocumentWorkflowHost,
  options: WorkflowDocumentValidationOptions = {},
): WorkflowDocument {
  const parsed = workflowDocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw new WorkflowDocumentValidationError(
      parsed.error.issues.map((issue) => ({
        path: formatPath(issue.path),
        message: issue.message,
      })),
    );
  }
  const document = structuredClone(parsed.data) as WorkflowDocument;
  const issues = hostIssues(document, host, options);
  if (issues.length > 0) throw new WorkflowDocumentValidationError(issues);
  return document;
}

/**
 * The canonical JSON of a document: object keys sorted by UTF-16 code unit
 * (JavaScript's default string order, which is what RFC 8785 specifies) at every
 * depth, array order preserved, and no whitespace between tokens. Equal content
 * always serializes to the same text. Strings are written as they are, with no
 * Unicode normalization.
 */
export function canonicalWorkflowDocumentJson(document: WorkflowDocument): string {
  return canonicalJsonStringify(document);
}

/**
 * A document's version: `sha256:` followed by the hex SHA-256 of its
 * {@link canonicalWorkflowDocumentJson}. It is carried as the registered
 * workflow's `workflowVersion`, so identical content always has the same
 * version and any change to a step has a different one.
 *
 * The version is a content identity, not a meaning identity. An absent `input`
 * and `input: null`, or the durations `'1m'` and `60000`, mean the same to the
 * interpreter but are different content, so they have different versions.
 *
 * Invariant for every future change to the schema: the hash covers exactly the
 * value the author wrote. The parser must never add a default, rename a key, or
 * otherwise produce a value the author did not write, because that would move
 * the version of every existing document. A field added later is `.optional()`,
 * and its absence means the current shape. `src/document-workflow/document.test.ts`
 * pins the version of a fixed document to catch any drift.
 */
export function workflowDocumentVersion(document: WorkflowDocument): Promise<string> {
  return sha256Hex(canonicalWorkflowDocumentJson(document));
}
