import { bindingPathMatches } from '../rest-binding.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

/**
 * Find a REST binding that matches the request's method and path.
 * Returns null if no binding matches. Delegates path resolution to the
 * canonical `bindingPathMatches` helper, keeping segment and parameter
 * matching consistent across dispatch and documentation.
 */
export function matchRestBinding(
  method: string,
  pathname: string,
  bindings: ReadonlyArray<UnknownRestBinding> | undefined,
): { readonly binding: UnknownRestBinding; readonly pathParams: Record<string, string> } | null {
  if (bindings === undefined) return null;
  for (const binding of bindings) {
    if (binding.method !== method) continue;
    const params = bindingPathMatches(binding.path, pathname);
    if (params !== null) return { binding, pathParams: params };
  }
  return null;
}
