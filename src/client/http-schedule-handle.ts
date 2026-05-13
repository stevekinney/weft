import { ScheduleHandleDelegation } from './handle-delegation.ts';
import type { HttpClient } from './http-client.ts';

export class HttpScheduleHandle extends ScheduleHandleDelegation<HttpClient> {
  [Symbol.dispose](): void {
    // HTTP schedule handles do not hold long-lived resources.
  }
}
