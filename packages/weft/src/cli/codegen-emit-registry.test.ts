import { describe, expect, it } from 'bun:test';

import { type CodegenWorkflowEntry, emitRegistryDeclaration } from './codegen-emit-registry.ts';

function buildWorkflows(
  workflows: Record<string, Omit<CodegenWorkflowEntry, 'revision' | 'workflowVersion'>> = {},
): Record<string, CodegenWorkflowEntry> {
  const result: Record<string, CodegenWorkflowEntry> = {};
  for (const [name, entry] of Object.entries(workflows)) {
    result[name] = { revision: `sha256:${name}-revision`, workflowVersion: '1.0.0', ...entry };
  }
  return result;
}

describe('emitRegistryDeclaration', () => {
  it('emits a valid empty file when there are no active workflows', () => {
    const output = emitRegistryDeclaration(buildWorkflows());
    expect(output).toContain("declare module '@lostgradient/weft' {");
    expect(output).toContain('interface WorkflowRegistry {}');
    // Activity names are typed per-workflow via the builder's
    // `.activities({...})` step, not via a global module augmentation.
    expect(output).not.toContain('ActivityTypes');
    expect(output).toContain('export {};');
    expect(output.endsWith('\n')).toBe(true);
  });

  it('documents in the banner that the augmentation types both engine and client call sites', () => {
    // The emitted `WorkflowRegistry` augmentation is the single source of
    // truth for `engine.start`, the client (`WeftClient.start`/`schedule`),
    // and `result()` output narrowing. The banner records that intent so the
    // generated file is self-explanatory and consumers know it is not
    // engine-only.
    const output = emitRegistryDeclaration(buildWorkflows());
    expect(output).toContain('type engine and client call sites');
  });

  it('is byte-identical across two runs with the same input', () => {
    const workflows = buildWorkflows({
      welcome: {
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
          additionalProperties: false,
        },
        outputSchema: { type: 'string' },
      },
    });
    expect(emitRegistryDeclaration(workflows)).toBe(emitRegistryDeclaration(workflows));
  });

  it('sorts keys deterministically regardless of insertion order', () => {
    // Two records with explicitly reversed insertion order: V8
    // preserves string-key insertion order, so this is the only way
    // to prove the emitter sorts rather than relying on iteration
    // luck.
    const workflowsA = buildWorkflows({
      zeta: { inputSchema: { type: 'string' } },
      alpha: { inputSchema: { type: 'string' } },
    });
    const workflowsB = buildWorkflows({
      alpha: { inputSchema: { type: 'string' } },
      zeta: { inputSchema: { type: 'string' } },
    });
    const outputA = emitRegistryDeclaration(workflowsA);
    const outputB = emitRegistryDeclaration(workflowsB);
    expect(outputA).toBe(outputB);
    expect(outputA.indexOf('"alpha"')).toBeLessThan(outputA.indexOf('"zeta"'));
  });

  it('uses null-prototype-safe key handling for names like __proto__', () => {
    const workflows: Record<string, CodegenWorkflowEntry> = Object.create(null);
    workflows['__proto__'] = {
      inputSchema: { type: 'string' },
      revision: 'sha256:a',
      workflowVersion: '1.0.0',
    };
    workflows['valid'] = {
      inputSchema: { type: 'string' },
      revision: 'sha256:b',
      workflowVersion: '1.0.0',
    };
    const output = emitRegistryDeclaration(workflows);
    expect(output).toContain('"__proto__"');
    expect(output).toContain('"valid"');
  });

  it('emits unknown for workflows with no schemas', () => {
    const output = emitRegistryDeclaration(buildWorkflows({ bare: {} }));
    expect(output).toContain('"bare": { input: unknown; output: unknown;');
  });

  it('quotes names with special characters', () => {
    const output = emitRegistryDeclaration(
      buildWorkflows({ 'kebab-name': {}, 'with "quote"': {} }),
    );
    expect(output).toContain('"kebab-name"');
    expect(output).toContain('"with \\"quote\\""');
  });

  it('emits revision and workflowVersion as string-literal fields on every entry', () => {
    const output = emitRegistryDeclaration(
      buildWorkflows({
        welcome: { inputSchema: { type: 'string' }, outputSchema: { type: 'string' } },
      }),
    );
    expect(output).toContain(
      '"welcome": { input: string; output: string; revision: "sha256:welcome-revision"; workflowVersion: "1.0.0" };',
    );
  });

  it('safely embeds hostile revision/workflowVersion strings without breaking out of the string literal', () => {
    const hostileValues = [
      'has "quote"',
      'back\\slash',
      'line\nbreak',
      'back`tick',
      '*/ end comment',
      '</script>',
      '__proto__',
    ];
    for (const hostile of hostileValues) {
      const workflows: Record<string, CodegenWorkflowEntry> = {
        w: { revision: hostile, workflowVersion: '1.0.0' },
      };
      const output = emitRegistryDeclaration(workflows);
      // The value must appear only inside a JSON.stringify-quoted literal —
      // proven by round-tripping the emitted revision field back through
      // JSON.parse and confirming it recovers the original hostile string.
      const match = /revision: (".*?"); workflowVersion:/.exec(output);
      expect(match).not.toBeNull();
      expect(JSON.parse(match![1]!)).toBe(hostile);
    }
  });

  describe('schema alias hoisting', () => {
    const sharedInputSchema = {
      type: 'object',
      properties: { cartId: { type: 'string' } },
      required: ['cartId'],
      additionalProperties: false,
    };

    it('hoists a non-trivial input schema shared by two or more workflows into one alias referenced by every entry', () => {
      const output = emitRegistryDeclaration(
        buildWorkflows({
          checkout: { inputSchema: sharedInputSchema, outputSchema: { type: 'string' } },
          reorder: { inputSchema: sharedInputSchema, outputSchema: { type: 'boolean' } },
        }),
      );
      const aliasDeclarations = output.match(/^type __WeftSchema_[0-9a-f]+ = .+;$/gm) ?? [];
      expect(aliasDeclarations).toHaveLength(1);
      const aliasName = aliasDeclarations[0]!.match(/^type (__WeftSchema_[0-9a-f]+)/)![1]!;
      expect(output).toContain(`"checkout": { input: ${aliasName}; output: string;`);
      expect(output).toContain(`"reorder": { input: ${aliasName}; output: boolean;`);
    });

    it('keeps a single-occurrence schema inline (no alias emitted)', () => {
      const output = emitRegistryDeclaration(
        buildWorkflows({
          checkout: { inputSchema: sharedInputSchema },
        }),
      );
      expect(output).not.toMatch(/^type __WeftSchema_/m);
      expect(output).toContain('"checkout": { input: { "cartId": string; }; output: unknown;');
    });

    it('never aliases trivial types even when repeated across many workflows', () => {
      const output = emitRegistryDeclaration(
        buildWorkflows({
          a: { outputSchema: { type: 'string' } },
          b: { outputSchema: { type: 'string' } },
          c: {},
          d: {},
        }),
      );
      expect(output).not.toMatch(/^type __WeftSchema_/m);
      expect(output).toContain('"a": { input: unknown; output: string;');
      expect(output).toContain('"c": { input: unknown; output: unknown;');
    });

    it('emits alias declarations before, never inside, declare module', () => {
      const output = emitRegistryDeclaration(
        buildWorkflows({
          checkout: { inputSchema: sharedInputSchema },
          reorder: { inputSchema: sharedInputSchema },
        }),
      );
      const aliasIndex = output.indexOf('type __WeftSchema_');
      const moduleIndex = output.indexOf("declare module '@lostgradient/weft'");
      expect(aliasIndex).toBeGreaterThan(-1);
      expect(aliasIndex).toBeLessThan(moduleIndex);

      // The alias declaration must not appear textually between the
      // `declare module {` opener and its closing `}` — i.e. it is not
      // nested inside the augmentation block.
      const moduleBlock = output.slice(
        output.indexOf('{', moduleIndex),
        output.indexOf('\n}\n', moduleIndex),
      );
      expect(moduleBlock).not.toContain('type __WeftSchema_');
    });

    it('sorts multiple alias declarations deterministically, independent of insertion order', () => {
      const inputA = { type: 'object', properties: { a: { type: 'string' } } };
      const inputB = { type: 'object', properties: { b: { type: 'number' } } };

      const forward = emitRegistryDeclaration(
        buildWorkflows({
          w1: { inputSchema: inputA },
          w2: { inputSchema: inputA },
          w3: { inputSchema: inputB },
          w4: { inputSchema: inputB },
        }),
      );
      const reversed = emitRegistryDeclaration(
        buildWorkflows({
          w4: { inputSchema: inputB },
          w3: { inputSchema: inputB },
          w2: { inputSchema: inputA },
          w1: { inputSchema: inputA },
        }),
      );
      expect(forward).toBe(reversed);

      const aliasNames = [...forward.matchAll(/^type (__WeftSchema_[0-9a-f]+) =/gm)].map(
        (match) => match[1]!,
      );
      expect(aliasNames).toHaveLength(2);
      expect([...aliasNames].toSorted()).toEqual(aliasNames);
    });

    it('dedupes two schemas that differ only in JSON-level property/required order (same rendered type)', () => {
      // `required: ['cartId', 'note']` vs `required: ['note', 'cartId']` are
      // different JSON arrays, but `jsonSchemaToTypeScript` sorts object
      // properties by key regardless of declaration order, so both render
      // to byte-identical TypeScript. Grouping by the emitted text (not by
      // a JSON-level canonicalization of the schema) means these two still
      // dedupe correctly instead of each staying inline.
      const schemaA = {
        type: 'object',
        properties: { cartId: { type: 'string' }, note: { type: 'string' } },
        required: ['cartId', 'note'],
        additionalProperties: false,
      };
      const schemaB = {
        type: 'object',
        properties: { note: { type: 'string' }, cartId: { type: 'string' } },
        required: ['note', 'cartId'],
        additionalProperties: false,
      };
      const output = emitRegistryDeclaration(
        buildWorkflows({
          checkout: { inputSchema: schemaA },
          reorder: { inputSchema: schemaB },
        }),
      );
      const aliasDeclarations = output.match(/^type __WeftSchema_[0-9a-f]+ = .+;$/gm) ?? [];
      expect(aliasDeclarations).toHaveLength(1);
      const aliasName = aliasDeclarations[0]!.match(/^type (__WeftSchema_[0-9a-f]+)/)![1]!;
      expect(output).toContain(`"checkout": { input: ${aliasName};`);
      expect(output).toContain(`"reorder": { input: ${aliasName};`);
    });

    it('two workflows both lacking an input schema do not spuriously share an aliased type', () => {
      // inputSchema undefined -> canonicalKey 'null', tsType 'unknown' for
      // both. `unknown` is trivial, so no alias is emitted even though the
      // (degenerate) schema "recurs".
      const output = emitRegistryDeclaration(
        buildWorkflows({
          noInputA: { outputSchema: { type: 'string' } },
          noInputB: { outputSchema: { type: 'string' } },
        }),
      );
      expect(output).not.toMatch(/^type __WeftSchema_/m);
    });
  });
});
