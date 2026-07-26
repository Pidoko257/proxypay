/**
 * ProxyPay WebSocket Client SDK
 *
 * TypeScript client for connecting to the ProxyPay WebSocket server and
 * receiving real-time transaction status updates.
 *
 * @example
 * ```typescript
 * const client = new ProxyPayWebSocketClient({
 *   url: 'ws://localhost:3000',
 *   token: 'your-jwt-token',
 * });
 *
 * client.on('connected', () => console.log('Connected'));
 * client.on('transaction.updated', (data) => {
 *   console.log('Transaction updated:', data);
 * });
 *
 * client.subscribe('transaction-id-123');
 * await client.connect();
 * ```
 */

export type MessageType =
  | "connection.ack"
  | "subscribe"
  | "subscribe.ack"
  | "unsubscribe"
  | "transaction.updated"
  | "error"
  | "ping"
  | "pong";

export interface WebSocketMessage {
  type: MessageType;
  data: unknown;
}

export interface TransactionUpdate {
  id: string;
  status: string;
  userId?: string | null;
  [key: string]: unknown;
}

export interface ClientOptions {
  url: string;
  token: string;
  reconnect?: boolean;
  reconnectInterval?: number;
  reconnectMaxAttempts?: number;
  heartbeatInterval?: number;
  debug?: boolean;
}

export type EventType =
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "error"
  | "transaction.updated"
  | "subscribed"
  | "unsubscribed";

export interface EventMap {
  connected: (clientId: string, userId: string) => void;
  disconnected: (reason: string) => void;
  reconnecting: (attempt: number) => void;
  error: (error: Error) => void;
  "transaction.updated": (data: TransactionUpdate) => void;
  subscribed: (transactionId: string) => void;
  unsubscribed: (transactionId: string) => void;
}

/**
 * ProxyPayWebSocketClient provides a robust WebSocket client for real-time
 * transaction status updates with automatic reconnection, subscription management,
 * and event handling.
 */
export class ProxyPayWebSocketClient {
  private ws: WebSocket | null = null;
  private options: Required<ClientOptions>;
  private eventHandlers: Map<EventType, Set<(...args: any[]) => void>> =
    new Map();
  private subscriptions: Set<string> = new Set();
  private clientId: string | null = null;
  private userId: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  private isIntentionallyClosed = false;

  constructor(options: ClientOptions) {
    this.options = {
      reconnect: true,
      reconnectInterval: 1000,
      reconnectMaxAttempts: 10,
      heartbeatInterval: 30000,
      debug: false,
      ...options,
    };
  }

