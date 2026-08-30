import type {
  WorkflowServicesResolverInfo,
  WorkflowServicesResolverLaunchOptions,
  WorkflowServicesResolverScheduleInfo,
} from '@lostgradient/weft';

const launchOptions: WorkflowServicesResolverLaunchOptions = {
  id: 'workflow-1',
  tags: ['alpha'],
};

const schedule: WorkflowServicesResolverScheduleInfo = {
  id: 'schedule-1',
  occurrence: 1,
};

const resolverInfo: WorkflowServicesResolverInfo = {
  workflowId: 'workflow-1',
  workflowType: 'checkout',
  input: { customerId: 'customer-1' },
  launchOptions,
  schedule,
};

const workflowId: string = resolverInfo.workflowId;
const launchId: string | undefined = resolverInfo.launchOptions?.id;
const scheduleOccurrence: number | undefined = resolverInfo.schedule?.occurrence;

void workflowId;
void launchId;
void scheduleOccurrence;
void resolverInfo;

const invalidSchedule: WorkflowServicesResolverScheduleInfo = {
  id: 'schedule-2',
  // @ts-expect-error schedule occurrence must stay numeric.
  occurrence: 'not-a-timestamp',
};

void invalidSchedule;
