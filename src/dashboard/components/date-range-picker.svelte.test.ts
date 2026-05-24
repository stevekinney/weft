import { afterEach, describe, expect, it } from 'bun:test';

import {
  compileSvelteHarnessModule,
  createGeneratedArtifactTracker,
  installDashboardDom,
} from '../svelte-test-harness.test-support.ts';

type DateRangeHarnessModule = {
  flushSync: () => void;
  mountDateRangePicker: (target: Element) => unknown;
  rangeValues: () => { gte: number | undefined; lte: number | undefined };
  setRangeValues: (values: { gte?: number; lte?: number }) => void;
  unmountDateRangePicker: (component: unknown) => void | Promise<void>;
};

const COMPONENT_DIRECTORY = new URL('.', import.meta.url).pathname;
const tracker = createGeneratedArtifactTracker();
let flushSvelte = (): void => {};

afterEach(() => {
  tracker.cleanup();
});

async function loadDateRangeHarnessModule(): Promise<DateRangeHarnessModule> {
  const source = `
    import { flushSync, mount, unmount } from 'svelte';
    import DateRangePicker from './date-range-picker.svelte';

    let gte = $state<number | undefined>(undefined);
    let lte = $state<number | undefined>(undefined);

    export { flushSync };

    export function mountDateRangePicker(target: Element): unknown {
      return mount(DateRangePicker, {
        target,
        props: {
          id: 'created-at',
          label: 'Created At',
          get gte() {
            return gte;
          },
          set gte(value: number | undefined) {
            gte = value;
          },
          get lte() {
            return lte;
          },
          set lte(value: number | undefined) {
            lte = value;
          },
        },
      });
    }

    export function rangeValues(): { gte: number | undefined; lte: number | undefined } {
      return { gte, lte };
    }

    export function setRangeValues(values: { gte?: number; lte?: number }): void {
      gte = values.gte;
      lte = values.lte;
    }

    export function unmountDateRangePicker(component: unknown): void | Promise<void> {
      return unmount(component);
    }
  `;
  // The harness uses module-scope `$state` runes, so it must compile as a
  // `.svelte.ts` module via Svelte's compileModule, not as plain TypeScript.
  return (await compileSvelteHarnessModule({
    componentDirectory: COMPONENT_DIRECTORY,
    harnessBaseName: 'date-range-picker-harness',
    harnessExtension: '.svelte.ts',
    source,
    tracker,
  })) as DateRangeHarnessModule;
}

async function mountDateRangePicker(): Promise<{
  harnessModule: DateRangeHarnessModule;
  cleanup: () => Promise<void>;
}> {
  // The base global set already covers HTMLInputElement/SVGElement.
  const cleanupDom = installDashboardDom();
  try {
    const harnessModule = await loadDateRangeHarnessModule();
    flushSvelte = harnessModule.flushSync;
    const mounted = harnessModule.mountDateRangePicker(document.body);
    flushSvelte();
    await settle();

    return {
      harnessModule,
      cleanup: async () => {
        await harnessModule.unmountDateRangePicker(mounted);
        flushSvelte = (): void => {};
        cleanupDom();
      },
    };
  } catch (error) {
    flushSvelte = (): void => {};
    cleanupDom();
    throw error;
  }
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  flushSvelte();
}

function inputById(id: string): HTMLInputElement {
  const input = document.getElementById(id);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Expected input ${id}`);
  }
  return input;
}

async function changeInputValue(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
}

describe('DateRangePicker', () => {
  it('binds datetime-local inputs to millisecond gte and lte bounds', async () => {
    const { harnessModule, cleanup } = await mountDateRangePicker();
    try {
      const start = inputById('created-at-gte');
      const end = inputById('created-at-lte');

      expect(document.body.querySelector('legend')?.textContent).toBe('Created At');
      expect(start.getAttribute('aria-label')).toBe('Created At from');
      expect(end.getAttribute('aria-label')).toBe('Created At to');

      await changeInputValue(start, '2026-05-13T09:30');
      await changeInputValue(end, '2026-05-13T11:45');

      expect(harnessModule.rangeValues()).toEqual({
        gte: new Date('2026-05-13T09:30').getTime(),
        lte: new Date('2026-05-13T11:45').getTime(),
      });

      harnessModule.setRangeValues({ gte: new Date('2026-05-14T08:15').getTime() });
      await settle();

      expect(start.value).toBe('2026-05-14T08:15');
      expect(end.value).toBe('');

      await changeInputValue(start, '');

      expect(harnessModule.rangeValues()).toEqual({
        gte: undefined,
        lte: undefined,
      });
    } finally {
      await cleanup();
    }
  });
});
