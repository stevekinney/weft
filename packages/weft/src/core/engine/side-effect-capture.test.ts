import { describe, expect, it } from 'bun:test';

import type { ContextOperationRequest } from '../context.ts';
import {
  captureSideEffects,
  capturedSideEffectSinkOf,
  inheritSideEffectCapture,
} from './side-effect-capture.ts';

describe('side-effect capture inheritance', () => {
  it('replaces a closed inherited capture when a request runs under a new parent', () => {
    const child = { operationId: 'activity:child', type: 'activity' } as ContextOperationRequest;
    const firstParent = {
      operationId: 'parallel:first',
      type: 'parallel',
    } as ContextOperationRequest;
    const secondParent = {
      operationId: 'parallel:second',
      type: 'parallel',
    } as ContextOperationRequest;
    const firstSink = () => undefined;
    const secondSink = () => undefined;

    const endFirst = captureSideEffects(firstParent, firstSink);
    inheritSideEffectCapture(firstParent, [child]);
    endFirst();

    captureSideEffects(secondParent, secondSink);
    inheritSideEffectCapture(secondParent, [child]);

    expect(capturedSideEffectSinkOf(child)).toBe(secondSink);
  });
});
