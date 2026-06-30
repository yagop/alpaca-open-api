/**
 * Market-data streams - real-time stock, crypto, option and news data over
 * Alpaca's `stream.data.alpaca.markets` WebSocket. One JSON protocol shared
 * by all four feeds (auth, then incremental `subscribe`/`unsubscribe` by
 * channel + symbols, e.g. `{action:"subscribe",trades:["AAPL"]}`) - so a
 * single generic client (`MarketDataStreamClient`) implements it once, and
 * four tiny factories below wire it to the right host/feed and message type.
 *
 * @see https://docs.alpaca.markets/docs/streaming-market-data
 */

import { EventEmitter } from 'node:events';
import type { CryptoBar, CryptoQuote, CryptoTrade, News, OptionQuote, OptionTrade, StockBar, StockQuote, StockTrade } from '../generated/data/model';
import { AsyncQueue, StreamClient, type ReconnectOptions } from './client';
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

export interface MarketDataStreamEvents<TMessage> {
  open: [];
  authenticated: [];
  message: [TMessage];
  subscription: [SubscriptionAck];
  error: [Error];
  close: [{ code: number; reason: string }];
  reconnecting: [{ attempt: number; delayMs: number }];
}

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
 * factories below) and emits typed events plus an `AsyncIterable<TMessage>`.
 * Subscriptions are tracked locally as the desired `{channel: Set<symbol>}`
 * state and resent in full on every `authenticated` (incl. after a
 * reconnect) - the wire protocol's `subscribe` is additive, so resending the
 * full set is a no-op for what the server already has.
 */
export class MarketDataStreamClient<TMessage extends { T: string }>
  extends EventEmitter<MarketDataStreamEvents<TMessage>>
  implements AsyncIterable<TMessage>
{
  private readonly client: StreamClient;
  private readonly desired: Record<string, Set<string>> = {};
  private readonly stream = new AsyncQueue<TMessage>();

  constructor(options: MarketDataStreamOptions & { url(): string }) {
    super();
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
    this.client.on('open', () => this.emit('open'));
    this.client.on('authenticated', () => {
      this.resend();
      this.emit('authenticated');
    });
    this.client.on('error', (err) => this.emit('error', err));
    this.client.on('reconnecting', (e) => this.emit('reconnecting', e));
    this.client.on('close', (e) => {
      this.emit('close', e);
      this.stream.end();
    });
    this.client.on('message', (message) => this.handleMessage(message));
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

  [Symbol.asyncIterator](): AsyncIterator<TMessage> {
    return this.stream[Symbol.asyncIterator]();
  }

  /** Subscribes to symbols per channel, e.g. `{trades: ['AAPL'], quotes: ['AAPL']}`. Merges into the tracked desired state. */
  subscribe(channels: Record<string, string[]>): void {
    this.merge(channels, true);
    if (this.client.state === 'open') this.client.send({ action: 'subscribe', ...channels });
  }

  /** Unsubscribes symbols per channel and forgets them, so they're not resent on the next reconnect. */
  unsubscribe(channels: Record<string, string[]>): void {
    this.merge(channels, false);
    if (this.client.state === 'open') this.client.send({ action: 'unsubscribe', ...channels });
  }

  private merge(channels: Record<string, string[]>, add: boolean): void {
    for (const [channel, symbols] of Object.entries(channels)) {
      const set = (this.desired[channel] ??= new Set());
      for (const symbol of symbols) (add ? set.add(symbol) : set.delete(symbol));
      if (set.size === 0) delete this.desired[channel];
    }
  }

  /** Resends the full desired subscription state - called once right after each successful auth. */
  private resend(): void {
    const entries = Object.entries(this.desired).filter(([, set]) => set.size > 0);
    if (!entries.length) return;
    this.client.send({ action: 'subscribe', ...Object.fromEntries(entries.map(([channel, set]) => [channel, [...set]])) });
  }

  private handleMessage(message: unknown): void {
    if (isControlMessage(message, 'connected')) return; // the initial handshake greeting - nothing to surface
    if (isSubscriptionAck(message)) {
      this.emit('subscription', message);
      return;
    }
    if (isErrorMessage(message)) {
      this.emit('error', new Error(`market data stream: ${message.msg} (code ${message.code})`));
      return;
    }
    const typed = message as TMessage;
    this.emit('message', typed);
    this.stream.push(typed);
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
