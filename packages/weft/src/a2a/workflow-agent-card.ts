/**
 * The Agent Card of a Weft workflow served as an A2A agent.
 *
 * @module a2a/workflow-agent-card
 */

import type { AgentCard } from '@a2a-js/sdk';

import type { RegisteredWorkflowDefinition } from '../core/types/workflow-registry.ts';
import type { A2ASecurityDeclaration } from './security-schemes.ts';

/** How a message becomes a workflow's input or a signal's payload. */
export type WorkflowAgentInputMode = 'data' | 'text';

/** The card fields the workflow's definition cannot supply. */
export type WorkflowAgentCardOptions = {
  /** The agent's name, and its one skill's name. */
  readonly name: string;
  /** Used when the workflow's definition has no `description`. */
  readonly description?: string;
  /**
   * The credentials the card advertises, typically from `securitySchemesFromAuthConfig`.
   * Serve the card with an `authenticate` that accepts exactly these.
   */
  readonly security?: A2ASecurityDeclaration;
};

const JSON_MEDIA_TYPE = 'application/json';
const TEXT_MEDIA_TYPE = 'text/plain';

/**
 * Build the Agent Card for one registered workflow. The kit's `createA2AHandler` adds
 * the card's one interface, whose URL is its `publicUrl` option.
 *
 * - `name` is `card.name`; `description` is the definition's `description`, else
 *   `card.description`; `version` is the definition's `version`.
 * - Input and output modes are `application/json`, plus `text/plain` input for
 *   `inputMode: 'text'`.
 * - One skill: `id` is the workflow type, `name` and `description` are the card's, and
 *   `tags` are the definition's.
 * - `capabilities.streaming` and `capabilities.pushNotifications` are `true`.
 *
 * @throws {Error} When neither the definition nor `card` has a description.
 */
export function createWorkflowAgentCard(options: {
  readonly definition: RegisteredWorkflowDefinition;
  readonly inputMode: WorkflowAgentInputMode;
  readonly card: WorkflowAgentCardOptions;
}): AgentCard {
  const { definition, inputMode, card } = options;
  const description = definition.description ?? card.description;
  if (description === undefined || description === '') {
    throw new Error(
      `Workflow '${definition.type}' has no description; give its definition a description or pass card.description.`,
    );
  }
  const inputModes = inputMode === 'text' ? [JSON_MEDIA_TYPE, TEXT_MEDIA_TYPE] : [JSON_MEDIA_TYPE];
  return {
    name: card.name,
    description,
    supportedInterfaces: [],
    provider: undefined,
    version: definition.version,
    documentationUrl: undefined,
    capabilities: { streaming: true, pushNotifications: true, extensions: [] },
    securitySchemes: { ...card.security?.securitySchemes },
    securityRequirements: [...(card.security?.securityRequirements ?? [])],
    defaultInputModes: inputModes,
    defaultOutputModes: [JSON_MEDIA_TYPE],
    skills: [
      {
        id: definition.type,
        name: card.name,
        description,
        tags: [...definition.tags],
        examples: [],
        inputModes: [],
        outputModes: [],
        securityRequirements: [],
      },
    ],
    signatures: [],
    iconUrl: undefined,
  };
}
