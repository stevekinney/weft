import { test as base, expect } from '@playwright/test';

export const test = base.extend<{ browserErrors: void }>({
  browserErrors: [
    async ({ page }, use) => {
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      const failedRequests: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('requestfailed', (request) => {
        failedRequests.push(
          `${request.method()} ${request.url()}: ${request.failure()?.errorText}`,
        );
      });

      await use();

      expect(pageErrors, `Unexpected page errors:\n${pageErrors.join('\n')}`).toEqual([]);
      expect(consoleErrors, `Unexpected console errors:\n${consoleErrors.join('\n')}`).toEqual([]);
      expect(failedRequests, `Unexpected failed requests:\n${failedRequests.join('\n')}`).toEqual(
        [],
      );
    },
    { auto: true },
  ],
});

export { expect };
