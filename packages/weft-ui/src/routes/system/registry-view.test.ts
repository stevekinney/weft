import { describe, expect, test } from 'bun:test';

import {
  buildSchemaTree,
  extractSchemaFields,
  isRegistryEmpty,
  registryActivityRows,
  registryWorkflowRows,
  schemaTypeLabel,
  type RegistrySnapshotSource,
} from './registry-view.ts';

describe('extractSchemaFields', () => {
  test('returns [] for an undefined schema', () => {
    expect(extractSchemaFields(undefined)).toEqual([]);
  });

  test('returns [] for a non-object (e.g. bare string) schema', () => {
    expect(extractSchemaFields({ type: 'string' })).toEqual([]);
  });

  test('extracts properties sorted by name, marking required fields', () => {
    const fields = extractSchemaFields({
      type: 'object',
      required: ['orderId'],
      properties: {
        orderId: { type: 'string', description: 'The order id.' },
        amountCents: { type: 'number' },
      },
    });

    expect(fields).toEqual([
      { name: 'amountCents', type: 'number', required: false, description: undefined },
      { name: 'orderId', type: 'string', required: true, description: 'The order id.' },
    ]);
  });

  test('labels enum, union, and array-of-types fragments', () => {
    const fields = extractSchemaFields({
      type: 'object',
      properties: {
        tier: { enum: ['bronze', 'silver', 'gold'] },
        target: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        multi: { type: ['string', 'null'] },
        opaque: {},
      },
    });

    const byName = Object.fromEntries(fields.map((field) => [field.name, field.type]));
    expect(byName).toEqual({
      tier: 'enum',
      target: 'union',
      multi: 'string | null',
      opaque: 'unknown',
    });
  });
});

const SNAPSHOT: RegistrySnapshotSource = {
  registryVersion: 2,
  generatedAt: '2026-01-01T00:00:00.000Z',
  workflows: [
    {
      manifestVersion: 1,
      name: 'order-processing',
      workflowVersion: '1.0.0',
      revision: 'sha256:order-processing-revision',
      contractHash: 'sha256:order-processing-hash',
      contract: {
        name: 'order-processing',
        workflowVersion: '1.0.0',
        description: 'Processes an order end to end.',
        tags: ['commerce'],
        inputSchema: {
          type: 'object',
          required: ['orderId'],
          properties: { orderId: { type: 'string' } },
        },
        signals: {
          cancel: { inputSchema: { type: 'object', properties: { reason: {} } } },
        },
        updates: {
          expedite: {
            inputSchema: { type: 'object', properties: { rush: { type: 'boolean' } } },
            outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
          },
        },
        queries: {
          status: { outputSchema: { type: 'object', properties: { state: { type: 'string' } } } },
        },
        activities: {
          chargeCard: {
            inputSchema: { type: 'object', properties: { amountCents: { type: 'number' } } },
          },
        },
        finalizer: { inputSchema: { type: 'object', properties: { orderId: { type: 'string' } } } },
      },
    },
    {
      manifestVersion: 1,
      name: 'audit-sweep',
      workflowVersion: '1.0.0',
      revision: 'sha256:audit-sweep-revision',
      contractHash: 'sha256:audit-sweep-hash',
      contract: { name: 'audit-sweep', workflowVersion: '1.0.0' },
    },
  ],
  activeRevisions: {
    'order-processing': 'sha256:order-processing-revision',
    'audit-sweep': 'sha256:audit-sweep-revision',
  },
  activities: {
    chargeCard: { queue: 'default', description: 'Charges a card.' },
    reserveInventory: {
      queue: 'inventory',
      inputSchema: {
        type: 'object',
        properties: { orderId: { type: 'string' } },
      },
      retry: { maxAttempts: 3, initialBackoff: '200ms', backoffMultiplier: 2, maxBackoff: '2s' },
      timeout: '30s',
    },
  },
};

describe('schemaTypeLabel', () => {
  test('labels a root object schema, a root primitive schema, and an unrecognized fragment', () => {
    expect(schemaTypeLabel({ type: 'object', properties: {} })).toBe('object');
    expect(schemaTypeLabel({ type: 'string' })).toBe('string');
    expect(schemaTypeLabel({})).toBe('unknown');
  });
});

