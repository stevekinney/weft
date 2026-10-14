/** Engine options that decide when workflow state writes maintain the visibility indexes. */
export interface WorkflowVisibilityIndexOptions {
  /**
   * Write the workflow visibility indexes (`wf-idx-*` rows) with every workflow
   * state write, even before the visibility backfill has made them live.
   * Default: false.
   *
   * Without it, an engine writes index rows only once the `wf-idx-meta:version`
   * watermark is current, or always under `ownership: 'workflow-lease'`, whose
   * reclaim scan reads the `running` index. Set it on every engine that keeps
   * writing to the store while
   * `scripts/rebuild-workflow-visibility-indexes.ts` runs: the backfill scans
   * each workflow once, so a workflow that changes after the scan passed it
   * stays exact only if the write that changed it also wrote its index rows.
   * Engines paused for the backfill do not need it, and once the watermark is
   * current the setting no longer changes anything.
   */
  maintainWorkflowVisibilityIndexes?: boolean;
}
