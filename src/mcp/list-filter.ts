import type { ListFilter, WorkflowStatus } from '../core/types.ts';

const WORKFLOW_STATUS_VALUES: readonly WorkflowStatus[] = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed-out',
  'suspended',
];

export type McpListFilterParseResult =
  | { readonly ok: true; readonly filter: ListFilter }
  | { readonly ok: false; readonly message: string };

type FieldParseResult<TValue> =
  | { readonly ok: true; readonly value?: TValue }
  | { readonly ok: false; readonly message: string };

export function parseMcpListFilter(value: unknown): McpListFilterParseResult {
  if (!isRecord(value)) return { ok: false, message: 'List filter must be a JSON object' };
  const status = parseStatusFilter(value['status']);
  const type = parseOptionalString(value['type'], 'type');
  const tags = parseStringArray(value['tags'], 'tags');
  const limit = parseNonNegativeInteger(value['limit'], 'limit');
  const offset = parseNonNegativeInteger(value['offset'], 'offset');
  const failure = firstFailure([status, type, tags, limit, offset]);
  if (failure !== undefined) return failure;
  return {
    ok: true,
    filter: compactListFilter({
      status: parsedValue(status),
      type: parsedValue(type),
      tags: parsedValue(tags),
      limit: parsedValue(limit),
      offset: parsedValue(offset),
    }),
  };
}

export function parseMcpListFilterFromSearchParams(
  searchParams: URLSearchParams,
): McpListFilterParseResult {
  const record: Record<string, unknown> = {};
  const status = searchParams.getAll('status');
  if (status.length === 1) record['status'] = status[0];
  if (status.length > 1) record['status'] = status;
  const type = searchParams.get('type');
  if (type !== null) record['type'] = type;
  const tags = searchParams.getAll('tag');
  if (tags.length > 0) record['tags'] = tags;
  const limit = searchParams.get('limit');
  if (limit !== null) record['limit'] = Number(limit);
  const offset = searchParams.get('offset');
  if (offset !== null) record['offset'] = Number(offset);
  return parseMcpListFilter(record);
}

function parseStatusFilter(value: unknown): FieldParseResult<WorkflowStatus | WorkflowStatus[]> {
  if (value === undefined) return { ok: true };
  if (typeof value === 'string') {
    return isWorkflowStatus(value)
      ? { ok: true, value }
      : { ok: false, message: `Invalid workflow status: ${value}` };
  }
  if (!Array.isArray(value)) {
    return { ok: false, message: 'List filter status must be a workflow status or array' };
  }
  const statuses: WorkflowStatus[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !isWorkflowStatus(item)) {
      return { ok: false, message: 'List filter status array contains an invalid workflow status' };
    }
    statuses.push(item);
  }
  return { ok: true, value: statuses };
}

function parseOptionalString(value: unknown, field: string): FieldParseResult<string> {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'string')
    return { ok: false, message: `List filter ${field} must be a string` };
  return { ok: true, value };
}

function parseStringArray(value: unknown, field: string): FieldParseResult<string[]> {
  if (value === undefined) return { ok: true };
  if (!Array.isArray(value)) return { ok: false, message: `List filter ${field} must be an array` };
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      return { ok: false, message: `List filter ${field} must contain only strings` };
    }
    values.push(item);
  }
  return { ok: true, value: values };
}

function parseNonNegativeInteger(value: unknown, field: string): FieldParseResult<number> {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return { ok: false, message: `List filter ${field} must be a non-negative integer` };
  }
  return { ok: true, value };
}

function firstFailure(
  results: ReadonlyArray<FieldParseResult<unknown>>,
): { readonly ok: false; readonly message: string } | undefined {
  for (const result of results) {
    if (!result.ok) return result;
  }
  return undefined;
}

function parsedValue<TValue>(result: FieldParseResult<TValue>): TValue | undefined {
  return result.ok ? result.value : undefined;
}

function compactListFilter(fields: {
  readonly status: WorkflowStatus | WorkflowStatus[] | undefined;
  readonly type: string | undefined;
  readonly tags: string[] | undefined;
  readonly limit: number | undefined;
  readonly offset: number | undefined;
}): ListFilter {
  const filter: ListFilter = {};
  if (fields.status !== undefined) filter.status = fields.status;
  if (fields.type !== undefined) filter.type = fields.type;
  if (fields.tags !== undefined) filter.tags = fields.tags;
  if (fields.limit !== undefined) filter.limit = fields.limit;
  if (fields.offset !== undefined) filter.offset = fields.offset;
  return filter;
}

function isWorkflowStatus(value: string): value is WorkflowStatus {
  return WORKFLOW_STATUS_VALUES.some((status) => status === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
