/**
 * Base WebSocket streaming client - the connect/auth/subscribe/reconnect
 * machinery shared by every Alpaca stream (trading `trade_updates`,
 * stock/crypto/option market data, news). Hand-written, like the mutator
 * HTTP seam: streaming isn't in the OpenAPI specs, so there's nothing to
 * generate.
 *
 * Per-stream protocol differences (JSON vs msgpack frames, the auth/listen
 * vs auth/subscribe handshake, message shapes) are supplied by the caller
 * via {@link StreamClientOptions}; this class only owns what's identical
 * across every stream: connection lifecycle, auth sequencing, subscription
 * replay on reconnect, idle/stale detection and backoff.
 */

import { EventEmitter } from 'node:events';

export type StreamClientState = 'idle' | 'connecting' | 'authenticating' | 'open' | 'closing' | 'closed';

/** Exponential backoff for automatic reconnects. */
export interface ReconnectOptions {
  /** Delay before the first reconnect attempt, in ms. Default 500. */
  initialDelayMs?: number;
  /** Cap on the backoff delay, in ms. Default 30_000. */
  maxDelayMs?: number;
  /** Multiplier applied to the delay after each failed attempt. Default 2. */
  factor?: number;
}

export interface StreamClientEvents {
  open: [];
  authenticated: [];
  message: [unknown];
  error: [Error];
  close: [{ code: number; reason: string }];
  reconnecting: [{ attempt: number; delayMs: number }];
}

export interface StreamClientOptions {
  /** Resolves the WebSocket URL; called on every (re)connect. */
  url(): string;
  /** Builds the outgoing auth message, sent right after the socket opens. */
  auth(): unknown;
  /** True once a decoded message indicates the auth handshake succeeded. */
  isAuthenticated(message: unknown): boolean;
  /** Decodes one inbound frame. Defaults to `JSON.parse` of text frames (throws on binary). */
  decode?(data: string | ArrayBuffer): unknown;
  /** Encodes one outgoing message before sending. Defaults to `JSON.stringify`. */
  encode?(message: unknown): string;
  /** Backoff for automatic reconnects. `false` disables reconnecting. Default enabled. */
  reconnect?: ReconnectOptions | false;
  /** Force a reconnect if no message (incl. the auth ack) arrives within this many ms. 0/undefined disables. */
  idleTimeoutMs?: number;
  /** `WebSocket` constructor to use - override in tests. Defaults to the global `WebSocket`. */
  WebSocketImpl?: typeof WebSocket;
}

const DEFAULT_RECONNECT: Required<ReconnectOptions> = { initialDelayMs: 500, maxDelayMs: 30_000, factor: 2 };
/** Per the WebSocket spec, `readyState` values are fixed - no need for the constructor's statics. */
const WS_OPEN = 1;

/**
 * A minimal async pull queue - decouples push-style event emission from
 * pull-style async iteration. Shared by `StreamClient` (for its raw `message`
 * stream) and the typed per-stream clients built on top of it (trading,
 * market data), so each doesn't reimplement the same buffering.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly pulls: Array<(result: IteratorResult<T>) => void> = [];
  private done = false;

  push(item: T): void {
    const pull = this.pulls.shift();
    if (pull) pull({ value: item, done: false });
    else this.items.push(item);
  }

  /** Ends the stream - pending and future `next()` calls resolve `{ done: true }`. */
  end(): void {
    this.done = true;
    while (this.pulls.length) this.pulls.shift()!({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift() as T, done: false });
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.pulls.push(resolve));
      },
    };
  }
}

/**
 * Connects, authenticates, tracks subscriptions for replay, and reconnects
 * with backoff. Subclasses (or callers) interpret decoded messages - this
 * class only emits the generic `message` event plus connection-lifecycle
 * events, and is itself an `AsyncIterable<unknown>` over messages.
 */
export class StreamClient extends EventEmitter<StreamClientEvents> implements AsyncIterable<unknown> {
  private socket: WebSocket | undefined;
  private _state: StreamClientState = 'idle';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly subscriptions = new Map<string, unknown>();
  private readonly messages = new AsyncQueue<unknown>();
  private readonly reconnectOpts: Required<ReconnectOptions> | false;

  constructor(private readonly options: StreamClientOptions) {
    super();
    this.reconnectOpts = options.reconnect === false ? false : { ...DEFAULT_RECONNECT, ...options.reconnect };
  }

  get state(): StreamClientState {
    return this._state;
  }

