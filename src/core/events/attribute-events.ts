/**
 * Fired on the {@link Engine} when a workflow's search attributes are updated
 * via `engine.setAttributes` or `ctx.setAttribute`. Read `e.changes` for the
 * map of attribute keys to their new values.
 *
 * @example
 * ```ts
 * import { Engine, AttributesChangedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('attributes:changed', (e: Event) => {
 *   const ev = e as AttributesChangedEvent;
 *   console.log('attributes changed for', ev.workflowId, ev.changes);
 * });
 * ```
 */
export class AttributesChangedEvent extends Event {
  static readonly type = 'attributes:changed' as const;
  readonly workflowId: string;
  readonly changes: Record<string, unknown>;

  constructor(workflowId: string, changes: Record<string, unknown>) {
    super(AttributesChangedEvent.type);
    this.workflowId = workflowId;
    this.changes = changes;
  }
}