describe('registryWorkflowRows', () => {
  test('sorts by type (codepoint order) and maps schema presence', () => {
    const rows = registryWorkflowRows(SNAPSHOT);
    expect(rows.map((row) => row.type)).toEqual(['audit-sweep', 'order-processing']);

    const orderProcessing = rows[1];
    expect(orderProcessing?.hasInputSchema).toBe(true);
    expect(orderProcessing?.inputFields).toEqual([
      { name: 'orderId', type: 'string', required: true, description: undefined },
    ]);
    expect(orderProcessing?.inputSchemaRootType).toBe('object');
    expect(orderProcessing?.hasOutputSchema).toBe(false);
    expect(orderProcessing?.outputSchemaRootType).toBeUndefined();

    const auditSweep = rows[0];
    expect(auditSweep?.hasInputSchema).toBe(false);
    expect(auditSweep?.inputSchemaRootType).toBeUndefined();
    expect(auditSweep?.tags).toEqual([]);
  });

  test('surfaces revision identity fields (revision, workflowVersion, manifestVersion, contractHash)', () => {
    const rows = registryWorkflowRows(SNAPSHOT);
    const orderProcessing = rows.find((row) => row.type === 'order-processing');
    expect(orderProcessing?.revision).toBe('sha256:order-processing-revision');
    expect(orderProcessing?.workflowVersion).toBe('1.0.0');
    expect(orderProcessing?.manifestVersion).toBe(1);
    expect(orderProcessing?.contractHash).toBe('sha256:order-processing-hash');
  });

  function orderProcessingRow() {
    const rows = registryWorkflowRows(SNAPSHOT);
    const row = rows.find((entry) => entry.type === 'order-processing');
    if (!row) throw new Error('fixture invariant: order-processing row must exist');
    return row;
  }

  test('surfaces signal contracts, schema-treed', () => {
    expect(orderProcessingRow().signals).toEqual([
      {
        name: 'cancel',
        hasInputSchema: true,
        inputFields: [{ name: 'reason', type: 'unknown', required: false, description: undefined }],
        inputSchemaTree: [
          {
            id: 'order-processing.signals.cancel.input.reason',
            name: 'reason',
            type: 'unknown',
            required: false,
            description: undefined,
            children: [],
          },
        ],
        inputSchemaRootType: 'object',
        hasOutputSchema: false,
        outputFields: [],
        outputSchemaTree: [],
        outputSchemaRootType: undefined,
      },
    ]);
  });

  test('surfaces update contracts, both input and output schema-treed', () => {
    expect(orderProcessingRow().updates).toEqual([
      {
        name: 'expedite',
        hasInputSchema: true,
        inputFields: [{ name: 'rush', type: 'boolean', required: false, description: undefined }],
        inputSchemaTree: [
          {
            id: 'order-processing.updates.expedite.input.rush',
            name: 'rush',
            type: 'boolean',
            required: false,
            description: undefined,
            children: [],
          },
        ],
        inputSchemaRootType: 'object',
        hasOutputSchema: true,
        outputFields: [{ name: 'ok', type: 'boolean', required: false, description: undefined }],
        outputSchemaTree: [
          {
            id: 'order-processing.updates.expedite.output.ok',
            name: 'ok',
            type: 'boolean',
            required: false,
            description: undefined,
            children: [],
          },
        ],
        outputSchemaRootType: 'object',
      },
    ]);
  });

  test('a root schema that is not `type: object` (e.g. a bare string schema) surfaces its root type even though the tree is empty', () => {
    const withRootStringSchema: RegistrySnapshotSource = {
      ...SNAPSHOT,
      workflows: SNAPSHOT.workflows.map((manifest) =>
        manifest.name === 'order-processing'
          ? {
              ...manifest,
              contract: {
                ...manifest.contract,
                queries: {
                  ping: { outputSchema: { type: 'string' } },
                },
              },
            }
          : manifest,
      ),
    };
    const rows = registryWorkflowRows(withRootStringSchema);
    const ping = rows.find((row) => row.type === 'order-processing')?.queries[0];
    expect(ping).toMatchObject({
      name: 'ping',
      hasOutputSchema: true,
      outputSchemaTree: [],
      outputSchemaRootType: 'string',
    });
  });

  test('surfaces query contracts', () => {
    const queries = orderProcessingRow().queries;
    expect(queries.map((entry) => entry.name)).toEqual(['status']);
    expect(queries[0]).toMatchObject({ hasOutputSchema: true });
  });

  test('surfaces activity contracts', () => {
    const activities = orderProcessingRow().activities;
    expect(activities.map((entry) => entry.name)).toEqual(['chargeCard']);
    expect(activities[0]).toMatchObject({ hasInputSchema: true });
  });

  test('surfaces the finalizer contract', () => {
    const finalizer = orderProcessingRow().finalizer;
    expect(finalizer).toMatchObject({ name: 'finalizer', hasInputSchema: true });
  });

  test('a manifest with no signals/updates/queries/activities/finalizer surfaces empty arrays and an undefined finalizer, never fabricated', () => {
    const rows = registryWorkflowRows(SNAPSHOT);
    const auditSweep = rows.find((row) => row.type === 'audit-sweep');
    expect(auditSweep?.signals).toEqual([]);
    expect(auditSweep?.updates).toEqual([]);
    expect(auditSweep?.queries).toEqual([]);
    expect(auditSweep?.activities).toEqual([]);
    expect(auditSweep?.finalizer).toBeUndefined();
  });

  test('excludes a manifest whose revision is not the active one', () => {
    const withInactiveRevision: RegistrySnapshotSource = {
      ...SNAPSHOT,
      workflows: [
        ...SNAPSHOT.workflows,
        {
          manifestVersion: 1,
          name: 'audit-sweep',
          workflowVersion: '0.9.0',
          revision: 'sha256:audit-sweep-old-revision',
          contractHash: 'sha256:audit-sweep-old-hash',
          contract: { name: 'audit-sweep', workflowVersion: '0.9.0', description: 'Old.' },
        },
      ],
    };
    const rows = registryWorkflowRows(withInactiveRevision);
    expect(rows.map((row) => row.type)).toEqual(['audit-sweep', 'order-processing']);
    expect(rows[0]?.description).toBeUndefined();
  });
});

