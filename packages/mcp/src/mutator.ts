/**
 * The MCP server's generated http-clients import `<api>Mutator` from this module
 * (Orval's `override.mutator`, resolved as the relative `../../mutator`).
 *
 * The HTTP logic lives in `@alpaca-open-api/core`'s {@link makeMutator} — shared
 * with the library's fetch clients. We bind one mutator per API here rather than
 * re-export, because Orval validates that this file *declares* each named export.
 */

import { makeMutator } from '@alpaca-open-api/core';

export const tradingMutator = makeMutator('trading');
export const dataMutator = makeMutator('data');
export const brokerMutator = makeMutator('broker');
export const authxMutator = makeMutator('authx');
