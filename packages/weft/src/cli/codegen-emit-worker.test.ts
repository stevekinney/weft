import { describe, expect, it } from 'bun:test';

import { emitWorkerImplementationModule } from './codegen-emit-worker.ts';

describe('emitWorkerImplementationModule', () => {
  it('emits deterministic typed worker implementation surfaces', () => {
    const output = emitWorkerImplementationModule(
      {
        welcome: {
          revision: 'sha256:workflow',
          workflowVersion: '1.0.0',
          contractHash: 'sha256:contract',
          activities: {
            formatGreeting: {
              inputSchema: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name'],
                additionalProperties: false,
              },
              outputSchema: { type: 'string' },
            },
          },
        },
      },
      '@lostgradient/weft',
    );

    expect(output).toContain(
      "import { defineWorker } from '@lostgradient/weft/worker/generated-authoring';",
    );
    expect(output).toContain('type __WeftWorker_welcome = {');
    expect(output).toContain('"formatGreeting": (input: { "name": string; }');
    expect(output).toContain(
      'context?: import("@lostgradient/weft/worker/generated-authoring").RemoteActivityContext',
    );
    expect(output).toContain('export function defineGeneratedWorker');
    expect(output).toBe(
      emitWorkerImplementationModule(
        {
          welcome: {
            revision: 'sha256:workflow',
            workflowVersion: '1.0.0',
            contractHash: 'sha256:contract',
            activities: {
              formatGreeting: {
                inputSchema: {
                  required: ['name'],
                  additionalProperties: false,
                  properties: { name: { type: 'string' } },
                  type: 'object',
                },
                outputSchema: { type: 'string' },
              },
            },
          },
        },
        '@lostgradient/weft',
      ),
    );
  });
});
