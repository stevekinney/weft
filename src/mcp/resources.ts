import type { ListFilter } from '../core/types.ts';
import {
  assertScope,
  getVisibleWorkflowState,
  listVisibleWorkflows,
  type McpAccessContext,
} from './access.ts';
import { parseMcpListFilterFromSearchParams } from './list-filter.ts';
import type { McpSession } from './session.ts';

/** MCP resource definition. */
export type McpResourceDefinition = {
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
};

/** MCP resource template definition. */
export type McpResourceTemplate = {
  readonly uriTemplate: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly mimeType: string;
};

/** MCP resource-read result. */
export type McpResourceReadResult = {
  readonly contents: ReadonlyArray<{
    readonly uri: string;
    readonly mimeType: string;
    readonly text: string;
  }>;
};

/** Return the static resource templates Weft exposes through MCP. */
export function listMcpResourceTemplates(): McpResourceTemplate[] {
  return [
    {
      uriTemplate: 'weft://workflows/{workflowId}/state',
      name: 'workflow_state',
      title: 'Workflow state',
      description: 'Read the current state for a Weft workflow.',
      mimeType: 'application/json',
    },
    {
      uriTemplate: 'weft://workflows/{workflowId}/events',
      name: 'workflow_events',
      title: 'Workflow events',
      description: 'Read the event log for a Weft workflow.',
      mimeType: 'application/json',
    },
    {
      uriTemplate: 'weft://workflows/{workflowId}/checkpoints',
      name: 'workflow_checkpoints',
      title: 'Workflow checkpoints',
      description: 'Read checkpoint history summaries for a Weft workflow.',
      mimeType: 'application/json',
    },
    {
      uriTemplate: 'weft://workflows/search{?status,type,tag,limit,offset}',
      name: 'workflow_search',
      title: 'Workflow search',
      description: 'List visible Weft workflows using query filters.',
      mimeType: 'application/json',
    },
  ];
}

/** List visible workflow state resources. */
export async function listMcpResources(
  context: McpAccessContext,
): Promise<McpResourceDefinition[]> {
  assertScope(context, 'workflows:read', 'Listing workflow resources');
  const workflows = await listVisibleWorkflows(context.engine, {});
  return workflows.items.map((workflow) => ({
    uri: workflowResourceUri(workflow.id, 'state'),
    name: `workflow_${workflow.id}`,
    title: `${workflow.type} workflow ${workflow.id}`,
    description: `Current state for workflow ${workflow.id}.`,
    mimeType: 'application/json',
  }));
}

/** Read a visible Weft MCP resource. */
export async function readMcpResource(
  uri: string,
  context: McpAccessContext,
): Promise<McpResourceReadResult | null> {
  assertScope(context, 'workflows:read', 'Reading workflow resources');
  const parsed = parseWeftResourceUri(uri);
  if (parsed === null) return null;

  if (parsed.kind === 'search') {
    const result = await listVisibleWorkflows(context.engine, parsed.filter);
    return jsonResource(uri, result);
  }

  const state = await getVisibleWorkflowState(context.engine, parsed.workflowId);
  if (state === null) return null;

  switch (parsed.kind) {
    case 'state':
      return jsonResource(uri, state);
    case 'events':
      assertScope(context, 'events:read', 'Reading workflow events');
      return jsonResource(uri, { events: await context.engine.getEvents(parsed.workflowId) });
    case 'checkpoints':
      return jsonResource(uri, {
        checkpoints: await context.engine.listCheckpoints(parsed.workflowId),
      });
  }
}

/** Subscribe to updates for a visible resource. */
export async function subscribeMcpResource(
  uri: string,
  session: McpSession,
  context: McpAccessContext,
): Promise<boolean> {
  const result = await readMcpResource(uri, context);
  if (result === null) return false;
  session.subscriptions.add(uri);
  return true;
}

/** Remove a resource subscription. */
export function unsubscribeMcpResource(uri: string, session: McpSession): void {
  session.subscriptions.delete(uri);
}

function jsonResource(uri: string, value: unknown): McpResourceReadResult {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(value),
      },
    ],
  };
}

type ParsedResourceUri =
  | { readonly kind: 'state'; readonly workflowId: string }
  | { readonly kind: 'events'; readonly workflowId: string }
  | { readonly kind: 'checkpoints'; readonly workflowId: string }
  | { readonly kind: 'search'; readonly filter: ListFilter };

function parseWeftResourceUri(uri: string): ParsedResourceUri | null {
  const url = parseWeftUrl(uri);
  if (url === null) return null;
  if (url.pathname === '/search') return parseSearchResource(url.searchParams);
  return parseWorkflowResourcePath(url.pathname);
}

function parseWeftUrl(uri: string): URL | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== 'weft:' || url.hostname !== 'workflows') return null;
  return url;
}

function parseSearchResource(searchParams: URLSearchParams): ParsedResourceUri | null {
  const parsed = parseMcpListFilterFromSearchParams(searchParams);
  return parsed.ok ? { kind: 'search', filter: parsed.filter } : null;
}

/** Return true when a URI identifies a valid workflow search resource. */
export function isWorkflowSearchResourceUri(uri: string): boolean {
  return parseWeftResourceUri(uri)?.kind === 'search';
}

function parseWorkflowResourcePath(pathname: string): ParsedResourceUri | null {
  const parts = pathname.split('/').filter(Boolean).map(decodePathSegment);
  if (parts.some((part) => part === null)) return null;
  if (parts.length !== 2) return null;
  const [workflowId, resourceKind] = parts;
  if (!workflowId) return null;
  if (resourceKind === 'state' || resourceKind === 'events' || resourceKind === 'checkpoints') {
    return { kind: resourceKind, workflowId };
  }
  return null;
}

/** Build the canonical MCP URI for a workflow resource. */
export function workflowResourceUri(
  workflowId: string,
  resourceKind: 'state' | 'events' | 'checkpoints',
): string {
  return `weft://workflows/${encodeURIComponent(workflowId)}/${resourceKind}`;
}

function decodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
