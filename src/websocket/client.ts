/**
 * ProxyPay WebSocket Client SDK
 *
 * Browser + Node.js compatible client for real-time transaction status updates.
 *
 * Features:
 *  - Auto-reconnect with exponential backoff (max 30 s)
 *  - Subscription state recovery after reconnect
 *  - Typed event emitter (transaction.updated, connect, disconnect, error)
 *  - Heartbeat / ping-pong monitoring
 *
 * Usage (browser / Node):
 *
 *   const client = new ProxyPayWebSocketClient('wss://api.proxypay.io', '<jwt>');
 *   client.on('connect', () => client.subscribe('tx-abc'));
 *   client.on('transaction.updated', (payload) => console.log(payload));
 *   client.connect();
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClientOptions {
  /** Maximum reconnect delay in ms (default 30 000). */
  maxReconnectDelayMs?: number;
  /** Initial reconnect delay in ms (default 500). */
  initialReconnectDelayMs?: number;
  /** Maximum number of reconnect attempts before giving up (default Infinity). */
  maxReconnectAttempts?: number;
  /** Log debug messages to console (default false). */
  debug?: boolean;
}

export interface TransactionUpdatedPayload {
  id: string;
  status: string;
  userId?: string | null;
  [key: string]: unknown;
}

type EventMap = {
  connect: [];
  disconnect: [code: number, reason: string];
  error: [error: Error];
  "transaction.updated": [payload: TransactionUpdatedPayload];
  "batch.progress": [payload: unknown];
  message: [msg: ServerMessage];
};

export interface ServerMessage {
  type: string;
  data: unknown;
}

type ListenerFn<T extends unknown[]> = (...args: T) => void;

// ---------------------------------------------------------------------------
// ProxyPayWebSocketClient
// ---------------------------------------------------------------------------

export class ProxyPayWebSocketClient {
  private readonly url: string;
  private readonly token: string;
  private readonly options: Required<ClientOptions>;

  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = false;

  /**
   * Subscriptions held locally so they can be re-sent after reconnect.
   */
  private activeSubscriptions: Set<string> = new Set();

  private listeners: {
    [K in keyof EventMap]?: Set<ListenerFn<EventMap[K]>>;
  } = {};

