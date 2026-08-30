import type { WorkerOutboundMessage } from './types.ts';

export class WorkerCheckpointResumeState {
  readonly #resumeVersionsByWorkflowId = new Map<string, number>();
  readonly #checkpointHandlerCountsByWorkflowId = new Map<string, number>();

  resetWorkflow(workflowId: string): void {
    this.#resumeVersionsByWorkflowId.delete(workflowId);
    this.#checkpointHandlerCountsByWorkflowId.delete(workflowId);
  }

  clear(): void {
    this.#resumeVersionsByWorkflowId.clear();
    this.#checkpointHandlerCountsByWorkflowId.clear();
  }

  recordResume(workflowId: string): void {
    this.#resumeVersionsByWorkflowId.set(
      workflowId,
      (this.#resumeVersionsByWorkflowId.get(workflowId) ?? 0) + 1,
    );
  }

  beginCheckpointHandling(message: WorkerOutboundMessage): number | null {
    if (message.type !== 'checkpoint') {
      return null;
    }

    this.#checkpointHandlerCountsByWorkflowId.set(
      message.workflowId,
      (this.#checkpointHandlerCountsByWorkflowId.get(message.workflowId) ?? 0) + 1,
    );
    return this.#resumeVersionsByWorkflowId.get(message.workflowId) ?? 0;
  }

  finishCheckpointHandling(
    workflowId: string,
    resumeVersionBeforeCheckpointHandling: number | null,
    workflowIsClosed: boolean,
  ): void {
    if (resumeVersionBeforeCheckpointHandling === null) {
      return;
    }

    const remainingHandlerCount =
      (this.#checkpointHandlerCountsByWorkflowId.get(workflowId) ?? 1) - 1;
    if (remainingHandlerCount > 0) {
      this.#checkpointHandlerCountsByWorkflowId.set(workflowId, remainingHandlerCount);
      return;
    }

    this.#checkpointHandlerCountsByWorkflowId.delete(workflowId);
    this.forgetWorkflowIfClosed(workflowId, workflowIsClosed);
  }

  wasResumedDuringCheckpointHandling(
    workflowId: string,
    resumeVersionBeforeCheckpointHandling: number | null,
  ): boolean {
    return (
      resumeVersionBeforeCheckpointHandling !== null &&
      (this.#resumeVersionsByWorkflowId.get(workflowId) ?? 0) >
        resumeVersionBeforeCheckpointHandling
    );
  }

  forgetWorkflowIfClosed(workflowId: string, workflowIsClosed: boolean): void {
    if (!workflowIsClosed || this.#checkpointHandlerCountsByWorkflowId.has(workflowId)) {
      return;
    }

    this.#resumeVersionsByWorkflowId.delete(workflowId);
  }
}
