import { describe, expect, it } from 'bun:test';

import {
  serializeWorkflowClaimMetricsForPrometheus,
  WORKFLOW_CLAIM_ATTEMPT_OUTCOMES,
  WorkflowClaimMetricsCollector,
} from './workflow-claim-metrics.ts';

describe('WORKFLOW_CLAIM_ATTEMPT_OUTCOMES', () => {
  it('is bounded to exactly the five outcomes ADR 0002 specifies', () => {
    expect(WORKFLOW_CLAIM_ATTEMPT_OUTCOMES).toEqual([
      'acquired',
      'takeover',
      'lost_race',
      'deposed',
      'backoff_skipped',
    ]);
    expect(WORKFLOW_CLAIM_ATTEMPT_OUTCOMES.length).toBe(5);
  });
});

describe('WorkflowClaimMetricsCollector', () => {
  it('starts every outcome, the gauge, and the renewal-failure counter at zero', () => {
    const collector = new WorkflowClaimMetricsCollector();
    const snapshot = collector.snapshot();
    expect(snapshot.activeClaims).toBe(0);
    expect(snapshot.renewalFailures).toBe(0);
    for (const outcome of WORKFLOW_CLAIM_ATTEMPT_OUTCOMES) {
      expect(snapshot.attempts[outcome]).toBe(0);
    }
  });

  it('increments only the recorded outcome, leaving the other four untouched', () => {
    const collector = new WorkflowClaimMetricsCollector();
    collector.recordClaimAttempt('acquired');
    collector.recordClaimAttempt('acquired');

    const snapshot = collector.snapshot();
    expect(snapshot.attempts.acquired).toBe(2);
    expect(snapshot.attempts.takeover).toBe(0);
    expect(snapshot.attempts.lost_race).toBe(0);
    expect(snapshot.attempts.deposed).toBe(0);
    expect(snapshot.attempts.backoff_skipped).toBe(0);
  });

  for (const outcome of WORKFLOW_CLAIM_ATTEMPT_OUTCOMES) {
    it(`records the ${outcome} outcome independently of the others`, () => {
      const collector = new WorkflowClaimMetricsCollector();
      collector.recordClaimAttempt(outcome);
      const snapshot = collector.snapshot();
      for (const candidate of WORKFLOW_CLAIM_ATTEMPT_OUTCOMES) {
        expect(snapshot.attempts[candidate]).toBe(candidate === outcome ? 1 : 0);
      }
    });
  }

  it('tracks the active-claims gauge up and down as an absolute set', () => {
    const collector = new WorkflowClaimMetricsCollector();
    collector.setActiveClaims(3);
    expect(collector.snapshot().activeClaims).toBe(3);
    collector.setActiveClaims(7);
    expect(collector.snapshot().activeClaims).toBe(7);
    collector.setActiveClaims(1);
    expect(collector.snapshot().activeClaims).toBe(1);
    collector.setActiveClaims(0);
    expect(collector.snapshot().activeClaims).toBe(0);
  });

  it('rejects a negative active-claims count', () => {
    const collector = new WorkflowClaimMetricsCollector();
    expect(() => collector.setActiveClaims(-1)).toThrow(RangeError);
  });

  it('rejects a non-integer active-claims count', () => {
    const collector = new WorkflowClaimMetricsCollector();
    expect(() => collector.setActiveClaims(1.5)).toThrow(RangeError);
  });

  it('rejects an unsafe-integer active-claims count', () => {
    const collector = new WorkflowClaimMetricsCollector();
    expect(() => collector.setActiveClaims(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });

  it('increments the renewal-failure counter independently of attempts and the gauge', () => {
    const collector = new WorkflowClaimMetricsCollector();
    collector.recordClaimAttempt('deposed');
    collector.setActiveClaims(2);
    collector.recordClaimRenewalFailure();
    collector.recordClaimRenewalFailure();

    const snapshot = collector.snapshot();
    expect(snapshot.renewalFailures).toBe(2);
    expect(snapshot.attempts.deposed).toBe(1);
    expect(snapshot.activeClaims).toBe(2);
  });

  it('reset() clears attempts, the gauge, and the renewal-failure counter back to zero', () => {
    const collector = new WorkflowClaimMetricsCollector();
    collector.recordClaimAttempt('takeover');
    collector.setActiveClaims(5);
    collector.recordClaimRenewalFailure();

    collector.reset();

    const snapshot = collector.snapshot();
    expect(snapshot.activeClaims).toBe(0);
    expect(snapshot.renewalFailures).toBe(0);
    for (const outcome of WORKFLOW_CLAIM_ATTEMPT_OUTCOMES) {
      expect(snapshot.attempts[outcome]).toBe(0);
    }
  });

  it('snapshot() returns an independent copy that does not alias future mutations', () => {
    const collector = new WorkflowClaimMetricsCollector();
    const first = collector.snapshot();
    collector.recordClaimAttempt('lost_race');
    expect(first.attempts.lost_race).toBe(0);
    expect(collector.snapshot().attempts.lost_race).toBe(1);
  });
});

describe('serializeWorkflowClaimMetricsForPrometheus', () => {
  it('emits every outcome, including zero-valued ones, for a stable scrape schema', () => {
    const collector = new WorkflowClaimMetricsCollector();
    collector.recordClaimAttempt('acquired');
    collector.setActiveClaims(4);
    collector.recordClaimRenewalFailure();

    const body = serializeWorkflowClaimMetricsForPrometheus(collector.snapshot());

    expect(body).toContain('# TYPE weft_workflow_claim_attempts_total counter');
    expect(body).toContain('weft_workflow_claim_attempts_total{outcome="acquired"} 1');
    expect(body).toContain('weft_workflow_claim_attempts_total{outcome="takeover"} 0');
    expect(body).toContain('weft_workflow_claim_attempts_total{outcome="lost_race"} 0');
    expect(body).toContain('weft_workflow_claim_attempts_total{outcome="deposed"} 0');
    expect(body).toContain('weft_workflow_claim_attempts_total{outcome="backoff_skipped"} 0');
    expect(body).toContain('# TYPE weft_workflow_claims_active gauge');
    expect(body).toContain('weft_workflow_claims_active 4');
    expect(body).toContain('# TYPE weft_workflow_claim_renewal_failures_total counter');
    expect(body).toContain('weft_workflow_claim_renewal_failures_total 1');
    expect(body.endsWith('\n')).toBe(true);
  });

  it('emits a stable schema even for an all-zero snapshot', () => {
    const collector = new WorkflowClaimMetricsCollector();
    const body = serializeWorkflowClaimMetricsForPrometheus(collector.snapshot());
    for (const outcome of WORKFLOW_CLAIM_ATTEMPT_OUTCOMES) {
      expect(body).toContain(`weft_workflow_claim_attempts_total{outcome="${outcome}"} 0`);
    }
    expect(body).toContain('weft_workflow_claims_active 0');
    expect(body).toContain('weft_workflow_claim_renewal_failures_total 0');
  });
});