describe('registryActivityRows', () => {
  test('sorts by name', () => {
    const rows = registryActivityRows(SNAPSHOT);
    expect(rows.map((row) => row.name)).toEqual(['chargeCard', 'reserveInventory']);
    expect(rows[1]?.hasInputSchema).toBe(true);
  });

  test('surfaces retry/timeout when the wire snapshot supplies them', () => {
    const rows = registryActivityRows(SNAPSHOT);
    const reserveInventory = rows.find((row) => row.name === 'reserveInventory');
    expect(reserveInventory?.retry).toEqual({
      maxAttempts: 3,
      initialBackoff: '200ms',
      backoffMultiplier: 2,
      maxBackoff: '2s',
    });
    expect(reserveInventory?.timeout).toBe('30s');
  });

  test('omits retry/timeout — never fabricated — when the wire snapshot has none', () => {
    const rows = registryActivityRows(SNAPSHOT);
    const chargeCard = rows.find((row) => row.name === 'chargeCard');
    expect(chargeCard?.retry).toBeUndefined();
    expect(chargeCard?.timeout).toBeUndefined();
  });
});

describe('buildSchemaTree', () => {
  test('returns [] for an undefined schema', () => {
    expect(buildSchemaTree(undefined)).toEqual([]);
  });

  test('leaf properties have no children', () => {
    const tree = buildSchemaTree({
      type: 'object',
      required: ['orderId'],
      properties: { orderId: { type: 'string' } },
    });
    expect(tree).toEqual([
      {
        id: 'field.orderId',
        name: 'orderId',
        type: 'string',
        required: true,
        description: undefined,
        children: [],
      },
    ]);
  });

  test('nested object properties expand into children with prefixed, stable ids', () => {
    const tree = buildSchemaTree({
      type: 'object',
      properties: {
        customer: {
          type: 'object',
          properties: {
            email: { type: 'string' },
            id: { type: 'string' },
          },
        },
      },
    });

    expect(tree).toEqual([
      {
        id: 'field.customer',
        name: 'customer',
        type: 'object',
        required: false,
        description: undefined,
        children: [
          {
            id: 'field.customer.email',
            name: 'email',
            type: 'string',
            required: false,
            description: undefined,
            children: [],
          },
          {
            id: 'field.customer.id',
            name: 'id',
            type: 'string',
            required: false,
            description: undefined,
            children: [],
          },
        ],
      },
    ]);
  });

  test('an array-of-strings property is a leaf, not expanded', () => {
    const tree = buildSchemaTree({
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
    });
    expect(tree[0]?.children).toEqual([]);
  });
});

describe('isRegistryEmpty', () => {
  test('true when both the workflow array and activities map are empty', () => {
    expect(
      isRegistryEmpty({ registryVersion: 2, workflows: [], activeRevisions: {}, activities: {} }),
    ).toBe(true);
  });

  test('false when at least one workflow or activity exists', () => {
    expect(isRegistryEmpty(SNAPSHOT)).toBe(false);
    expect(
      isRegistryEmpty({
        registryVersion: 2,
        workflows: [],
        activeRevisions: {},
        activities: SNAPSHOT.activities,
      }),
    ).toBe(false);
  });
});
