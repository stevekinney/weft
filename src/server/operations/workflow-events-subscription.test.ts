import { describe, expect, it } from 'bun:test';

import { anonymousPrincipal, principalFromApiKey } from '../principal.ts';
import { workflowEventsSubscriptionOperation } from './workflow-events-subscription.ts';

describe('weft.workflows.events authorization', () => {
  function authorizationContext(
    input: { workflowId: string; selector: 'events' | 'tokens' },
    principal: ReturnType<typeof anonymousPrincipal> | ReturnType<typeof principalFromApiKey>,
  ) {
    return {
      input,
      principal,
      engine: {},
      transport: 'jsonRpcWebSocket' as const,
    };
  }

  it('uses authenticated catalog access because selector scopes are parameter-specific', () => {
    expect(workflowEventsSubscriptionOperation.access).toEqual({ kind: 'authenticated' });
    expect(workflowEventsSubscriptionOperation.parameterizedAccess).toEqual({
      discriminator: 'selector',
      defaultValue: 'events',
      variants: [
        {
          value: 'events',
          access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['events:read'] } },
        },
        {
          value: 'tokens',
          access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['streams:read'] } },
        },
      ],
    });
  });

  it('rejects unauthenticated callers before checking selector scope', async () => {
    const result = await workflowEventsSubscriptionOperation.authorize!(
      authorizationContext({ workflowId: 'wf-auth', selector: 'events' }, anonymousPrincipal()),
    );

    expect(result).toMatchObject({
      allowed: false,
      classification: 'unauthorized',
      reason: 'authentication required',
    });
  });

  it('requires events:read for event subscriptions and streams:read for token subscriptions', async () => {
    const eventsPrincipal = principalFromApiKey({
      subject: 'events-reader',
      scopes: ['events:read'],
    });
    const streamsPrincipal = principalFromApiKey({
      subject: 'streams-reader',
      scopes: ['streams:read'],
    });

    await expect(
      workflowEventsSubscriptionOperation.authorize!(
        authorizationContext({ workflowId: 'wf-auth', selector: 'events' }, eventsPrincipal),
      ),
    ).resolves.toEqual({ allowed: true });
    await expect(
      workflowEventsSubscriptionOperation.authorize!(
        authorizationContext({ workflowId: 'wf-auth', selector: 'tokens' }, streamsPrincipal),
      ),
    ).resolves.toEqual({ allowed: true });
    const wrongScopeResult = await workflowEventsSubscriptionOperation.authorize!(
      authorizationContext({ workflowId: 'wf-auth', selector: 'tokens' }, eventsPrincipal),
    );
    expect(wrongScopeResult).toMatchObject({
      allowed: false,
      classification: 'forbidden',
      reason: 'requires scope: streams:read',
    });
    const inverseWrongScopeResult = await workflowEventsSubscriptionOperation.authorize!(
      authorizationContext({ workflowId: 'wf-auth', selector: 'events' }, streamsPrincipal),
    );
    expect(inverseWrongScopeResult).toMatchObject({
      allowed: false,
      classification: 'forbidden',
      reason: 'requires scope: events:read',
    });
  });
});
