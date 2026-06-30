/**
 * Trading stream - real-time order lifecycle events (`trade_updates`) over
 * Alpaca's account WebSocket. Auth/listen handshake (not the
 * subscribe/unsubscribe one the market-data streams use - there's exactly
 * one channel, your whole account, so it's listened once at construction
 * time and replayed automatically by the base client on every reconnect).
 *
 * Frames arrive as JSON inside *binary-opcode* WebSocket frames by default -
 * confirmed against the real paper API (`StreamClient`'s default `decode`
 * handles this transparently; see its doc). Alpaca's docs describe an opt-in
 * MessagePack codec (`Content-Type: application/msgpack`), but that needs a
 * custom request header the standard `WebSocket` API has no way to set, so
 * it's unreachable via this client unless you supply a `decode` override
 * backed by a transport that can set it (see `./msgpack`).
 *
 * @see https://docs.alpaca.markets/docs/websocket-streaming
 */

import type { Order } from '../generated/trading/model';
import { StreamClient, type ReconnectOptions } from './client';
import { tradingStreamUrl } from './routes';

/**
 * All known `data.event` values Alpaca's trade_updates stream can send. `| (string & {})` keeps
 * autocomplete for these while still accepting any string - so a new event kind Alpaca adds
 * later flows through typed instead of being rejected by `TradeUpdate.event`'s type.
 */
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
  | 'order_cancel_rejected'
  | (string & {});

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

/** Everything `TradingStreamClient` can yield. */
export type TradingStreamEvent =
  | { type: 'open' }
  | { type: 'authenticated' }
  | { type: 'reconnecting'; attempt: number; delayMs: number }
  | { type: 'error'; error: Error }
  | { type: 'trade_update'; update: TradeUpdate };

export interface TradingStreamOptions {
  /** Defaults to `ALPACA_API_KEY`. */
  apiKey?: string;
  /** Defaults to `ALPACA_API_SECRET`. */
  apiSecret?: string;
  /** Decodes one inbound frame. Defaults to `StreamClient`'s UTF-8 text + `JSON.parse` (the real default codec - see module doc). */
  decode?(data: string | ArrayBuffer): unknown;
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

/**
 * Connects to the trading stream and is an `AsyncIterable<TradingStreamEvent>`.
 * Everything else (reconnect/backoff, idle detection, re-listening after a
 * reconnect) is inherited from {@link StreamClient}.
 */
export class TradingStreamClient implements AsyncIterable<TradingStreamEvent> {
  private readonly client: StreamClient;

  constructor(options: TradingStreamOptions = {}) {
    const key = options.apiKey ?? process.env.ALPACA_API_KEY ?? '';
    const secret = options.apiSecret ?? process.env.ALPACA_API_SECRET ?? '';
    this.client = new StreamClient({
      url: tradingStreamUrl,
      auth: () => ({ action: 'auth', key, secret }),
      decode: options.decode,
      isAuthenticated: (message) => isAuthorizationMessage(message) && message.data.status === 'authorized',
      reconnect: options.reconnect,
      idleTimeoutMs: options.idleTimeoutMs,
      WebSocketImpl: options.WebSocketImpl,
    });
    // Registered once - the base client resends this on every successful auth, including
    // after every reconnect, with no further action needed here.
    this.client.subscribe(LISTEN_KEY, { action: 'listen', data: { streams: [LISTEN_KEY] } });
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

  async *[Symbol.asyncIterator](): AsyncGenerator<TradingStreamEvent> {
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
          if (isAuthorizationMessage(message)) {
            if (message.data.status === 'unauthorized') {
              // Retrying with the same credentials won't fix this - surface it, then stop for good.
              this.client.close();
              yield { type: 'error', error: new Error('trading stream: unauthorized') };
              return;
            }
            break; // the 'authorized' case already drove the base client to 'open' before this could fire
          }
          if (!isTradeUpdateMessage(message)) break; // e.g. the "listening" ack - nothing to surface
          yield { type: 'trade_update', update: message.data };
          break;
        }
      }
    }
  }
}
