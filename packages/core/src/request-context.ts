/**
 * Per-request credential context for remote (HTTP) deployments.
 *
 * In the default stdio deployment the {@link makeMutator | mutator} reads
 * credentials from the process environment - the OS process boundary is the trust
 * boundary, so one set of keys per process is correct. When the server is hosted
 * over HTTP it is multi-tenant: each request carries its own Alpaca credentials and
 * the server holds none of its own (possession of valid keys *is* the
 * authorization). This `AsyncLocalStorage` carries those request-scoped credentials
 * to the mutator without threading them through every generated handler/client
 * signature - the HTTP transport wraps each request in `reqCtx.run(creds, ...)` and
 * the mutator reads `reqCtx.getStore()`.
 *
 * @see ./mutator.ts - the single seam that consumes this.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** Selects the live or paper/sandbox host per API (live and paper keys differ). */
export type AlpacaEnv = 'paper' | 'live';

/**
 * The credential that authenticates a single proxied request to Alpaca - one of two
 * pass-through shapes, both carrying the target {@link AlpacaEnv}:
 *
 * - `{ key, secret }` - the caller's Alpaca API key/secret, sent as `APCA-API-KEY-ID`
 *   / `APCA-API-SECRET-KEY` (for clients that can set headers / local use).
 * - `{ token }` - an Alpaca **OAuth2** access token, sent as `Authorization: Bearer`
 *   (for header-less hosts like Claude Web that authenticate via OAuth).
 *
 * Either way the server holds no secrets of its own; the credential is the caller's.
 */
export type Creds =
  | { key: string; secret: string; env: AlpacaEnv }
  | { token: string; env: AlpacaEnv };

/**
 * The two operations callers need from the store: run a function with credentials
 * bound for its (async) duration, and read the credentials bound to the current
 * call. A deliberately narrow view of `AsyncLocalStorage` - it keeps the public API
 * minimal and keeps the `node:async_hooks` types out of the published declarations.
 */
export interface CredsStore {
  getStore(): Creds | undefined;
  run<R>(creds: Creds, fn: () => R): R;
}

/**
 * The per-request credential store. Empty in stdio mode (the mutator falls back to
 * the process environment); populated per request by the HTTP transport. A single
 * shared instance, so the transport and the mutator read and write the same store.
 */
export const reqCtx: CredsStore = new AsyncLocalStorage<Creds>();
