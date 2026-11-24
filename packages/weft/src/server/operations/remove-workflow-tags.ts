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
  description:
    'Detach tags from a workflow by `workflowId`. A tag the workflow does not carry is ignored. ' +
    'Faults with NotFound when the workflow is not visible and Unprocessable when `tags` is not ' +
    'an array of non-empty strings or exceeds the tag limit.',
  destructive: false,
  scope: 'tags:write',
  requiredEngineMethods: ['removeTags'],
  mutateTags: (engine, workflowId, tags) => engine.removeTags(workflowId, ...tags),
});

export const removeWorkflowTagsRestBinding = createSingleWorkflowTagMutationRestBinding({
  method: 'DELETE',
  operationName: removeWorkflowTagsOperation.name,
});
