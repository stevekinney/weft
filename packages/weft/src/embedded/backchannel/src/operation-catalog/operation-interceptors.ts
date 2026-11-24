import type { TransportKind } from '../operation-fault.ts';
import type { Principal } from '../principal.ts';
import type { DispatchResult, ErasedOperation, OperationContext } from './types.ts';

/** Resolves the operation host from an admitted caller and its transport. */
export type OperationHostFactory<Host> = (context: {
  readonly principal: Principal;
  readonly transport: TransportKind;
}) => Host | Promise<Host>;

/** Operation details available to interceptors after access checks and input validation. */
export type OperationInterceptorContext = Pick<
  OperationContext<unknown>,
  'input' | 'principal' | 'transport' | 'signal'
> & {
  readonly name: string;
  readonly metadata: Pick<ErasedOperation, 'kind' | 'summary' | 'tags' | 'destructive' | 'access'>;
};

/** Wrap invocation of an authorized operation. Successful results still undergo output validation. */
export type OperationInterceptor = (
  context: OperationInterceptorContext,
  next: () => Promise<DispatchResult<unknown>>,
) => Promise<DispatchResult<unknown>>;
