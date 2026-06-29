/**
 * The single HTTP layer behind every Orval-generated client (the MCP server's
 * tool clients and the library's typed fetch clients both call it).
 *
 * Orval's generated clients call `<api>Mutator(url, options)` per operation: `url`
 * is a host-less path with the query already attached and `options.body`/
 * `Content-Type` already set. A mutator picks the runtime host for its API,
 * attaches the API's auth, `fetch`es, and returns `{ status, data, headers }` (the shape
 * the generated code reads). This is the only bespoke HTTP code in the project -
 * it carries what the former hand-written `AlpacaClient` did. Host + auth come
 * from {@link API_ROUTING}.
 *
 * Credentials + target environment are resolved per call by {@link currentCreds}:
 * in remote (HTTP) mode they come from the request-scoped {@link reqCtx} store; in
 * stdio mode the store is empty and they come from the process environment.
 */

import { API_ROUTING } from './api-routing';
import { reqCtx } from './request-context';

const ENV_URL: Record<string, string> = {
  trading: 'ALPACA_TRADING_URL',
  data: 'ALPACA_DATA_URL',
  broker: 'ALPACA_BROKER_URL',
  authx: 'ALPACA_AUTHX_URL',
};

/** The credentials + target environment in effect for a single outgoing request. */
type ResolvedCreds = { key: string; secret: string; bearer?: string; paper: boolean };

/**
 * True only when explicitly opting into paper/sandbox hosts via `ALPACA_ENV=paper`
 * (or the legacy `ALPACA_PAPER=true`). Default is **live** - provide live API keys,
 * which differ from paper keys.
 */
function isPaperEnv(): boolean {
  const env = (process.env.ALPACA_ENV ?? (process.env.ALPACA_PAPER === 'true' ? 'paper' : 'live')).toLowerCase();
  return env === 'paper';
}

/**
 * Resolves the credentials for the current request. In remote (HTTP) mode the
 * transport populates {@link reqCtx} per request and that wins - there is **no env
 * fallback**, so a credential-less request can never borrow the server's own keys
 * (a credential-less request is rejected at the transport before it reaches here).
 * In stdio mode the store is empty and we read the process environment.
 */
function currentCreds(): ResolvedCreds {
  const c = reqCtx.getStore();
  if (c) {
    const paper = c.env === 'paper';
    // OAuth bearer (header-less hosts) vs. APCA key/secret pass-through.
    if ('token' in c) return { key: '', secret: '', bearer: c.token, paper };
    return { key: c.key, secret: c.secret, paper };
  }
  return {
    key: process.env.ALPACA_API_KEY ?? '',
    secret: process.env.ALPACA_API_SECRET ?? '',
    paper: isPaperEnv(),
  };
}

/** Resolves the base host for one API: env override, else the routing table (data is env-independent). */
function resolveHost(api: string, creds: ResolvedCreds): string {
  const override = process.env[ENV_URL[api] ?? ''];
  if (override) return override;
  const routing = API_ROUTING[api];
  if (!routing) throw new Error(`Unknown API: ${api}`);
  const { servers } = routing;
  if (api === 'data') return servers.live;
  return creds.paper ? (servers.paper ?? servers.sandbox ?? servers.live) : servers.live;
}

/** Adds the API's auth to the outgoing headers (the generated client supplies body + Content-Type). */
function authHeaders(api: string, creds: ResolvedCreds): Record<string, string> {
  const { key, secret, bearer } = creds;
  switch (API_ROUTING[api]?.auth) {
    case 'basic':
      return { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}` };
    case 'form':
      // AuthX is form-encoded with credentials carried in the (caller-supplied) body.
      return {};
    default:
      // apca APIs (trading, data): an Alpaca OAuth2 bearer authenticates via
      // `Authorization: Bearer`; otherwise the caller's key/secret go in the APCA headers.
      return bearer
        ? { Authorization: `Bearer ${bearer}` }
        : { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret };
  }
}

/** Builds the mutator bound to one API. Generated clients import the four exports below. */
export function makeMutator(api: string) {
  return async <T>(url: string, options?: RequestInit): Promise<T> => {
    const creds = currentCreds();
    const headers = { ...((options?.headers as Record<string, string>) ?? {}), ...authHeaders(api, creds) };
    const response = await fetch(`${resolveHost(api, creds)}${url}`, { ...options, headers });
    const text = await response.text();
    let data: any = text;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        /* leave as raw text */
      }
    }
    // Generated clients/handlers branch on `.status` and read `.data`; the response
    // contracts also declare a `headers: Headers` field, so we pass the real headers
    // through (rate-limit info etc.) rather than leave that typed field undefined.
    const result: any = { status: response.status, data: text ? data : undefined, headers: response.headers };
    return result;
  };
}

export const tradingMutator = makeMutator('trading');
export const dataMutator = makeMutator('data');
export const brokerMutator = makeMutator('broker');
export const authxMutator = makeMutator('authx');
