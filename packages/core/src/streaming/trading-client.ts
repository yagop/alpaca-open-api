/**
 * Trading stream - real-time order lifecycle events (`trade_updates`) over
 * Alpaca's account WebSocket. Binary msgpack frames by default (decoded with
 * the hand-rolled decoder in `./msgpack`), auth/listen handshake (not the
 * subscribe/unsubscribe one the market-data streams use - there's exactly
 * one channel, your whole account, so it's auto-listened on every connect
 * and reconnect via the base client's subscription replay).
 *
 * @see https://docs.alpaca.markets/docs/websocket-streaming
 */

import { EventEmitter } from 'node:events';
import type { Order } from '../generated/trading/model';
import { AsyncQueue, StreamClient, type ReconnectOptions } from './client';
import { decode } from './msgpack';
import { tradingStreamUrl } from './routes';

/** All `data.event` values Alpaca's trade_updates stream can send. */
export type TradeUpdateEvent =
  | 'new'
  | 'fill'
  | 'partial_fill'
  | 'canceled'
  | 'expired'
  | 'done_for_day'
  | 'replaced'
  | 'accepted'
  | 'rejected'
  | 'pending_new'
  | 'stopped'
  | 'pending_cancel'
  | 'pending_replace'
  | 'calculated'
  | 'suspended'
  | 'order_replace_rejected'
  | 'order_cancel_rejected';

/** One `trade_updates` event - `price`/`qty`/`position_qty`/`execution_id` are only present for fill events. */
export interface TradeUpdate {
  event: TradeUpdateEvent;
  order: Order;
  timestamp?: string;
  execution_id?: string;
  price?: string;
  qty?: string;
  position_qty?: string;
}

export interface TradingStreamEvents {
  open: [];
  authenticated: [];
  trade_update: [TradeUpdate];
  error: [Error];
  close: [{ code: number; reason: string }];
  reconnecting: [{ attempt: number; delayMs: number }];
}

export interface TradingStreamOptions {
  /** Defaults to `ALPACA_API_KEY`. */
  apiKey?: string;
  /** Defaults to `ALPACA_API_SECRET`. */
  apiSecret?: string;
  reconnect?: ReconnectOptions | false;
  idleTimeoutMs?: number;
  /** `WebSocket` constructor to use - override in tests. */
  WebSocketImpl?: typeof WebSocket;
}

const LISTEN_KEY = 'trade_updates';

interface AuthorizationMessage {
  stream: 'authorization';
  data: { status: 'authorized' | 'unauthorized'; action: 'authenticate' };
}

interface TradeUpdateMessage {
  stream: 'trade_updates';
  data: TradeUpdate;
}

function isAuthorizationMessage(message: unknown): message is AuthorizationMessage {
  return !!message && typeof message === 'object' && (message as { stream?: unknown }).stream === 'authorization';
}

function isTradeUpdateMessage(message: unknown): message is TradeUpdateMessage {
  return !!message && typeof message === 'object' && (message as { stream?: unknown }).stream === 'trade_updates';
}

/** The trading stream is binary (msgpack) only - a text frame would mean the server changed protocol. */
function decodeFrame(data: string | ArrayBuffer): unknown {
  if (typeof data === 'string') throw new Error('trading stream: unexpected text frame (expected binary msgpack)');
  return decode(data);
}

/**
 * Connects to the trading stream and emits typed `trade_update` events
 * (`EventEmitter`) plus an `AsyncIterable<TradeUpdate>`. Everything else
 * (reconnect/backoff, idle detection, re-listening after a reconnect) is
 * inherited from {@link StreamClient}.
 */
export class TradingStreamClient extends EventEmitter<TradingStreamEvents> implements AsyncIterable<TradeUpdate> {
  private readonly client: StreamClient;
  private readonly updates = new AsyncQueue<TradeUpdate>();

  constructor(options: TradingStreamOptions = {}) {
    super();
    const key = options.apiKey ?? process.env.ALPACA_API_KEY ?? '';
    const secret = options.apiSecret ?? process.env.ALPACA_API_SECRET ?? '';
    this.client = new StreamClient({
      url: tradingStreamUrl,
      auth: () => ({ action: 'auth', key, secret }),
      decode: decodeFrame,
      isAuthenticated: (message) => isAuthorizationMessage(message) && message.data.status === 'authorized',
      reconnect: options.reconnect,
      idleTimeoutMs: options.idleTimeoutMs,
      WebSocketImpl: options.WebSocketImpl,
    });
    this.client.on('open', () => this.emit('open'));
    this.client.on('authenticated', () => {
      this.client.subscribe(LISTEN_KEY, { action: 'listen', data: { streams: [LISTEN_KEY] } });
      this.emit('authenticated');
    });
    this.client.on('error', (err) => this.emit('error', err));
    this.client.on('reconnecting', (e) => this.emit('reconnecting', e));
    this.client.on('close', (e) => {
      this.emit('close', e);
      this.updates.end();
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

  [Symbol.asyncIterator](): AsyncIterator<TradeUpdate> {
    return this.updates[Symbol.asyncIterator]();
  }

  private handleMessage(message: unknown): void {
    if (isAuthorizationMessage(message)) {
      if (message.data.status === 'unauthorized') this.emit('error', new Error('trading stream: unauthorized'));
      return; // the 'authorized' case already drove the base client to 'open' before this fired
    }
    if (!isTradeUpdateMessage(message)) return; // e.g. the "listening" ack - nothing to surface
    this.emit('trade_update', message.data);
    this.updates.push(message.data);
  }
}
