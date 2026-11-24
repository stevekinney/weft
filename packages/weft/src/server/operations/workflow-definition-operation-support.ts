/**
 * Shared pieces of `weft.workflows.definitions.list` and
 * `weft.workflows.definitions.get`: their access policy, the summary schema
 * both return, and the engine guard.
 *
 * @module server/operations/workflow-definition-operation-support
 */

import { z } from 'zod';

import type { AccessPolicy } from "../../embedded/backchannel/src/internals.ts";
import { Engine } from '../../core/engine.ts';

/**
 * Readable under `system:read` or `workflows:read`: the catalog describes what
 * the engine can run, which the system-level and workflow-level readers each
 * already see in part.
 */
export const workflowDefinitionsReadAccess: AccessPolicy = {
  kind: 'scoped',
  scopes: { kind: 'anyOf', scopes: ['system:read', 'workflows:read'] },
};

/**
 * Fields shared by a list entry and a `get` result. There is deliberately no
 * owner or author field: `origin` names how Weft loaded the type, never who
 * wrote it.
 */
export const workflowDefinitionSummaryShape = {
  name: z.string(),
  origin: z.enum(['code', 'source']),
  state: z.enum(['ready', 'idle', 'loading', 'failed', 'cancelled']),
  lastFailureCategory: z
    .enum(['application', 'timeout', 'cancellation', 'resource', 'system'])
    .nullable(),
  revision: z.string().nullable(),
  workflowVersion: z.string().nullable(),
  description: z.string().nullable(),
  tags: z.array(z.string()).nullable(),
  signals: z.array(z.string()).nullable(),
  updates: z.array(z.string()).nullable(),
  queries: z.array(z.string()).nullable(),
} as const;

/** Narrow an operation host to a concrete engine, as `weft.system.registry` does. */
export function requireDefinitionEngine(host: unknown): Engine {
  if (!(host instanceof Engine)) {
    throw new TypeError('Workflow definitions require a concrete Engine instance.');
  }
  return host;
}