  /** Opens the connection. A no-op while already connecting/authenticating/open. */
  connect(): void {
    if (this._state === 'connecting' || this._state === 'authenticating' || this._state === 'open') return;
    this.clearReconnectTimer();
    this._state = 'connecting';
    const WebSocketImpl = this.options.WebSocketImpl ?? globalThis.WebSocket;
    const socket = new WebSocketImpl(this.options.url());
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.addEventListener('open', () => this.handleOpen());
    socket.addEventListener('message', (event: MessageEvent) => this.handleMessage(event.data));
    socket.addEventListener('error', () => this.emit('error', new Error('stream socket error')));
    socket.addEventListener('close', (event: CloseEvent) => this.handleClose(event.code, event.reason));
  }

  /** Sends one message, encoded per `options.encode` (JSON by default). Throws if the socket isn't open. */
  send(message: unknown): void {
    if (!this.socket || this.socket.readyState !== WS_OPEN) throw new Error('stream socket is not open');
    const encode = this.options.encode ?? ((m: unknown) => JSON.stringify(m));
    this.socket.send(encode(message));
  }

  /**
   * Sends a subscribe message and remembers it under `key` so it's replayed
   * automatically after a reconnect (each key's latest message wins).
   */
  subscribe(key: string, message: unknown): void {
    this.subscriptions.set(key, message);
    if (this._state === 'open') this.send(message);
  }

  /** Sends an unsubscribe message and forgets `key`, so it's no longer replayed on reconnect. */
  unsubscribe(key: string, message: unknown): void {
    this.subscriptions.delete(key);
    if (this._state === 'open') this.send(message);
  }

  /** Closes the connection and disables auto-reconnect. Safe to call before `connect()` or more than once. */
  close(code = 1000, reason = ''): void {
    this.clearReconnectTimer();
    this.clearIdleTimer();
    if (this._state === 'closed' || this._state === 'closing') return;
    if (this.socket && this.socket.readyState <= WS_OPEN) {
      this._state = 'closing';
      this.socket.close(code, reason);
      return;
    }
    this._state = 'closed';
    this.emit('close', { code, reason });
    this.messages.end();
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this.messages[Symbol.asyncIterator]();
  }

  private handleOpen(): void {
    this._state = 'authenticating';
    this.resetIdleTimer();
    this.emit('open');
    try {
      this.send(this.options.auth());
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  private handleMessage(data: unknown): void {
    this.resetIdleTimer();
    let decoded: unknown;
    try {
      decoded = this.decode(data as string | ArrayBuffer);
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      return;
    }
    for (const message of Array.isArray(decoded) ? decoded : [decoded]) this.processMessage(message);
  }

  private processMessage(message: unknown): void {
    if (this._state === 'authenticating' && this.options.isAuthenticated(message)) {
      this._state = 'open';
      this.reconnectAttempt = 0;
      for (const subscribed of this.subscriptions.values()) this.send(subscribed);
      this.emit('authenticated');
      return;
    }
    this.emit('message', message);
    this.messages.push(message);
  }

  private handleClose(code: number, reason: string): void {
    this.clearIdleTimer();
    this.socket = undefined;
    const closingIntentionally = this._state === 'closing';
    this._state = 'closed';
    if (!closingIntentionally && this.reconnectOpts) {
      this.scheduleReconnect();
      return;
    }
    this.emit('close', { code, reason });
    this.messages.end();
  }

  private scheduleReconnect(): void {
    if (!this.reconnectOpts) return;
    const { initialDelayMs, maxDelayMs, factor } = this.reconnectOpts;
    const delayMs = Math.min(maxDelayMs, initialDelayMs * factor ** this.reconnectAttempt);
    this.reconnectAttempt++;
    this.emit('reconnecting', { attempt: this.reconnectAttempt, delayMs });
    this.reconnectTimer = setTimeout(() => this.connect(), delayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  /** Forces a reconnect if no frame (incl. the auth ack) arrives within `idleTimeoutMs` - the connection is presumably dead. */
  private resetIdleTimer(): void {
    this.clearIdleTimer();
    const timeoutMs = this.options.idleTimeoutMs;
    if (!timeoutMs) return;
    this.idleTimer = setTimeout(() => {
      this.emit('error', new Error('stream idle timeout - no messages received, reconnecting'));
      this.socket?.close();
    }, timeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private decode(data: string | ArrayBuffer): unknown {
    if (this.options.decode) return this.options.decode(data);
    if (typeof data !== 'string') throw new Error('stream: binary frame received but no decode() was configured');
    return JSON.parse(data);
  }
}
