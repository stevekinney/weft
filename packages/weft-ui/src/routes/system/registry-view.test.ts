import { describe, expect, test } from 'bun:test';

import {
  buildSchemaTree,
  extractSchemaFields,
  isRegistryEmpty,
  registryActivityRows,
  registryWorkflowRows,
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
  registryVersion: 1,
  workflows: {
    'order-processing': {
      description: 'Processes an order end to end.',
      tags: ['commerce'],
      inputSchema: {
        type: 'object',
        required: ['orderId'],
        properties: { orderId: { type: 'string' } },
      },
    },
    'audit-sweep': {},
  },
  activities: {
    chargeCard: { queue: 'default', description: 'Charges a card.' },
    reserveInventory: {
      queue: 'inventory',
      inputSchema: {
        type: 'object',
        properties: { orderId: { type: 'string' } },
      },
    },
  },
};

describe('registryWorkflowRows', () => {
  test('sorts by type (codepoint order) and maps schema presence', () => {
    const rows = registryWorkflowRows(SNAPSHOT);
    expect(rows.map((row) => row.type)).toEqual(['audit-sweep', 'order-processing']);

    const orderProcessing = rows[1];
    expect(orderProcessing?.hasInputSchema).toBe(true);
    expect(orderProcessing?.inputFields).toEqual([
      { name: 'orderId', type: 'string', required: true, description: undefined },
    ]);
    expect(orderProcessing?.hasOutputSchema).toBe(false);
    expect(orderProcessing?.handlers).toBeUndefined();

    const auditSweep = rows[0];
    expect(auditSweep?.hasInputSchema).toBe(false);
    expect(auditSweep?.tags).toEqual([]);
  });
});

describe('registryActivityRows', () => {
  test('sorts by name and never fabricates retry/timeout', () => {
    const rows = registryActivityRows(SNAPSHOT);
    expect(rows.map((row) => row.name)).toEqual(['chargeCard', 'reserveInventory']);
    expect(rows.every((row) => row.retry === undefined && row.timeout === undefined)).toBe(true);
    expect(rows[1]?.hasInputSchema).toBe(true);
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
  test('true when both maps are empty', () => {
    expect(isRegistryEmpty({ registryVersion: 1, workflows: {}, activities: {} })).toBe(true);
  });

  test('false when at least one workflow or activity exists', () => {
    expect(isRegistryEmpty(SNAPSHOT)).toBe(false);
    expect(
      isRegistryEmpty({ registryVersion: 1, workflows: {}, activities: SNAPSHOT.activities }),
    ).toBe(false);
  });
});
