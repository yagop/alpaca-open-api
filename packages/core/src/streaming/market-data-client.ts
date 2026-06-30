/**
 * Market-data streams - real-time stock, crypto, option and news data over
 * Alpaca's `stream.data.alpaca.markets` WebSocket. One JSON protocol shared
 * by all four feeds (auth, then incremental `subscribe`/`unsubscribe` by
 * channel + symbols, e.g. `{action:"subscribe",trades:["AAPL"]}`) - so a
 * single generic client (`MarketDataStreamClient`) implements it once, and
 * four tiny factories below wire it to the right host/feed and message type.
 *
 * Subscriptions are tracked as one merged `{channel: symbols[]}` message
 * under a single replay key on the base `StreamClient` - it resends the
 * latest full desired state on every successful auth (incl. after a
 * reconnect) automatically, so this client doesn't need to watch for an
 * "authenticated" signal itself to re-subscribe.
 *
 * @see https://docs.alpaca.markets/docs/streaming-market-data
 */

import type { CryptoBar, CryptoQuote, CryptoTrade, News, OptionQuote, OptionTrade, StockBar, StockQuote, StockTrade } from '../generated/data/model';
import { StreamClient, type ReconnectOptions } from './client';
import { cryptoStreamUrl, newsStreamUrl, optionStreamUrl, stockStreamUrl, type OptionFeed, type StockFeed } from './routes';

/** A stock trade/quote/bar event - REST model shape plus the streaming envelope (`T`, `S`). */
export type StockMessage = (StockTrade & { T: 't'; S: string }) | (StockQuote & { T: 'q'; S: string }) | (StockBar & { T: 'b' | 'd' | 'u'; S: string });
/** A crypto trade/quote/bar event. */
export type CryptoMessage = (CryptoTrade & { T: 't'; S: string }) | (CryptoQuote & { T: 'q'; S: string }) | (CryptoBar & { T: 'b' | 'd' | 'u'; S: string });
/** An option trade/quote event. */
export type OptionMessage = (OptionTrade & { T: 't'; S: string }) | (OptionQuote & { T: 'q'; S: string });
/** A news article event. */
export type NewsMessage = News & { T: 'n' };

/** The server's ack after a subscribe/unsubscribe, echoing the resulting per-channel symbol lists. */
export interface SubscriptionAck {
  T: 'subscription';
  [channel: string]: unknown;
}

/** Everything `MarketDataStreamClient` can yield. */
export type MarketDataStreamEvent<TMessage> =
  | { type: 'open' }
  | { type: 'authenticated' }
  | { type: 'reconnecting'; attempt: number; delayMs: number }
  | { type: 'error'; error: Error }
  | { type: 'subscription'; ack: SubscriptionAck }
  | { type: 'message'; message: TMessage };

export interface MarketDataStreamOptions {
  /** Defaults to `ALPACA_API_KEY`. */
  apiKey?: string;
  /** Defaults to `ALPACA_API_SECRET`. */
  apiSecret?: string;
  reconnect?: ReconnectOptions | false;
  idleTimeoutMs?: number;
  /** `WebSocket` constructor to use - override in tests. */
  WebSocketImpl?: typeof WebSocket;
}

const SUBSCRIPTION_KEY = 'subscriptions';

interface ControlMessage {
  T: 'success' | 'error';
  msg?: string;
  code?: number;
}

function isControlMessage(message: unknown, msg: string): message is ControlMessage {
  return !!message && typeof message === 'object' && (message as ControlMessage).T === 'success' && (message as ControlMessage).msg === msg;
}

function isErrorMessage(message: unknown): message is Required<ControlMessage> {
  return !!message && typeof message === 'object' && (message as ControlMessage).T === 'error';
}

function isSubscriptionAck(message: unknown): message is SubscriptionAck {
  return !!message && typeof message === 'object' && (message as SubscriptionAck).T === 'subscription';
}

/**
 * Connects to one market-data feed (stocks/crypto/options/news - see the
 * factories below) and is an `AsyncIterable<MarketDataStreamEvent<TMessage>>`.
 */
export class MarketDataStreamClient<TMessage extends { T: string }> implements AsyncIterable<MarketDataStreamEvent<TMessage>> {
  private readonly client: StreamClient;
  private readonly desired: Record<string, Set<string>> = {};

