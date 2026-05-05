import {
  copyActivityMetadata,
  type ActivityMetadata,
  type ActivityRegistry,
} from '../../core/activity-registry.ts';

/**
 * Catalog-shaped activity metadata for discovery and code generation.
 *
 * Activities are dispatchable units, not standalone user-facing operations.
 * This adapter intentionally returns metadata only; it does not produce
 * executable `OperationDefinition` values.
 */
export type CatalogActivityDefinition = ActivityMetadata;

export function catalogActivity(metadata: ActivityMetadata): CatalogActivityDefinition {
  return copyActivityMetadata(metadata);
}

export function catalogActivities(registry: ActivityRegistry): CatalogActivityDefinition[] {
  return registry.listDefinitions();
}
