import {
  createSingleWorkflowTagMutationOperation,
  createSingleWorkflowTagMutationRestBinding,
  type SingleWorkflowTagMutationInput,
  type SingleWorkflowTagMutationOutput,
} from './single-workflow-tag-mutation.ts';

export type AddWorkflowTagsInput = SingleWorkflowTagMutationInput;
export type AddWorkflowTagsOutput = SingleWorkflowTagMutationOutput;

export const addWorkflowTagsOperation = createSingleWorkflowTagMutationOperation({
  name: 'weft.workflows.tags.add',
  summary: 'Add workflow tags',
  mutateTags: (engine, workflowId, tags) => engine.addTags(workflowId, ...tags),
});

export const addWorkflowTagsRestBinding = createSingleWorkflowTagMutationRestBinding({
  method: 'POST',
  operationName: addWorkflowTagsOperation.name,
});
