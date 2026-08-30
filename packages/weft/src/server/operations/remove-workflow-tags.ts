import {
  createSingleWorkflowTagMutationOperation,
  createSingleWorkflowTagMutationRestBinding,
  type SingleWorkflowTagMutationInput,
  type SingleWorkflowTagMutationOutput,
} from './single-workflow-tag-mutation.ts';

export type RemoveWorkflowTagsInput = SingleWorkflowTagMutationInput;
export type RemoveWorkflowTagsOutput = SingleWorkflowTagMutationOutput;

export const removeWorkflowTagsOperation = createSingleWorkflowTagMutationOperation({
  name: 'weft.workflows.tags.remove',
  summary: 'Remove workflow tags',
  destructive: false,
  mutateTags: (engine, workflowId, tags) => engine.removeTags(workflowId, ...tags),
});

export const removeWorkflowTagsRestBinding = createSingleWorkflowTagMutationRestBinding({
  method: 'DELETE',
  operationName: removeWorkflowTagsOperation.name,
});
