<script lang="ts">
  /**
   * Registry → workflow definition detail (plan §9.7 T7.2; design `Weft
   * Console.dc.html` "System" § REGISTRY DEFINITION DETAIL). Renders the
   * expandable input/output schema `Tree` plus everything the wire snapshot
   * actually carries — see `registry-view.ts`'s module doc for the
   * signal/update/query-handler and activity-retry gap this panel is
   * honest about instead of fabricating.
   */
  import DescriptionList from '@lostgradient/cinder/description-list';
  import { Tree } from '@lostgradient/cinder/tree';
  import Badge from '@lostgradient/cinder/badge';
  import Button from '@lostgradient/cinder/button';
  import { ArrowLeft, FileQuestion } from 'lucide-svelte';

  import type { RegistryWorkflowRow, SchemaTreeNode } from './registry-view.ts';

  interface Props {
    row: RegistryWorkflowRow;
    onBack: () => void;
  }

  let { row, onBack }: Props = $props();
</script>

{#snippet schemaBadge(
  label: string,
  variant: 'neutral' | 'warning',
  monospace = false,
  className = '',
)}
  <Badge class={className} {variant} {monospace}>{label}</Badge>
{/snippet}

{#snippet schemaNode(node: SchemaTreeNode)}
  <Tree.Item id={node.id} label={node.name} branch={node.children.length > 0}>
    {#snippet row(context)}
      <span class="weft-schema-node" data-expanded={context.expanded}>
        <span class="weft-schema-node__name">{node.name}</span>
        {@render schemaBadge(node.type, 'neutral', true)}
        {@render schemaBadge(
          node.required ? 'required' : 'optional',
          node.required ? 'warning' : 'neutral',
          false,
          'weft-schema-node__requirement',
        )}
      </span>
    {/snippet}
    {#each node.children as child (child.id)}
      {@render schemaNode(child)}
    {/each}
  </Tree.Item>
{/snippet}

{#snippet schemaTree(schema: readonly SchemaTreeNode[], emptyLabel: string)}
  {#if schema.length === 0}
    <div class="weft-registry-detail__no-schema">
      <FileQuestion aria-hidden="true" size={17} />
      <span>{emptyLabel}</span>
    </div>
  {:else}
    <Tree aria-label="Schema fields">
      {#each schema as node (node.id)}
        {@render schemaNode(node)}
      {/each}
    </Tree>
  {/if}
{/snippet}

<div class="weft-registry-detail">
  <Button variant="secondary" size="sm" label="Workflow definitions" onclick={onBack}>
    {#snippet leadingIcon()}<ArrowLeft aria-hidden="true" size={14} />{/snippet}
  </Button>

  <div class="weft-registry-detail__header">
    <h2 class="weft-registry-detail__title">{row.type}</h2>
    {#each row.tags as tag (tag)}
      <Badge variant="neutral">{tag}</Badge>
    {/each}
  </div>
  {#if row.description}
    <p class="weft-registry-detail__description">{row.description}</p>
  {/if}

  <div class="weft-registry-detail__grid">
    <section class="weft-registry-detail__panel">
      <h3 class="weft-registry-detail__panel-title">
        Input schema
        <span class="weft-registry-detail__panel-meta">{row.inputFields.length} fields</span>
      </h3>
      {@render schemaTree(
        row.inputSchemaTree,
        'No input schema declared — this definition accepts an untyped payload.',
      )}
    </section>

    <section class="weft-registry-detail__panel">
      <h3 class="weft-registry-detail__panel-title">Handlers</h3>
      <p class="weft-registry-detail__gap-note">
        Signal, update, and query handler names aren't exposed by the registry snapshot yet, even
        though the workflow builder registers them statically — filed upstream:
        <a href="https://github.com/stevekinney/weft/issues/736" target="_blank" rel="noreferrer">
          stevekinney/weft#736
        </a>.
      </p>
    </section>

    <section class="weft-registry-detail__panel">
      <h3 class="weft-registry-detail__panel-title">Details</h3>
      <DescriptionList
        items={[
          { term: 'Type', definition: row.type },
          { term: 'Tags', definition: row.tags.length > 0 ? row.tags.join(', ') : 'none' },
          {
            term: 'Output schema',
            definition: row.hasOutputSchema ? `${row.outputFields.length} fields` : 'none',
          },
        ]}
      />
    </section>
  </div>
</div>

<style>
  .weft-registry-detail {
    max-width: 1080px;
    display: flex;
    flex-direction: column;
    gap: 15px;
  }

  .weft-registry-detail__header {
    display: flex;
    align-items: center;
    gap: 9px;
    flex-wrap: wrap;
  }

  .weft-registry-detail__title {
    margin: 0;
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-lg);
    font-weight: 600;
  }

  .weft-registry-detail__description {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
    max-width: 640px;
    text-wrap: pretty;
  }

  .weft-registry-detail__grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 14px;
    align-items: start;
  }

  .weft-registry-detail__panel {
    background: var(--cinder-surface-raised);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-lg);
    padding: 14px 16px;
  }

  .weft-registry-detail__panel-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 0 0 10px;
    font-size: var(--cinder-text-sm);
    font-weight: 600;
  }

  .weft-registry-detail__panel-meta {
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-subtle);
    font-family: var(--cinder-font-mono);
    font-weight: 400;
  }

  .weft-registry-detail__no-schema {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--cinder-text-subtle);
    font-size: var(--cinder-text-sm);
  }

  .weft-registry-detail__gap-note {
    margin: 0;
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-subtle);
  }

  .weft-schema-node {
    display: flex;
    align-items: center;
    gap: 9px;
    flex-wrap: wrap;
    min-width: 0;
  }

  .weft-schema-node__name {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-sm);
    font-weight: 600;
  }

  :global(.weft-schema-node__requirement) {
    margin-left: auto;
  }
</style>
