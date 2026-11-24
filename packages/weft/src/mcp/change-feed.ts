import type { Engine } from '../core/engine.ts';
import { WorkflowDefinitionRegisteredEvent, type WeftEventMap } from '../core/events.ts';
import { listMcpTools } from './tools.ts';
import { tupleListsEqual } from './tuple-list-equality.ts';

/**
 * Receives the engine changes an MCP client can observe. The HTTP endpoint
 * forwards them to the SDK's `subscriptions/listen` bus; a stdio connection
 * forwards them to the one server instance it has pinned.
 */
export type McpChangeSink = {
  /** A workflow's state, event log, or checkpoints may have changed. */
  readonly workflowChanged: (workflowId: string) => void;
  /** The tool list the engine's registry projects to has changed. */
  readonly toolsChanged: () => void;
};

type ToolListSignatureEntry = readonly [
  name: string,
  title: string | undefined,
  description: string,
  inputSchemaJson: string,
];

const WORKFLOW_EVENT_NAMES = [
  'workflow:started',
  'workflow:completed',
  'workflow:failed',
  'workflow:cancelled',
  'workflow:timed-out',
  'workflow:resumed',
  'workflow:suspended',
  'signal:received',
  'signal:waiting',
  'signal:delivered',
  'attributes:changed',
  'update:received',
  'update:completed',
] as const satisfies ReadonlyArray<keyof WeftEventMap>;

/**
 * Translates engine events into MCP change notifications for every attached
 * sink. Tool-list changes are reported only when the projected tool list
 * actually differs, so registering a workflow without an input schema (which
 * projects to no tool) stays silent.
 */
export class McpChangeFeed implements AsyncDisposable {
  readonly #engine: Engine;
  readonly #sinks = new Set<McpChangeSink>();
  readonly #workflowListener: EventListener;
  readonly #definitionListener: EventListener;
  #toolListSignature: ReadonlyArray<ToolListSignatureEntry>;

  constructor(engine: Engine) {
    this.#engine = engine;
    this.#toolListSignature = toolListSignature(engine);
    this.#workflowListener = (event) => {
      const workflowId = (event as { workflowId?: unknown }).workflowId;
      if (typeof workflowId !== 'string') return;
      for (const sink of this.#sinks) sink.workflowChanged(workflowId);
    };
    this.#definitionListener = () => {
      const nextSignature = toolListSignature(this.#engine);
      if (toolListSignaturesEqual(this.#toolListSignature, nextSignature)) return;
      this.#toolListSignature = nextSignature;
      for (const sink of this.#sinks) sink.toolsChanged();
    };
    for (const eventName of WORKFLOW_EVENT_NAMES) {
      engine.addEventListener(eventName, this.#workflowListener);
    }
    engine.addEventListener(WorkflowDefinitionRegisteredEvent.type, this.#definitionListener);
  }

  /** Attach a sink for the rest of the feed's life; disposing the feed drops every sink. */
  attach(sink: McpChangeSink): void {
    this.#sinks.add(sink);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const eventName of WORKFLOW_EVENT_NAMES) {
      this.#engine.removeEventListener(eventName, this.#workflowListener);
    }
    this.#engine.removeEventListener(
      WorkflowDefinitionRegisteredEvent.type,
      this.#definitionListener,
    );
    this.#sinks.clear();
  }
}

function toolListSignature(engine: Engine): ToolListSignatureEntry[] {
  return listMcpTools(engine).map((tool) => [
    tool.name,
    tool.title,
    tool.description,
    JSON.stringify(tool.inputSchema) ?? '',
  ]);
}

function toolListSignaturesEqual(
  left: ReadonlyArray<ToolListSignatureEntry>,
  right: ReadonlyArray<ToolListSignatureEntry>,
): boolean {
  return tupleListsEqual(
    left,
    right,
    (leftEntry, rightEntry) =>
      leftEntry[0] === rightEntry[0] &&
      leftEntry[1] === rightEntry[1] &&
      leftEntry[2] === rightEntry[2] &&
      leftEntry[3] === rightEntry[3],
  );
}
