import { describe, expect, it } from 'bun:test';

import { activity } from '../activity.ts';
import { validateWorkflowOrActivityName } from '../name-grammar.ts';

describe('validateWorkflowOrActivityName', () => {
  describe('accepts valid names', () => {
    const valid = [
      'welcome',
      'formatGreeting',
      'snake_case',
      '_leadingUnderscore',
      'kebab-case',
      'A',
      'mixed_Name-1',
      'Process123',
    ];
    for (const name of valid) {
      it(`accepts "${name}"`, () => {
        expect(() => validateWorkflowOrActivityName(name, 'workflow')).not.toThrow();
        expect(() => validateWorkflowOrActivityName(name, 'activity')).not.toThrow();
      });
    }
  });

  describe('rejects invalid names', () => {
    const invalid = [
      'bad.name',
      '1startsWithDigit',
      '',
      ' leadingSpace',
      'trailingSpace ',
      'has space',
      'with/slash',
      'with:colon',
      'with$dollar',
    ];
    for (const name of invalid) {
      it(`rejects "${name}"`, () => {
        expect(() => validateWorkflowOrActivityName(name, 'workflow')).toThrow();
      });
    }
  });

  it('includes the kind in the error message', () => {
    expect(() => validateWorkflowOrActivityName('bad.name', 'workflow')).toThrow(
      /workflow name "bad.name"/,
    );
    expect(() => validateWorkflowOrActivityName('bad.name', 'activity')).toThrow(
      /activity name "bad.name"/,
    );
  });

  it('includes rename guidance pointing at the current name pattern', () => {
    expect(() => validateWorkflowOrActivityName('payments.charge', 'workflow')).toThrow(
      /payments-charge|paymentsCharge/,
    );
  });

  it('mentions the dot rule explicitly', () => {
    expect(() => validateWorkflowOrActivityName('bad.name', 'activity')).toThrow(/'\.'/);
  });
});

describe('activity() runtime name validation', () => {
  it('rejects names containing a dot', () => {
    expect(() =>
      activity({
        name: 'bad.name',
        execute: async (i: unknown) => i,
      }),
    ).toThrow(/activity name "bad\.name"/);
  });

  it('rejects names starting with a digit', () => {
    expect(() =>
      activity({
        name: '1bad',
        execute: async (i: unknown) => i,
      }),
    ).toThrow(/activity name "1bad" is invalid/);
  });

  it('accepts valid names', () => {
    expect(() => activity({ name: 'goodName', execute: async (i: unknown) => i })).not.toThrow();
  });
});