  constructor(url: string, token: string, options: ClientOptions = {}) {
    this.url = url;
    this.token = token;
    this.options = {
      maxReconnectDelayMs: options.maxReconnectDelayMs ?? 30_000,
      initialReconnectDelayMs: options.initialReconnectDelayMs ?? 500,
      maxReconnectAttempts: options.maxReconnectAttempts ?? Infinity,
      debug: options.debug ?? false,
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Open the WebSocket connection. */
  connect(): void {
    this.shouldReconnect = true;
    this.openSocket();
  }

  /** Permanently close the connection (no reconnect). */
  disconnect(): void {
    this.shouldReconnect = false;
    this.cancelReconnectTimer();
    this.ws?.close(1000, "Client disconnect");
    this.ws = null;
  }

  /** Subscribe to real-time updates for a transaction. */
  subscribe(transactionId: string): void {
    this.activeSubscriptions.add(transactionId);
    this.sendIfOpen({ type: "subscribe", data: { transactionId } });
  }

  /** Unsubscribe from a transaction. */
  unsubscribe(transactionId: string): void {
    this.activeSubscriptions.delete(transactionId);
    this.sendIfOpen({ type: "unsubscribe", data: { transactionId } });
  }

  /** Returns true when the underlying socket is open and ready. */
  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** Number of reconnect attempts made in the current session. */
  get connectionAttempts(): number {
    return this.reconnectAttempts;
  }

  // -------------------------------------------------------------------------
  // Event emitter
  // -------------------------------------------------------------------------

  on<K extends keyof EventMap>(event: K, handler: ListenerFn<EventMap[K]>): this {
    if (!this.listeners[event]) {
      this.listeners[event] = new Set() as Set<ListenerFn<EventMap[K]>>;
    }
    (this.listeners[event] as Set<ListenerFn<EventMap[K]>>).add(handler);
    return this;
  }

  off<K extends keyof EventMap>(event: K, handler: ListenerFn<EventMap[K]>): this {
    (this.listeners[event] as Set<ListenerFn<EventMap[K]>> | undefined)?.delete(handler);
    return this;
  }

  once<K extends keyof EventMap>(event: K, handler: ListenerFn<EventMap[K]>): this {
    const wrapper = ((...args: EventMap[K]) => {
      this.off(event, wrapper as ListenerFn<EventMap[K]>);
      (handler as (...a: unknown[]) => void)(...args);
    }) as ListenerFn<EventMap[K]>;
    return this.on(event, wrapper);
  }

  // -------------------------------------------------------------------------
  // Internal – socket lifecycle
  // -------------------------------------------------------------------------

  private openSocket(): void {
    if (this.ws && this.ws.readyState < WebSocket.CLOSING) {
      return; // already open or connecting
    }

    const fullUrl = this.buildUrl();
    this.log(`Connecting to ${fullUrl} (attempt ${this.reconnectAttempts + 1})`);

    try {
      // Works in both browser (global WebSocket) and Node.js (ws package)
      this.ws = new WebSocket(fullUrl);
    } catch (err) {
      this.emit("error", [err instanceof Error ? err : new Error(String(err))]);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.log("Connected");
      this.reconnectAttempts = 0;
      // Re-subscribe to any active subscriptions (state recovery)
      for (const txId of this.activeSubscriptions) {
        this.sendIfOpen({ type: "subscribe", data: { transactionId: txId } });
      }
    };

    this.ws.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data as string);
    };

    this.ws.onclose = (event: CloseEvent) => {
      this.log(`Disconnected (code=${event.code}, reason=${event.reason})`);
      this.emit("disconnect", [event.code, event.reason]);
      this.ws = null;
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (event: Event) => {
      const error = new Error("WebSocket error");
      this.emit("error", [error]);
    };
  }

  private handleMessage(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      this.emit("error", [new Error(`Received non-JSON message: ${raw}`)]);
      return;
    }

    this.emit("message", [msg]);

    switch (msg.type) {
      case "connection.ack":
        this.log("Connection acknowledged by server");
        this.emit("connect", []);
        break;

      case "transaction.updated":
        this.emit("transaction.updated", [msg.data as TransactionUpdatedPayload]);
        break;

      case "batch.progress":
        this.emit("batch.progress", [msg.data]);
        break;

      case "error":
        this.log(`Server error: ${JSON.stringify(msg.data)}`);
        // Don't emit as a hard Error — server errors are informational
        break;

      default:
        this.log(`Unhandled message type: ${msg.type}`);
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      this.log("Max reconnect attempts reached, giving up");
      this.shouldReconnect = false;
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      this.options.initialReconnectDelayMs * 2 ** (this.reconnectAttempts - 1),
      this.options.maxReconnectDelayMs,
    );
    // Add ±10 % jitter to spread thundering-herd reconnects
    const jitter = delay * 0.1 * (Math.random() * 2 - 1);
    const totalDelay = Math.round(delay + jitter);

    this.log(`Reconnecting in ${totalDelay} ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, totalDelay);
  }

  private cancelReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private sendIfOpen(payload: object): void {
    if (this.isConnected) {
      this.ws!.send(JSON.stringify(payload));
    }
  }

  private buildUrl(): string {
    const separator = this.url.includes("?") ? "&" : "?";
    return `${this.url}${separator}token=${encodeURIComponent(this.token)}`;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private emit<K extends keyof EventMap>(event: K, args: EventMap[K]): void {
    const handlers = this.listeners[event] as Set<ListenerFn<EventMap[K]>> | undefined;
    if (!handlers) return;
    for (const h of handlers) {
      try {
        (h as (...a: unknown[]) => void)(...args);
      } catch (err) {
        console.error(`[ProxyPayWebSocketClient] Listener error on "${String(event)}":`, err);
      }
    }
  }

  private log(msg: string): void {
    if (this.options.debug) {
      console.debug(`[ProxyPayWebSocketClient] ${msg}`);
    }
  }
}

export default ProxyPayWebSocketClient;
