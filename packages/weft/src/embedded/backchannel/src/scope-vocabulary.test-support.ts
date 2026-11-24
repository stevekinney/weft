import { createScopeVocabulary } from './authorization-scope.ts';

export const TEST_AUTHORIZATION_SCOPES = [
  'workflows:read',
  'workflows:write',
  'workflows:admin',
  'schedules:read',
  'schedules:write',
  'signals:write',
  'updates:write',
  'queries:read',
  'reviews:read',
  'reviews:write',
  'attributes:read',
  'attributes:write',
  'tags:write',
  'streams:read',
  'events:read',
  'storage:read',
  'storage:write',
  'storage:admin',
  'workers:write',
  'system:read',
  'system:admin',
] as const;

export const TEST_SCOPE_VOCABULARY = createScopeVocabulary(TEST_AUTHORIZATION_SCOPES);
