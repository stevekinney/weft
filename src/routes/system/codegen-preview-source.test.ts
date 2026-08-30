import { describe, expect, test } from 'bun:test';

import { codegenPreviewSource, type RegistryLike } from './codegen-preview-source.ts';

describe('codegenPreviewSource', () => {
  test('undefined when nothing is registered', () => {
    expect(
      codegenPreviewSource({ registryVersion: 1, workflows: {}, activities: {} }),
    ).toBeUndefined();
  });

  test('undefined when no workflow has an input schema', () => {
    const registry: RegistryLike = {
      registryVersion: 1,
      workflows: { 'long-sleeper': {}, 'review-gate': {} },
      activities: {},
    };
    expect(codegenPreviewSource(registry)).toBeUndefined();
  });

  test('picks the codepoint-first workflow with a schema and renders its preview', () => {
    const registry: RegistryLike = {
      registryVersion: 1,
      workflows: {
        'zebra-workflow': {
          inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        },
        'order-processing': {
          inputSchema: {
            type: 'object',
            required: ['orderId'],
            properties: { orderId: { type: 'string' } },
          },
        },
      },
      activities: {},
    };

    const preview = codegenPreviewSource(registry);
    expect(preview).toContain('export interface OrderProcessingInput');
    expect(preview).not.toContain('Zebra');
  });
});
