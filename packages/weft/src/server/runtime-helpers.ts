/** Claim the next event sequence number for a workflow. */
export function claimNextSequence(
  sequenceCounters: Map<string, number>,
  workflowId: string,
): number {
  const current = sequenceCounters.get(workflowId);
  if (current === undefined) {
    throw new Error(`Sequence counter for workflow "${workflowId}" accessed before initialization`);
  }
  sequenceCounters.set(workflowId, current + 1);
  return current;
}

/** Evict the oldest workflow affinity entry when the cache grows beyond its cap. */
export function evictOldestAffinityEntries(
  workerAffinity: Map<string, string>,
  maxEntries: number,
): void {
  if (workerAffinity.size > maxEntries) {
    const firstKey = workerAffinity.keys().next().value;
    if (firstKey !== undefined) workerAffinity.delete(firstKey);
  }
}

/** Restore an extended deadline back into the tracker when a stale heap entry expires. */
export function restoreExtendedDeadline(
  deadlineTracker: { add(entry: { operationId: string; deadline: number }): void },
  operationId: string,
  deadline: number,
): void {
  deadlineTracker.add({ operationId, deadline });
}

/** Restore a stale heap entry when the recorded deadline is still in the future. */
export function restoreExtendedDeadlineIfStillActive(
  deadlineTracker: { add(entry: { operationId: string; deadline: number }): void },
  operationId: string,
  deadline: number,
  now: number,
): boolean {
  if (deadline <= now) {
    return false;
  }

  restoreExtendedDeadline(deadlineTracker, operationId, deadline);
  return true;
}
