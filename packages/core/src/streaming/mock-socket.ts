/**
 * A stand-in for the global `WebSocket`, shared by the streaming test suite - no
 * network. `close()` mirrors the real close handshake: `readyState` moves to
 * CLOSING synchronously, but the 'close' event (and CLOSED state) land on a later
 * microtask - a synchronous mock would hide the exact connect()/close() races the
 * real client has to guard against. Not itself a `*.test.ts` file, so bun test
 * doesn't try to run it.
 */
export class MockSocket {
  static instances: MockSocket[] = [];
  readyState = 0; // CONNECTING
  binaryType: 'blob' | 'arraybuffer' = 'blob';
  sent: unknown[] = [];
  private listeners = new Map<string, Array<(event: any) => void>>();

  constructor(public url: string) {
    MockSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState >= 2) return; // already closing/closed
    this.readyState = 2; // CLOSING
    queueMicrotask(() => {
      this.readyState = 3; // CLOSED
      this.fire('close', { code, reason });
    });
  }

  // --- test driver helpers, not part of the real WebSocket API ---
  open(): void {
    this.readyState = 1; // OPEN
    this.fire('open', {});
  }

  message(data: unknown): void {
    this.fire('message', { data });
  }

  private fire(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

export function lastSocket(): MockSocket {
  return MockSocket.instances[MockSocket.instances.length - 1]!;
}

/** Flushes pending microtasks (e.g. a MockSocket's deferred close handshake). */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
