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
 *
 * Consumer API is a single `AsyncIterable<StreamEvent>` - deliberately no
 * `EventEmitter`. Node's `EventEmitter` throws (crashing the process) when an
 * `'error'` is emitted with no listener attached, which is exactly the kind
 * of "forgot to wire something up" mistake a streaming client should not be
 * able to turn into a crash. An unread async-iterator event is just inert.
 */

export type StreamClientState = 'idle' | 'connecting' | 'authenticating' | 'open' | 'closing' | 'reconnecting' | 'closed';

/** Exponential backoff for automatic reconnects. */
export interface ReconnectOptions {
  /** Delay before the first reconnect attempt, in ms. Default 500. */
  initialDelayMs?: number;
  /** Cap on the backoff delay, in ms. Default 30_000. */
  maxDelayMs?: number;
  /** Multiplier applied to the delay after each failed attempt. Default 2. */
  factor?: number;
}

/** Everything `StreamClient` can yield - lifecycle plus decoded application messages. */
export type StreamEvent =
  | { type: 'open' }
  | { type: 'authenticated' }
  | { type: 'reconnecting'; attempt: number; delayMs: number }
  | { type: 'error'; error: Error }
  | { type: 'message'; message: unknown };

export interface StreamClientOptions {
  /** Resolves the WebSocket URL; called on every (re)connect. */
  url(): string;
  /** Builds the outgoing auth message, sent right after the socket opens. */
  auth(): unknown;
  /** True once a decoded message indicates the auth handshake succeeded. */
  isAuthenticated(message: unknown): boolean;
  /** Decodes one inbound frame. Defaults to UTF-8 text + `JSON.parse`, for both text and binary-opcode frames. */
  decode?(data: string | ArrayBuffer): unknown;
  /** Encodes one outgoing message before sending. Defaults to `JSON.stringify`. */
  encode?(message: unknown): string | Uint8Array;
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
 * pull-style async iteration. Shared by `StreamClient` and the typed
 * per-stream clients built on top of it, so each doesn't reimplement the
 * same buffering. Single-consumer by design: a second concurrent `next()`
 * call (rather than silently splitting messages round-robin between two
 * readers) rejects loudly, since that's always a usage mistake here.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly pulls: Array<(result: IteratorResult<T>) => void> = [];
  private done = false;

  push(item: T): void {
    if (this.done) return;
    const pull = this.pulls.shift();
    if (pull) pull({ value: item, done: false });
    else this.items.push(item);
  }

  /** Ends the stream - pending and future `next()` calls resolve `{ done: true }`. Idempotent. */
  end(): void {
    if (this.done) return;
    this.done = true;
    while (this.pulls.length) this.pulls.shift()!({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift() as T, done: false });
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        if (this.pulls.length) return Promise.reject(new Error('AsyncQueue: next() was called concurrently by more than one consumer'));
        return new Promise((resolve) => this.pulls.push(resolve));
      },
    };
  }
}

/**
 * Connects, authenticates, tracks subscriptions for replay, and reconnects
 * with backoff. Subclasses (or callers) interpret decoded messages - this
 * class only yields lifecycle events plus the generic decoded `message`,
 * as an `AsyncIterable<StreamEvent>`.
 */
export class StreamClient implements AsyncIterable<StreamEvent> {
  private socket: WebSocket | undefined;
  private _state: StreamClientState = 'idle';
  /** Set only by the public `close()` - distinguishes "won't reconnect" from a transient/idle-forced close. */
  private intentionalClose = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly subscriptions = new Map<string, unknown>();
  private readonly events = new AsyncQueue<StreamEvent>();
  private readonly reconnectOpts: Required<ReconnectOptions> | false;

  constructor(private readonly options: StreamClientOptions) {
    this.reconnectOpts = options.reconnect === false ? false : { ...DEFAULT_RECONNECT, ...options.reconnect };
  }

  get state(): StreamClientState {
    return this._state;
  }

