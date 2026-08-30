/**
 * Shared bounded-concurrency size for materializing candidate workflow states.
 * Keep this internal to engine query paths; it limits storage fan-out without
 * changing result ordering.
 */
export const CONSTRAINED_ID_CHUNK_SIZE = 64;
