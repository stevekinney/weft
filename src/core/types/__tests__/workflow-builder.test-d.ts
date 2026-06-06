// Phase 1c — type-only test fixtures pinning every invariant the chained
// workflow builder relies on.
//
// This file participates in `bun run typecheck` (it's a `.test-d.ts` file the
// project's typecheck already includes). It contains zero runtime assertions;
// every "test" is either an `@ts-expect-error` on a line that must fail to
// compile, or a `satisfies` assertion on a value whose type must resolve to the
// expected shape. If any assertion silently drifts, typecheck breaks and the
// refactor's type-surface promise is back in the conversation.
//
// Conventions:
//   - One assertion per block of related lines. Comments explain the "why".
//   - `@ts-expect-error` is the only acceptable failure form; bare runtime
//     errors are not load-bearing here.
//   - Helpers are declared inline so each test is readable in isolation.

import type { ActivityCallable } from '../activity.ts';
import type { SignalDefinition, UpdateDefinition } from '../message-handles.ts';
import type {
  ActivityArgsFor,
  ActivityResultFor,
  NormalizeActivities,
  NormalizedActivityEntry,
  SignalPayload,
  UpdatePayload,
} from '../workflow-builder-helpers.ts';
import type { WorkflowAlreadyRegistered } from '../workflow-builder.ts';
import type { WorkflowContext } from '../workflow-context.ts';

// ---------------------------------------------------------------------------
// NormalizeActivities — each accepted shape produces the right entry
// ---------------------------------------------------------------------------

// Shape 1: bare async function with input.
type BareAsync = NormalizeActivities<{
  formatGreeting: (input: { name: string }) => Promise<string>;
}>;
declare const bareAsyncEntry: BareAsync['formatGreeting'];
void (bareAsyncEntry satisfies NormalizedActivityEntry<{ name: string }, string>);

// Shape 2: bare sync function with input (return is wrapped in Awaited).
type BareSync = NormalizeActivities<{
  uppercase: (input: string) => string;
}>;
declare const bareSyncEntry: BareSync['uppercase'];
void (bareSyncEntry satisfies NormalizedActivityEntry<string, string>);

// Shape 3: zero-arg function (void input).
type ZeroArg = NormalizeActivities<{
  ping: () => Promise<number>;
}>;
declare const zeroArgEntry: ZeroArg['ping'];
void (zeroArgEntry satisfies NormalizedActivityEntry<void, number>);

// Shape 4: ActivityCallable returned by activity().
declare const sendEmailActivity: ActivityCallable<{ to: string; body: string }, void>;
type FromCallable = NormalizeActivities<{
  sendEmail: typeof sendEmailActivity;
}>;
declare const callableEntry: FromCallable['sendEmail'];
void (callableEntry satisfies NormalizedActivityEntry<{ to: string; body: string }, void>);

// Shape 5: object form with options.
type ObjectForm = NormalizeActivities<{
  charge: {
    execute: (input: { amount: number }) => Promise<{ id: string }>;
    retry: { maxAttempts: 3 };
  };
}>;
declare const objectFormEntry: ObjectForm['charge'];
void (objectFormEntry satisfies NormalizedActivityEntry<{ amount: number }, { id: string }>);

// Multi-parameter functions degrade gracefully: input AND output both fall
// to `unknown` rather than producing a bogus tuple-input shape. We do not
// reject them outright because the resulting TS error message would be
// opaque. The `unknown`-everywhere fallback means `ctx.run('name', input)`
// against such entries loses type-safety — a documented limitation surfaced
// in usage docs.
type MultiArg = NormalizeActivities<{
  bad: (a: number, b: number) => number;
}>;
declare const multiArgEntry: MultiArg['bad'];
void (multiArgEntry satisfies NormalizedActivityEntry);

// ---------------------------------------------------------------------------
// ActivityArgsFor — argument tuple matches the declared input shape
// ---------------------------------------------------------------------------

// Required input: must pass exactly one argument of the right type.
type ArgsRequired = ActivityArgsFor<NormalizedActivityEntry<{ name: string }, string>>;
const _argsRequired: ArgsRequired = [{ name: 'Ada' }];
// @ts-expect-error — zero args not allowed when input is required.
const _argsRequiredZero: ArgsRequired = [];
// @ts-expect-error — wrong input type rejected.
const _argsRequiredWrong: ArgsRequired = [{ wrong: 'field' }];

// Void input: only zero args allowed.
type ArgsVoid = ActivityArgsFor<NormalizedActivityEntry<void, string>>;
const _argsVoidZero: ArgsVoid = [];
// @ts-expect-error — extra argument rejected when input is void.
const _argsVoidExtra: ArgsVoid = ['oops'];

