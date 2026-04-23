/**
 * Phase 15b — Tests for per-operation REST dispatch-mode resolution.
 *
 * `resolveRestDispatchMode(config, operationName)` decides whether the
 * REST transport should invoke the legacy `handleXxx` executor or the
 * new `executeOperation` pipeline for a given operation. The config
 * shape accepts both a scalar default ('legacy' | 'via-execute-operation')
 * and a per-operation override map. Resolution rules:
 *
 *   1. Config missing entirely → 'legacy' (safe default during Milestone 1).
 *   2. Config is a string → that string applies to every operation.
 *   3. Config is an object:
 *      - If `operationName` is a key in `operations`, that value wins.
 *      - Otherwise, `default` wins (falling back to 'legacy' when absent).
 *
 * The test file drives the helper's behavior before the helper exists
 * (TDD). Wiring this helper into `handleRequest` happens in Phase 15c
 * alongside the first migrated operation's parity diff test.
 */

import { describe, expect, it } from 'bun:test';

import { resolveRestDispatchMode, type RestDispatchModeConfig } from './rest-dispatch-mode.ts';

describe('resolveRestDispatchMode', () => {
  it('returns legacy when no config is provided', () => {
    expect(resolveRestDispatchMode(undefined, 'weft.workflows.get')).toBe('legacy');
  });

  it('applies a scalar string config to every operation', () => {
    expect(resolveRestDispatchMode('via-execute-operation', 'weft.workflows.get')).toBe(
      'via-execute-operation',
    );
    expect(resolveRestDispatchMode('legacy', 'weft.workflows.start')).toBe('legacy');
  });

  it('uses the object default when the operation is not overridden', () => {
    const config: RestDispatchModeConfig = {
      default: 'via-execute-operation',
      operations: {},
    };
    expect(resolveRestDispatchMode(config, 'weft.workflows.get')).toBe('via-execute-operation');
  });

  it('prefers a per-operation override over the object default', () => {
    const config: RestDispatchModeConfig = {
      default: 'legacy',
      operations: { 'weft.workflows.get': 'via-execute-operation' },
    };
    expect(resolveRestDispatchMode(config, 'weft.workflows.get')).toBe('via-execute-operation');
    expect(resolveRestDispatchMode(config, 'weft.workflows.start')).toBe('legacy');
  });

  it('falls back to legacy when the object default is omitted', () => {
    const config: RestDispatchModeConfig = {
      operations: { 'weft.workflows.get': 'via-execute-operation' },
    };
    expect(resolveRestDispatchMode(config, 'weft.workflows.get')).toBe('via-execute-operation');
    expect(resolveRestDispatchMode(config, 'weft.workflows.start')).toBe('legacy');
  });

  it('treats an empty object as pure fallback (legacy for every op)', () => {
    const config: RestDispatchModeConfig = {};
    expect(resolveRestDispatchMode(config, 'weft.workflows.get')).toBe('legacy');
  });
});
