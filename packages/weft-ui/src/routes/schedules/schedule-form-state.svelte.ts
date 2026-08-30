/**
 * Create/Edit schedule form state (Track B, plan §9.3; design
 * `Weft New Surfaces.dc.html` §A2 "Create-schedule slide-over" — layout is
 * binding, see `overlap-policy.ts`'s doc for why its consequence COPY isn't).
 * A plain rune-backed class (`.svelte.ts`, no component coupling) so
 * validation and payload-building are unit-testable without a DOM, matching
 * `src/app/notifications.svelte.ts`'s / `src/lib/scopes.svelte.ts`'s class
 * store pattern.
 */
import type { ScheduleValue } from '@lostgradient/cinder';

import type { ScheduleOverlapPolicy } from '@lostgradient/weft';

import { scheduleValueToWireSpec } from './cadence.ts';
import type { CreateScheduleArgs } from './schedule-queries.ts';

const MAX_SCHEDULE_ID_LENGTH = 128;
const MAX_C0_CONTROL_CODE_POINT = 31;
const DELETE_CODE_POINT = 127;

/** Mirrors `weft/src/core/workflow-identifiers.ts`'s `containsControlCharacter` (C0 controls + DEL) via code-point comparison, avoiding a literal control-character regex — schedule ids reuse the same workflow-id validator engine-side. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint <= MAX_C0_CONTROL_CODE_POINT || codePoint === DELETE_CODE_POINT) return true;
  }
  return false;
}

/** Mirrors `weft/src/core/workflow-identifiers.ts` `assertValidWorkflowId` (schedule ids reuse the same workflow-id validator engine-side). */
export function scheduleIdError(id: string): string | undefined {
  if (id.length === 0) return undefined; // empty is valid — means "auto-generate"
  if (id.length > MAX_SCHEDULE_ID_LENGTH) {
    return `Must be at most ${MAX_SCHEDULE_ID_LENGTH} characters.`;
  }
  if (hasControlCharacter(id)) return 'Must not contain control characters.';
  return undefined;
}

/** Mirrors weft's `Duration` string grammar (`weft/src/core/scheduler/duration.ts` `DURATION_PATTERN`) for inline jitter validation. */
const DURATION_PATTERN =
  /^(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?|d|days?)$/i;

export function jitterError(jitterText: string): string | undefined {
  if (jitterText.trim().length === 0) return undefined; // empty is valid — no jitter
  return DURATION_PATTERN.test(jitterText.trim())
    ? undefined
    : 'Use a duration like "30s", "5m", or "1h".';
}

export function inputJsonError(inputText: string): string | undefined {
  try {
    JSON.parse(inputText);
    return undefined;
  } catch {
    return 'Must be valid JSON.';
  }
}

export interface ScheduleFormFieldErrors {
  readonly workflowType?: string;
  readonly id?: string;
  readonly input?: string;
  readonly jitter?: string;
}

export interface ScheduleFormInit {
  readonly id?: string;
  readonly workflowType?: string;
  readonly inputText?: string;
  readonly cadence?: ScheduleValue;
  readonly overlap?: ScheduleOverlapPolicy;
  readonly jitterText?: string;
  readonly backfill?: boolean;
  readonly startPaused?: boolean;
}

const DEFAULT_CADENCE: ScheduleValue = { mode: 'interval', every: 15, unit: 'minutes' };

/**
 * Draft state for the create/edit schedule drawer. `id` is editable only in
 * create mode — the edit drawer's caller simply never re-renders it as an
 * input (a schedule's id is immutable once created).
 *
 * `cadence` is set exclusively via Cinder's `ScheduleBuilder` `onchange`,
 * which — per that component's own contract — only ever commits an already-
 * valid value (module doc), so this class does not re-validate it.
 */
export class ScheduleFormState {
  id = $state('');
  workflowType = $state('');
  inputText = $state('{}');
  cadence = $state<ScheduleValue>(DEFAULT_CADENCE);
  overlap = $state<ScheduleOverlapPolicy>('skip');
  jitterText = $state('');
  backfill = $state(false);
  startPaused = $state(false);

  constructor(init: ScheduleFormInit = {}) {
    this.id = init.id ?? this.id;
    this.workflowType = init.workflowType ?? this.workflowType;
    this.inputText = init.inputText ?? this.inputText;
    this.cadence = init.cadence ?? this.cadence;
    this.overlap = init.overlap ?? this.overlap;
    this.jitterText = init.jitterText ?? this.jitterText;
    this.backfill = init.backfill ?? this.backfill;
    this.startPaused = init.startPaused ?? this.startPaused;
  }

  get errors(): ScheduleFormFieldErrors {
    const idIssue = scheduleIdError(this.id);
    const inputIssue = inputJsonError(this.inputText);
    const jitterIssue = jitterError(this.jitterText);
    return {
      ...(this.workflowType.trim().length === 0 ? { workflowType: 'Choose a workflow type.' } : {}),
      ...(idIssue !== undefined ? { id: idIssue } : {}),
      ...(inputIssue !== undefined ? { input: inputIssue } : {}),
      ...(jitterIssue !== undefined ? { jitter: jitterIssue } : {}),
    };
  }

  get isValid(): boolean {
    return Object.keys(this.errors).length === 0;
  }

  /** Parses `inputText` as JSON, or `undefined` for an invalid draft — callers gate submission on `isValid` first, so this is a defensive fallback, not the primary validity signal. */
  get parsedInput(): unknown {
    try {
      return JSON.parse(this.inputText);
    } catch {
      return undefined;
    }
  }

  /** Builds the `createSchedule()` payload. Only valid when `isValid` is true — callers must check that first. */
  toCreateArgs(): CreateScheduleArgs {
    const trimmedId = this.id.trim();
    const trimmedJitter = this.jitterText.trim();
    return {
      workflowType: this.workflowType,
      input: this.parsedInput,
      spec: scheduleValueToWireSpec(this.cadence),
      overlap: this.overlap,
      backfill: this.backfill,
      ...(trimmedId.length > 0 ? { id: trimmedId } : {}),
      ...(trimmedJitter.length > 0 ? { jitter: trimmedJitter } : {}),
    };
  }
}