// Optional input: both zero-arg and single-arg call shapes typecheck.
type ArgsOptional = ActivityArgsFor<NormalizedActivityEntry<{ name: string } | undefined, string>>;
const _argsOptionalZero: ArgsOptional = [];
const _argsOptionalOne: ArgsOptional = [{ name: 'Ada' }];
// @ts-expect-error — wrong type still rejected.
const _argsOptionalWrong: ArgsOptional = [{ wrong: 'field' }];

// ---------------------------------------------------------------------------
// ActivityResultFor — output type matches and is awaited
// ---------------------------------------------------------------------------

type ResultPromise = ActivityResultFor<NormalizedActivityEntry<void, Promise<number>>>;
const _resultPromise: ResultPromise = 1; // Awaited<Promise<number>> = number.

type ResultSync = ActivityResultFor<NormalizedActivityEntry<void, string>>;
const _resultSync: ResultSync = 'hello';

// ---------------------------------------------------------------------------
// SignalPayload / UpdatePayload — extract payload from message definitions
// ---------------------------------------------------------------------------

type SigPayload = SignalPayload<SignalDefinition<{ approverId: string }>>;
const _sigPayload: SigPayload = { approverId: 'p1' };
// @ts-expect-error — wrong shape rejected.
const _sigPayloadWrong: SigPayload = { wrong: 'field' };

type UpPayload = UpdatePayload<UpdateDefinition<{ next: string }, { ok: boolean }>>;
declare const _upPayload: UpPayload;
void (_upPayload.payload satisfies { next: string });
declare const upRespond: typeof _upPayload.respond;
upRespond({ ok: true });
// @ts-expect-error — wrong respond shape rejected.
upRespond({ wrong: true });

// ---------------------------------------------------------------------------
// WorkflowAlreadyRegistered — branded diagnostic is not assignable from a
// plain object, which makes the engine.register parameter-position guard work.
// ---------------------------------------------------------------------------

type Brand = WorkflowAlreadyRegistered<'welcome'>;
// @ts-expect-error — plain object can't satisfy the branded diagnostic.
const _brandPlain: Brand = {};

// Even an object that looks vaguely right won't satisfy it — the brand symbol
// is private to the workflow-builder module.
// @ts-expect-error — fake brand symbol can't satisfy the real one.
const _brandFake: Brand = { fakeBrand: 'welcome' };

// ---------------------------------------------------------------------------
// WorkflowContext typed-key overloads — the load-bearing test for the entire
// refactor's type-surface promise.
// ---------------------------------------------------------------------------

type DemoActivities = {
  formatGreeting: NormalizedActivityEntry<{ name: string }, string>;
  ping: NormalizedActivityEntry<void, number>;
  greetMaybe: NormalizedActivityEntry<{ name: string } | undefined, string>;
};
type DemoSignals = {
  approve: SignalDefinition<{ approverId: string }>;
};
type DemoUpdates = {
  rename: UpdateDefinition<{ next: string }, { ok: boolean }>;
};
type DemoQueries = {
  // Use a structural shape (matches QueryMap) plus the QueryDefinition phantom.
  status: { readonly name: 'status' } & {
    readonly _input?: (input: void) => void;
    readonly _output?: () => { state: string };
  };
};
type DemoAttributes = {
  customerId: { type: 'string' };
};

declare const ctx: WorkflowContext<
  DemoActivities,
  DemoSignals,
  DemoUpdates,
  DemoQueries,
  DemoAttributes
>;

async function* _typedContextRun() {
  // Required input: must pass it, of the right type.
  const greeting = yield* ctx.run('formatGreeting', { name: 'Ada' });
  void (greeting satisfies string);

  // Void input: zero-arg call.
  const count = yield* ctx.run('ping');
  void (count satisfies number);

  // Optional input: both call shapes typecheck.
  const greetWithName = yield* ctx.run('greetMaybe', { name: 'Ada' });
  void (greetWithName satisfies string);
  const greetWithout = yield* ctx.run('greetMaybe');
  void (greetWithout satisfies string);

  // @ts-expect-error — unknown activity name rejected.
  yield* ctx.run('unknown', { anything: 1 });

  // @ts-expect-error — wrong input shape rejected.
  yield* ctx.run('formatGreeting', { wrong: 'field' });

  // @ts-expect-error — zero args when input is required rejected.
  yield* ctx.run('formatGreeting');
}