  constructor(options: MarketDataStreamOptions & { url(): string }) {
    const key = options.apiKey ?? process.env.ALPACA_API_KEY ?? '';
    const secret = options.apiSecret ?? process.env.ALPACA_API_SECRET ?? '';
    this.client = new StreamClient({
      url: options.url,
      auth: () => ({ action: 'auth', key, secret }),
      isAuthenticated: (message) => isControlMessage(message, 'authenticated'),
      reconnect: options.reconnect,
      idleTimeoutMs: options.idleTimeoutMs,
      WebSocketImpl: options.WebSocketImpl,
    });
  }

  get state() {
    return this.client.state;
  }

  connect(): void {
    this.client.connect();
  }

  close(code?: number, reason?: string): void {
    this.client.close(code, reason);
  }

  /**
   * Subscribes to symbols per channel, e.g. `{trades: ['AAPL'], quotes: ['AAPL']}`. Merges into the
   * tracked desired state and sends only the incremental `channels` given here - the full merged
   * state is tracked separately (via `track()`, no extra send) purely so it can be replayed in one
   * message after a reconnect.
   */
  subscribe(channels: Record<string, string[]>): void {
    this.merge(channels, true);
    const full = this.fullSubscribeMessage();
    if (full) this.client.track(SUBSCRIPTION_KEY, full);
    if (this.client.state === 'open') this.client.send({ action: 'subscribe', ...channels });
  }

  /** Unsubscribes symbols per channel and forgets them, so they're not resent on the next reconnect. */
  unsubscribe(channels: Record<string, string[]>): void {
    this.merge(channels, false);
    if (this.client.state === 'open') this.client.send({ action: 'unsubscribe', ...channels });
    const full = this.fullSubscribeMessage();
    if (full) this.client.track(SUBSCRIPTION_KEY, full);
    else this.client.forget(SUBSCRIPTION_KEY);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<MarketDataStreamEvent<TMessage>> {
    this.client.connect();
    for await (const event of this.client) {
      switch (event.type) {
        case 'open':
        case 'reconnecting':
        case 'error':
          yield event;
          break;
        case 'authenticated':
          yield { type: 'authenticated' };
          break;
        case 'message': {
          const { message } = event;
          if (isControlMessage(message, 'connected')) break; // the initial handshake greeting - nothing to surface
          if (isSubscriptionAck(message)) {
            yield { type: 'subscription', ack: message };
            break;
          }
          if (isErrorMessage(message)) {
            yield { type: 'error', error: new Error(`market data stream: ${message.msg} (code ${message.code})`) };
            break;
          }
          yield { type: 'message', message: message as TMessage };
          break;
        }
      }
    }
  }

  private merge(channels: Record<string, string[]>, add: boolean): void {
    for (const [channel, symbols] of Object.entries(channels)) {
      const set = (this.desired[channel] ??= new Set());
      for (const symbol of symbols) (add ? set.add(symbol) : set.delete(symbol));
      if (set.size === 0) delete this.desired[channel];
    }
  }

  private fullSubscribeMessage(): Record<string, unknown> | undefined {
    const entries = Object.entries(this.desired).filter(([, set]) => set.size > 0);
    if (!entries.length) return undefined;
    return { action: 'subscribe', ...Object.fromEntries(entries.map(([channel, set]) => [channel, [...set]])) };
  }
}

/** Stock trades/quotes/bars. `feed` defaults to `iex`. */
export function stockDataStream(options: MarketDataStreamOptions & { feed?: StockFeed } = {}): MarketDataStreamClient<StockMessage> {
  const { feed, ...rest } = options;
  return new MarketDataStreamClient<StockMessage>({ ...rest, url: () => stockStreamUrl(feed) });
}

/** Crypto trades/quotes/bars (`us` venue). */
export function cryptoDataStream(options: MarketDataStreamOptions = {}): MarketDataStreamClient<CryptoMessage> {
  return new MarketDataStreamClient<CryptoMessage>({ ...options, url: cryptoStreamUrl });
}

/** Option trades/quotes. `feed` defaults to `indicative`. */
export function optionDataStream(options: MarketDataStreamOptions & { feed?: OptionFeed } = {}): MarketDataStreamClient<OptionMessage> {
  const { feed, ...rest } = options;
  return new MarketDataStreamClient<OptionMessage>({ ...rest, url: () => optionStreamUrl(feed) });
}

/** News articles. Subscribe with `{news: ['*']}` for everything or specific symbols. */
export function newsDataStream(options: MarketDataStreamOptions = {}): MarketDataStreamClient<NewsMessage> {
  return new MarketDataStreamClient<NewsMessage>({ ...options, url: newsStreamUrl });
}
