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
  description:
    'Attach tags to a workflow by `workflowId`. Tags already on the workflow are kept, so the ' +
    'call is safe to repeat. Faults with NotFound when the workflow is not visible and ' +
    'Unprocessable when `tags` is not an array of non-empty strings or exceeds the tag limit.',
  destructive: false,
  scope: 'tags:write',
  requiredEngineMethods: ['addTags'],
  mutateTags: (engine, workflowId, tags) => engine.addTags(workflowId, ...tags),
});

export const addWorkflowTagsRestBinding = createSingleWorkflowTagMutationRestBinding({
  method: 'POST',
  operationName: addWorkflowTagsOperation.name,
});