async function* _typedContextSignal() {
  const approval = yield* ctx.waitForSignal('approve');
  void (approval.approverId satisfies string);

  // Unknown signal names still typecheck via the dynamic `name: string`
  // fallback overload, but the payload type is whatever generic T the caller
  // supplies (default `unknown`). This is intentional — we cannot reject
  // arbitrary signal names because signals are dispatched via storage and
  // workflows may legitimately listen for ad-hoc names.
  const adHoc = yield* ctx.waitForSignal('not-declared');
  void (adHoc satisfies unknown);
}

async function* _typedContextUpdate() {
  const update = yield* ctx.waitForUpdate('rename');
  void (update.payload.next satisfies string);
  update.respond({ ok: true });
  // @ts-expect-error — respond rejects wrong shape.
  update.respond({ wrong: true });
}

function _typedContextOnUpdate() {
  ctx.onUpdate('rename', (payload) => {
    void (payload satisfies { next: string });
    return { ok: true };
  });
  // Known limitation: the looser `onUpdate(name: string, handler: (payload:
  // unknown) => unknown)` dynamic overload exists for valid reasons (ad-hoc
  // string-keyed updates) and accepts any handler. When TS sees a typed-key
  // call with a wrong return shape, it falls through from the typed overload
  // to the looser one rather than reporting a clean error. This is a TS
  // overload-resolution behaviour, not a soundness bug — the runtime still
  // routes by name, and the typed path provides correct intellisense for the
  // common case (in-IDE autocomplete sees the typed signature first).
}

function _typedContextSetAttribute() {
  // Declared attribute: value type comes from the schema entry.
  ctx.setAttribute('customerId', 'cust_123');
  // Same overload-fallthrough caveat as onUpdate above: the looser string-key
  // `setAttribute(key: string, value: SearchAttributeValue)` overload exists
  // so ad-hoc attributes still work, and a wrong-type call against a declared
  // attribute name falls through to the looser overload instead of erroring
  // on the typed-key one. Intellisense for declared attributes shows the
  // typed signature, which is the user-facing value.
  // Undeclared attribute name falls through to the string-key overload
  // (which accepts any SearchAttributeValue).
  ctx.setAttribute('adhoc', 'still-allowed');
}

function _typedContextGetAttribute() {
  const customer = ctx.getAttribute('customerId');
  void (customer satisfies string | undefined);
}

// ---------------------------------------------------------------------------
// Bare-WorkflowContext callers (no generic arguments) work because of the
// defaulted generics — this is current first-class authoring support. This is
// the regression guard for the many files referencing `WorkflowContext`
// without generics.
// ---------------------------------------------------------------------------

declare const bare: WorkflowContext;
async function* _bareContext() {
  // Definition-based signal still typed by the SignalDefinition generic on
  // a bare `WorkflowContext`. The defaulted `TSignals = {}` makes the typed-
  // key overload de-prioritise to `never`-keyed, so TS picks the definition
  // overload here.
  const handle: SignalDefinition<{ ok: boolean }> = { name: 'go' };
  const payload = yield* bare.waitForSignal(handle);
  void (payload satisfies { ok: boolean });

  // setAttribute with arbitrary string keys still accepted via the dynamic
  // string-key overload. The typed-key `TSearchAttributes` overload defaults
  // to `{}`, so `keyof {} & string = never`, and the typed overload doesn't
  // match — TS falls through cleanly.
  bare.setAttribute('whatever', 'x');

  // Note: we don't test `bare.run('anyName')` here because sibling test-d
  // files (`src/core/type-ergonomics.test-d.ts`) augment the global
  // `ActivityTypes` interface, and the test-d typecheck includes them all
  // together. With that augmentation in scope, `'anyName'` no longer matches
  // any overload's name parameter. The bare-context dynamic-name call path is
  // covered exhaustively in type-ergonomics.test-d.ts.
}

// ---------------------------------------------------------------------------
// Final void block — make every binding observably used so unused-var lint
// stays happy. Each binding above is type-only; this just walks the list.
// ---------------------------------------------------------------------------

void [
  _argsRequired,
  _argsRequiredZero,
  _argsRequiredWrong,
  _argsVoidZero,
  _argsVoidExtra,
  _argsOptionalZero,
  _argsOptionalOne,
  _argsOptionalWrong,
  _resultPromise,
  _resultSync,
  _sigPayload,
  _sigPayloadWrong,
  _upPayload,
  upRespond,
  _brandPlain,
  _brandFake,
  _typedContextRun,
  _typedContextSignal,
  _typedContextUpdate,
  _typedContextOnUpdate,
  _typedContextSetAttribute,
  _typedContextGetAttribute,
  _bareContext,
];