  /** Opens the connection. A no-op while already connecting/authenticating/open/closing; cancels a pending reconnect otherwise. */
  connect(): void {
    if (this._state === 'connecting' || this._state === 'authenticating' || this._state === 'open' || this._state === 'closing') return;
    this.clearReconnectTimer();
    this.intentionalClose = false;
    this._state = 'connecting';
    const WebSocketImpl = this.options.WebSocketImpl ?? globalThis.WebSocket;
    const socket = new WebSocketImpl(this.options.url());
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.addEventListener('open', () => this.handleOpen());
    socket.addEventListener('message', (event: MessageEvent) => this.handleMessage(event.data));
    socket.addEventListener('error', () => this.events.push({ type: 'error', error: new Error('stream socket error') }));
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
   * automatically on every future auth, including after a reconnect (each
   * key's latest message wins).
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

  /** Updates what's replayed under `key` on the next auth, without sending anything right now - for callers managing their own wire sends. */
  track(key: string, message: unknown): void {
    this.subscriptions.set(key, message);
  }

  /** Stops tracking `key` for replay without sending anything - for callers managing their own unsubscribe wire message. */
  forget(key: string): void {
    this.subscriptions.delete(key);
  }

  /** Closes the connection and disables auto-reconnect. Safe to call before `connect()` or more than once. */
  close(code = 1000, reason = ''): void {
    this.clearReconnectTimer();
    this.clearIdleTimer();
    if (this._state === 'closed') return;
    this.intentionalClose = true;
    if (this._state === 'idle' || this._state === 'reconnecting') {
      this._state = 'closed';
      this.events.end();
      return;
    }
    if (this._state === 'closing') return;
    this._state = 'closing';
    this.socket?.close(code, reason);
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    return this.events[Symbol.asyncIterator]();
  }

  private handleOpen(): void {
    this._state = 'authenticating';
    this.resetIdleTimer();
    this.events.push({ type: 'open' });
    try {
      this.send(this.options.auth());
    } catch (err) {
      this.events.push({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
    }
  }

  private handleMessage(data: unknown): void {
    this.resetIdleTimer();
    let decoded: unknown;
    try {
      decoded = this.decode(data as string | ArrayBuffer);
    } catch (err) {
      this.events.push({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
      return;
    }
    for (const message of Array.isArray(decoded) ? decoded : [decoded]) this.processMessage(message);
  }

  private processMessage(message: unknown): void {
    if (this._state === 'authenticating' && this.options.isAuthenticated(message)) {
      this._state = 'open';
      this.reconnectAttempt = 0;
      for (const subscribed of this.subscriptions.values()) this.send(subscribed);
      this.events.push({ type: 'authenticated' });
      return;
    }
    this.events.push({ type: 'message', message });
  }

  private handleClose(_code: number, _reason: string): void {
    this.clearIdleTimer();
    this.socket = undefined;
    if (this.intentionalClose || !this.reconnectOpts) {
      this._state = 'closed';
      this.events.end();
      return;
    }
    this._state = 'reconnecting';
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.reconnectOpts) return;
    const { initialDelayMs, maxDelayMs, factor } = this.reconnectOpts;
    const delayMs = Math.min(maxDelayMs, initialDelayMs * factor ** this.reconnectAttempt);
    this.reconnectAttempt++;
    this.events.push({ type: 'reconnecting', attempt: this.reconnectAttempt, delayMs });
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
      this.events.push({ type: 'error', error: new Error('stream idle timeout - no messages received, reconnecting') });
      // Proactively tear down (state -> 'closing', so send()/subscribe() correctly see "not open" during the
      // close handshake) without marking it intentional, so handleClose() schedules a fresh reconnect.
      this._state = 'closing';
      this.socket?.close();
    }, timeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private decode(data: string | ArrayBuffer): unknown {
    if (this.options.decode) return this.options.decode(data);
    // Default: UTF-8 text + JSON.parse, regardless of whether the frame arrived as a text or
    // binary-opcode WS frame. Confirmed against the real API: several Alpaca streams (trading,
    // option data) send JSON as *binary*-opcode frames - "binary frames" in their docs describes
    // the WS opcode, not the codec - while others (stock/crypto/news data) use text frames. A
    // frame that's neither valid UTF-8-as-JSON nor handled by a custom `decode` (e.g. real
    // MessagePack, which needs a `Content-Type` header this client has no way to set) surfaces as
    // an `error` event via the catch in `handleMessage`, same as any other decode failure.
    const text = typeof data === 'string' ? data : DECODER.decode(data);
    return JSON.parse(text);
  }
}

const DECODER = new TextDecoder();
