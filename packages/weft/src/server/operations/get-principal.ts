import { createGetPrincipalOperation } from "../../embedded/backchannel/src/index.ts";

import { WEFT_SCOPE_VOCABULARY } from '../../authorization-scopes.ts';

/** The principal operation for Weft's authorization vocabulary. */
export const getPrincipalOperation = createGetPrincipalOperation(WEFT_SCOPE_VOCABULARY);