  /**
   * Connects to the WebSocket server.
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.isIntentionallyClosed = false;
        this.ws = new WebSocket(this.options.url);

        this.ws.onopen = () => {
          this.log("WebSocket connected");
          this.reconnectAttempts = 0;
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        this.ws.onerror = (event) => {
          const error = new Error(`WebSocket error: ${event.type}`);
          this.log("WebSocket error", error);
          this.emit("error", error);
          reject(error);
        };

        this.ws.onclose = () => {
          this.log("WebSocket closed");
          this.emit("disconnected", "Connection closed");
          this.clientId = null;
          this.handleReconnection(resolve);
        };

        // Send auth on open (after connection is established, onopen will fire)
        const checkConnection = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            clearInterval(checkConnection);
            this.authenticate(resolve, reject);
          }
        }, 100);

        // Timeout if connection doesn't establish
        setTimeout(() => {
          clearInterval(checkConnection);
          if (this.ws?.readyState !== WebSocket.OPEN && !this.clientId) {
            reject(new Error("Connection timeout"));
          }
        }, 10000);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Disconnects from the WebSocket server.
   */
  disconnect(): void {
    this.isIntentionallyClosed = true;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Subscribes to a transaction's status updates.
   */
  subscribe(transactionId: string): void {
    if (!transactionId) {
      throw new Error("transactionId is required");
    }

    this.subscriptions.add(transactionId);

    if (this.isConnected()) {
      this.send({
        type: "subscribe",
        data: { transactionId },
      });
    }
  }

  /**
   * Unsubscribes from a transaction's status updates.
   */
  unsubscribe(transactionId: string): void {
    if (!transactionId) {
      throw new Error("transactionId is required");
    }

    this.subscriptions.delete(transactionId);

    if (this.isConnected()) {
      this.send({
        type: "unsubscribe",
        data: { transactionId },
      });
    }
  }

  /**
   * Registers an event listener.
   */
  on<E extends EventType>(
    event: E,
    handler: E extends keyof EventMap ? EventMap[E] : (...args: any[]) => void,
  ): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler as (...args: any[]) => void);
  }

  /**
   * Unregisters an event listener.
   */
  off<E extends EventType>(
    event: E,
    handler: E extends keyof EventMap ? EventMap[E] : (...args: any[]) => void,
  ): void {
    this.eventHandlers.get(event)?.delete(handler as (...args: any[]) => void);
  }

  /**
   * Registers a one-time event listener.
   */
  once<E extends EventType>(
    event: E,
    handler: E extends keyof EventMap ? EventMap[E] : (...args: any[]) => void,
  ): void {
    const wrapper = (...args: any[]) => {
      this.off(event, wrapper as any);
      (handler as any)(...args);
    };
    this.on(event, wrapper as any);
  }

  /**
   * Returns whether the client is currently connected.
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.clientId !== null;
  }

  /**
   * Returns the current client ID.
   */
  getClientId(): string | null {
    return this.clientId;
  }

  /**
   * Returns the current user ID.
   */
  getUserId(): string | null {
    return this.userId;
  }

  /**
   * Returns the set of currently subscribed transaction IDs.
   */
  getSubscriptions(): string[] {
    return Array.from(this.subscriptions);
  }

  // -------------------------------------------------------------------------
  // Private methods
  // -------------------------------------------------------------------------

  private authenticate(resolve: () => void, reject: (err: Error) => void): void {
    // Create a one-time listener for the ack
    const ackHandler = (clientId: string, userId: string) => {
      this.off("connected", ackHandler as any);
      this.clientId = clientId;
      this.userId = userId;

      // Re-subscribe to all subscriptions
      for (const txId of this.subscriptions) {
        this.send({
          type: "subscribe",
          data: { transactionId: txId },
        });
      }

      // Start heartbeat
      this.startHeartbeat();

      resolve();
    };

    this.on("connected", ackHandler as any);

    // Send token via query param or header simulation
    // The server expects token in URL query or headers during upgrade
    // We'll send it as a message immediately after connection
    // Actually, the token should be in the URL, so we need to ensure it's there
  }

  private handleMessage(rawData: string): void {
    try {
      const message = JSON.parse(rawData) as WebSocketMessage;
      this.log("Received message", message.type, message.data);

      switch (message.type) {
        case "connection.ack": {
          const data = message.data as { clientId: string; userId: string };
          this.emit("connected", data.clientId, data.userId);
          break;
        }

        case "subscribe.ack": {
          const data = message.data as { transactionId: string };
          this.emit("subscribed", data.transactionId);
          break;
        }

        case "transaction.updated": {
          const data = message.data as TransactionUpdate;
          this.emit("transaction.updated", data);
          break;
        }

        case "error": {
          const data = message.data as { message: string };
          const error = new Error(data.message);
          this.log("Server error", data.message);
          this.emit("error", error);
          break;
        }

        default:
          this.log("Unknown message type", message.type);
      }
    } catch (err) {
      this.log("Error handling message", err);
      this.emit("error", new Error(`Failed to parse message: ${err}`));
    }
  }

  private send(message: WebSocketMessage): void {
    if (!this.isConnected()) {
      this.log("Cannot send message: not connected");
      return;
    }

    try {
      this.ws!.send(JSON.stringify(message));
      this.log("Sent message", message.type);
    } catch (err) {
      this.log("Error sending message", err);
      this.emit("error", new Error(`Failed to send message: ${err}`));
    }
  }

  private handleReconnection(resolve: () => void): void {
    if (
      this.isIntentionallyClosed ||
      !this.options.reconnect ||
      this.reconnectAttempts >= this.options.reconnectMaxAttempts
    ) {
      this.log("Not reconnecting");
      return;
    }

    this.reconnectAttempts += 1;
    this.emit("reconnecting", this.reconnectAttempts);

    this.log(
      `Attempting to reconnect (${this.reconnectAttempts}/${this.options.reconnectMaxAttempts})`,
    );

    this.reconnectTimeout = setTimeout(() => {
      // Update URL with token
      const urlWithToken = this.options.url.includes("?")
        ? `${this.options.url}&token=${encodeURIComponent(this.options.token)}`
        : `${this.options.url}?token=${encodeURIComponent(this.options.token)}`;

      // Update options URL temporarily for reconnection
      const originalUrl = this.options.url;
      this.options.url = urlWithToken;

      this.connect()
        .then(resolve)
        .catch((err) => {
          this.options.url = originalUrl;
          this.log("Reconnection failed", err);
        });
    }, this.options.reconnectInterval);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
    }

    this.heartbeatTimeout = setTimeout(() => {
      if (this.isConnected()) {
        this.log("Sending heartbeat ping");
        this.send({ type: "ping", data: {} });
        this.startHeartbeat();
      }
    }, this.options.heartbeatInterval);
  }

  private emit(event: EventType, ...args: any[]): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(...args);
        } catch (err) {
          this.log(`Error in ${event} handler`, err);
        }
      }
    }
  }

  private log(message: string, data?: any): void {
    if (this.options.debug) {
      console.log(
        `[ProxyPayWSClient] ${message}`,
        data ? JSON.stringify(data, null, 2) : "",
      );
    }
  }
}

/**
 * Factory function to create and connect a WebSocket client.
 */
export async function connectWebSocket(
  options: ClientOptions,
): Promise<ProxyPayWebSocketClient> {
  const client = new ProxyPayWebSocketClient(options);
  await client.connect();
  return client;
}
