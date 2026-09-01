import {
  Engine,
  MemoryStorage,
  WorkflowHandle,
  workflow,
  type RegistryAgnosticEngine,
} from '@lostgradient/weft';

const packageRootWorkflow = workflow({ name: 'packageRootRegistryAgnostic' }).execute(
  async function* () {
    return 'done';
  },
);

async function verifyPackageRootRegistryAgnosticEngine(): Promise<void> {
  const defaultEngine = new Engine({ storage: new MemoryStorage() });
  const concreteEngine = await Engine.create({
    storage: new MemoryStorage(),
    workflows: { packageRootWorkflow },
  });

  const defaultRegistryAgnosticEngine: RegistryAgnosticEngine = defaultEngine;
  const concreteRegistryAgnosticEngine: RegistryAgnosticEngine = concreteEngine;

  void defaultRegistryAgnosticEngine.start;
  void concreteRegistryAgnosticEngine.startOrSignal;
  void new WorkflowHandle('package-root-workflow-id', concreteRegistryAgnosticEngine);

  // @ts-expect-error registration remains intentionally absent from the registry-agnostic surface.
  void concreteRegistryAgnosticEngine.register;
  // @ts-expect-error bulk registration remains intentionally absent from the registry-agnostic surface.
  void concreteRegistryAgnosticEngine.registerWorkflows;
}

void verifyPackageRootRegistryAgnosticEngine;
