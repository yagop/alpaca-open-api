/**
 * The single HTTP layer behind every Orval-generated client (the MCP server's
 * tool clients and the library's typed fetch clients both call it).
 *
 * Orval's generated clients call `<api>Mutator(url, options)` per operation: `url`
 * is a host-less path with the query already attached and `options.body`/
 * `Content-Type` already set. A mutator picks the runtime host for its API,
 * attaches the API's auth, `fetch`es, and returns `{ status, data }` (the shape
 * the generated code reads). This is the only bespoke HTTP code in the project —
 * it carries what the former hand-written `AlpacaClient` did. Host + auth come
 * from {@link API_ROUTING}.
 */

import { API_ROUTING } from './api-routing';

const ENV_URL: Record<string, string> = {
  trading: 'ALPACA_TRADING_URL',
  data: 'ALPACA_DATA_URL',
  broker: 'ALPACA_BROKER_URL',
  authx: 'ALPACA_AUTHX_URL',
};

/**
 * True only when explicitly opting into paper/sandbox hosts via `ALPACA_ENV=paper`
 * (or the legacy `ALPACA_PAPER=true`). Default is **live** — provide live API keys,
 * which differ from paper keys.
 */
function isPaper(): boolean {
  const env = (process.env.ALPACA_ENV ?? (process.env.ALPACA_PAPER === 'true' ? 'paper' : 'live')).toLowerCase();
  return env === 'paper';
}

/** Resolves the base host for one API: env override, else the routing table (data is env-independent). */
function resolveHost(api: string): string {
  const override = process.env[ENV_URL[api] ?? ''];
  if (override) return override;
  const routing = API_ROUTING[api];
  if (!routing) throw new Error(`Unknown API: ${api}`);
  const { servers } = routing;
  if (api === 'data') return servers.live;
  return isPaper() ? (servers.paper ?? servers.sandbox ?? servers.live) : servers.live;
}

/** Adds the API's auth to the outgoing headers (the generated client supplies body + Content-Type). */
function authHeaders(api: string): Record<string, string> {
  const key = process.env.ALPACA_API_KEY ?? '';
  const secret = process.env.ALPACA_API_SECRET ?? '';
  switch (API_ROUTING[api]?.auth) {
    case 'basic':
      return { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}` };
    case 'form':
      // AuthX is form-encoded with credentials carried in the (caller-supplied) body.
      return {};
    default:
      return { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret };
  }
}

/** Builds the mutator bound to one API. Generated clients import the four exports below. */
export function makeMutator(api: string) {
  return async <T>(url: string, options?: RequestInit): Promise<T> => {
    const headers = { ...((options?.headers as Record<string, string>) ?? {}), ...authHeaders(api) };
    const response = await fetch(`${resolveHost(api)}${url}`, { ...options, headers });
    const text = await response.text();
    let data: any = text;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        /* leave as raw text */
      }
    }
    // Generated clients/handlers branch on `.status` and read `.data`.
    const result: any = { status: response.status, data: text ? data : undefined };
    return result;
  };
}

export const tradingMutator = makeMutator('trading');
export const dataMutator = makeMutator('data');
export const brokerMutator = makeMutator('broker');
export const authxMutator = makeMutator('authx');
