/**
 * Which of a workflow's two event streams a subscriber reads: its lifecycle `events` or its
 * `tokens`. Declared apart from the feed so a session can validate the choice without importing it.
 *
 * @module server/event-selector
 */

export type EventSelector = 'events' | 'tokens';
