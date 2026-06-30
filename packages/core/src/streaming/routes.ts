/**
 * WebSocket endpoint resolution for the streaming clients - the streaming
 * counterpart of `mutator.ts`'s `resolveHost`. Trading-stream hosts are derived
 * from the REST routing table (same paper/live split, `https` -> `wss`); the
 * market-data streams live on their own `stream.data.alpaca.markets` host
 * (env-independent, like the REST data API) with one path per stream family.
 * Per-host `ALPACA_STREAM_*_URL` overrides mirror the REST `ALPACA_*_URL` ones.
 */

import { API_ROUTING } from './../api-routing';

/** Stock data feeds (`sip` needs a paid subscription; `test` is the free fake-data feed). */
export type StockFeed = 'iex' | 'sip' | 'delayed_sip' | 'test';

/** Option data feeds (`indicative` is free; `opra` needs a subscription). */
export type OptionFeed = 'indicative' | 'opra';

const DATA_STREAM_HOST = 'wss://stream.data.alpaca.markets';

/**
 * True only when explicitly opting into paper hosts via `ALPACA_ENV=paper` (or the
 * legacy `ALPACA_PAPER=true`). Mirrors `mutator.ts` - live by default, since live
 * and paper keys differ. Kept local so streaming stays decoupled from the REST seam.
 */
function isPaper(): boolean {
  const env = (process.env.ALPACA_ENV ?? (process.env.ALPACA_PAPER === 'true' ? 'paper' : 'live')).toLowerCase();
  return env === 'paper';
}

/** Base `wss://stream.data.alpaca.markets` host (env-independent), honoring the override. */
function dataHost(): string {
  return process.env.ALPACA_STREAM_DATA_URL || DATA_STREAM_HOST;
}

/** `wss://(paper-)api.alpaca.markets/stream` for account/trade updates. */
export function tradingStreamUrl(): string {
  const override = process.env.ALPACA_STREAM_TRADING_URL;
  if (override) return override;
  const { servers } = API_ROUTING.trading;
  const http = isPaper() ? servers.paper : servers.live;
  return `${http.replace(/^http/, 'ws')}/stream`;
}

/** `wss://stream.data.alpaca.markets/v2/{feed}` for real-time stock data. */
export function stockStreamUrl(feed: StockFeed = 'iex'): string {
  return `${dataHost()}/v2/${feed}`;
}

/** `wss://stream.data.alpaca.markets/v1beta3/crypto/us` for real-time crypto data. */
export function cryptoStreamUrl(): string {
  return `${dataHost()}/v1beta3/crypto/us`;
}

/** `wss://stream.data.alpaca.markets/v1beta1/{feed}` for real-time option data. */
export function optionStreamUrl(feed: OptionFeed = 'indicative'): string {
  return `${dataHost()}/v1beta1/${feed}`;
}

/** `wss://stream.data.alpaca.markets/v1beta1/news` for real-time news. */
export function newsStreamUrl(): string {
  return `${dataHost()}/v1beta1/news`;
}
