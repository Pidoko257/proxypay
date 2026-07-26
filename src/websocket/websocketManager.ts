import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage, Server } from "http";
import { createClient, RedisClientType } from "redis";
import { verifyToken } from "../auth/jwt";
import { Counter, Gauge, Histogram } from "prom-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebSocketMessage {
  type: string;
  data: unknown;
}

export interface TransactionUpdatePayload {
  id: string;
  status: string;
  userId?: string | null;
  [key: string]: unknown;
}

interface AuthenticatedWebSocket extends WebSocket {
  isAlive: boolean;
  userId?: string;
  subscriptions: Set<string>;
  missedPings: number; // tracks consecutive missed pongs
  messageCount: number; // message counter for rate limiting
  lastMessageTime: number; // timestamp of last message for rate limiting
  connectedAt: number; // connection timestamp
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const wsConnectionsTotal = new Counter({
  name: "ws_connections_total",
  help: "Total number of WebSocket connections established",
});

const wsActiveConnections = new Gauge({
  name: "ws_active_connections",
  help: "Number of currently active WebSocket connections",
});

const wsMessagesReceived = new Counter({
  name: "ws_messages_received_total",
  help: "Total number of messages received via WebSocket",
  labelNames: ["type"],
});

const wsMessagesSent = new Counter({
  name: "ws_messages_sent_total",
  help: "Total number of messages sent via WebSocket",
  labelNames: ["type"],
});

const wsRateLimitExceeded = new Counter({
  name: "ws_rate_limit_exceeded_total",
  help: "Number of times rate limit was exceeded",
});

const wsConnectionDuration = new Histogram({
  name: "ws_connection_duration_seconds",
  help: "Connection duration in seconds",
  buckets: [1, 5, 10, 30, 60, 300, 600, 1800, 3600],
});

// ---------------------------------------------------------------------------
// WebSocket Manager
// ---------------------------------------------------------------------------

/**
 * WebSocketManager sets up a WebSocket server attached to an existing HTTP
 * server. It supports:
 *  - JWT-based authentication on connection
 *  - Per-transaction subscriptions
 *  - Broadcasting transaction status updates to subscribed clients
 *  - Heartbeat / ping-pong to clean up stale connections
 *  - Redis pub/sub for horizontal scaling across multiple process instances
 *  - Connection limits per user
 *  - Rate limiting on message handling
 *  - Prometheus metrics for monitoring
 */
export class WebSocketManager {
  private static activeInstance: WebSocketManager | null = null;

  private wss: WebSocketServer;
  private clients: Map<string, AuthenticatedWebSocket> = new Map();
  // Map of userId -> Set of client IDs for per-user broadcasts
  private userRooms: Map<string, Set<string>> = new Map();
  // Map of transactionId -> Set of client IDs subscribed to that transaction
  private subscriptions: Map<string, Set<string>> = new Map();
  // Map of userId -> number of active connections for rate limiting
  private userConnectionCounts: Map<string, number> = new Map();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private redisSub: RedisClientType | null = null;
  private redisPub: RedisClientType | null = null;
  public redisReady: Promise<void>;

  private readonly REDIS_CHANNEL = "transaction.updates";
  private readonly HEARTBEAT_INTERVAL_MS = 10_000; // faster heartbeat for quicker stale detection
  private readonly MAX_MISSED_PINGS = 2; // number of missed pings before termination
  private readonly MAX_CONNECTIONS_PER_USER = parseInt(
    process.env.WS_MAX_CONNECTIONS_PER_USER || "5",
  );
  private readonly RATE_LIMIT_WINDOW_MS = parseInt(
    process.env.WS_RATE_LIMIT_WINDOW_MS || "1000",
  );
  private readonly RATE_LIMIT_MAX_MESSAGES = parseInt(
    process.env.WS_RATE_LIMIT_MAX_MESSAGES || "10",
  );
  private readonly MAX_TOTAL_CONNECTIONS = parseInt(
    process.env.WS_MAX_TOTAL_CONNECTIONS || "10000",
  );

  constructor(httpServer: Server) {
    this.wss = new WebSocketServer({ server: httpServer });
    WebSocketManager.activeInstance = this;
    this.init();
    this.startHeartbeat();
    this.redisReady = this.setupRedis().catch((err) =>
      console.warn("Redis pub/sub unavailable, running without it:", err),
    );
  }

  // -------------------------------------------------------------------------
  // Initialisation
  // -------------------------------------------------------------------------

  private init(): void {
    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      const client = ws as AuthenticatedWebSocket;
      client.isAlive = true;
      client.subscriptions = new Set();
      client.missedPings = 0; // initialize missed ping counter
      client.messageCount = 0;
      client.lastMessageTime = Date.now();
      client.connectedAt = Date.now();

      // Check total connection limit
      if (this.clients.size >= this.MAX_TOTAL_CONNECTIONS) {
        client.close(1008, "Server at connection capacity");
        return;
      }

      // Authenticate the client
      const token = this.extractToken(req);
      if (!token) {
        client.close(1008, "Authentication required");
        return;
      }

      try {
        const decoded = verifyToken(token) as unknown as Record<string, unknown>;
        const candidateUserId =
          typeof decoded.userId === "string"
            ? decoded.userId
            : typeof decoded.sub === "string"
              ? decoded.sub
              : null;

        if (!candidateUserId) {
          client.close(1008, "Invalid authentication payload");
          return;
        }

        client.userId = candidateUserId;
      } catch {
        client.close(1008, "Invalid or expired token");
        return;
      }

      // Check per-user connection limit
      const userConnectionCount = this.userConnectionCounts.get(client.userId) || 0;
      if (userConnectionCount >= this.MAX_CONNECTIONS_PER_USER) {
        client.close(1008, `Maximum connections per user exceeded (${this.MAX_CONNECTIONS_PER_USER})`);
        return;
      }

      // Increment user connection count
      this.userConnectionCounts.set(client.userId, userConnectionCount + 1);

      const clientId = `${client.userId}::${Date.now()}::${Math.random().toString(36).substr(2, 9)}`;
      this.clients.set(clientId, client);
      this.joinUserRoom(client.userId, clientId);

      // Update metrics
      wsConnectionsTotal.inc();
      wsActiveConnections.set(this.clients.size);

      console.log(`WebSocket client connected: ${clientId} (${this.clients.size} active)`);

      // Handle pong responses to the heartbeat
      client.on("pong", () => {
        client.isAlive = true;
      });

      // Handle incoming messages from client
      client.on("message", (rawData) => {
        this.handleMessage(clientId, client, rawData.toString());
      });

      // Cleanup on disconnect
      client.on("close", () => {
        this.handleDisconnect(clientId, client);
      });

      client.on("error", (err) => {
        console.error(`WebSocket client error (${clientId}):`, err);
      });

      // Acknowledge connection
      this.sendToClient(client, {
        type: "connection.ack",
        data: { clientId, userId: client.userId },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  private isRateLimited(client: AuthenticatedWebSocket): boolean {
    const now = Date.now();
    const timeSinceLastMessage = now - client.lastMessageTime;

    // Reset counter if outside the window
    if (timeSinceLastMessage > this.RATE_LIMIT_WINDOW_MS) {
      client.messageCount = 0;
    }

    client.lastMessageTime = now;
    client.messageCount += 1;

    return client.messageCount > this.RATE_LIMIT_MAX_MESSAGES;
  }

  private handleMessage(
    clientId: string,
    client: AuthenticatedWebSocket,
    rawData: string,
  ): void {
    // Check rate limit
    if (this.isRateLimited(client)) {
      wsRateLimitExceeded.inc();
      this.sendToClient(client, {
        type: "error",
        data: { message: "Rate limit exceeded" },
      });
      return;
    }

    let message: WebSocketMessage;

    try {
      message = JSON.parse(rawData) as WebSocketMessage;
    } catch {
      this.sendToClient(client, {
        type: "error",
        data: { message: "Invalid JSON payload" },
      });
      return;
    }

    wsMessagesReceived.labels(message.type).inc();

    switch (message.type) {
      case "subscribe": {
        const payload = message.data as { transactionId: string };
        if (!payload?.transactionId) break;
        this.subscribe(clientId, payload.transactionId);
        this.sendToClient(client, {
          type: "subscribe.ack",
          data: { transactionId: payload.transactionId },
        });
        break;
      }

      case "unsubscribe": {
        const payload = message.data as { transactionId: string };
        if (!payload?.transactionId) break;
        this.unsubscribe(clientId, client, payload.transactionId);
        break;
      }

      default:
        this.sendToClient(client, {
          type: "error",
          data: { message: `Unknown message type: ${message.type}` },
        });
    }
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  private subscribe(clientId: string, transactionId: string): void {
    if (!this.subscriptions.has(transactionId)) {
      this.subscriptions.set(transactionId, new Set());
    }
    this.subscriptions.get(transactionId)!.add(clientId);

    const client = this.clients.get(clientId);
    if (client) {
      client.subscriptions.add(transactionId);
    }
  }

  private joinUserRoom(userId: string, clientId: string): void {
    if (!this.userRooms.has(userId)) {
      this.userRooms.set(userId, new Set());
    }
    this.userRooms.get(userId)!.add(clientId);
  }

  private leaveUserRoom(userId: string | undefined, clientId: string): void {
    if (!userId) return;

    const room = this.userRooms.get(userId);
    if (!room) return;

    room.delete(clientId);
    if (room.size === 0) {
      this.userRooms.delete(userId);
    }
  }

  private unsubscribe(
    clientId: string,
    client: AuthenticatedWebSocket,
    transactionId: string,
  ): void {
    this.subscriptions.get(transactionId)?.delete(clientId);
    client.subscriptions.delete(transactionId);
  }

  // -------------------------------------------------------------------------
  // Broadcasting
  // -------------------------------------------------------------------------

  /**
   * Broadcast a transaction update to all clients subscribed to the given
   * transaction. Also publishes to Redis so other server instances pick it up.
   */
  async broadcastTransactionUpdate(
    payload: TransactionUpdatePayload,
  ): Promise<void> {
    const message: WebSocketMessage = {
      type: "transaction.updated",
      data: payload,
    };

    // Publish to Redis for inter-process distribution
    if (this.redisPub) {
      try {
        await this.redisPub.publish(
          this.REDIS_CHANNEL,
          JSON.stringify({
            transactionId: payload.id,
            userId: payload.userId ?? null,
            message,
          }),
        );
      } catch (err) {
        console.warn("Redis publish failed, broadcasting locally only:", err);
      }
    }

    if (payload.userId) {
      this.broadcastToUserLocally(payload.userId, message);
      return;
    }

    this.broadcastLocally(payload.id, message);
  }

  /** Send a message to all locally-connected clients subscribed to transactionId. */
  private broadcastLocally(
    transactionId: string,
    message: WebSocketMessage,
  ): void {
    const subscribedClientIds = this.subscriptions.get(transactionId);
    if (!subscribedClientIds) return;

    for (const clientId of subscribedClientIds) {
      const client = this.clients.get(clientId);
      if (client && client.readyState === WebSocket.OPEN) {
        this.sendToClient(client, message);
      }
    }
  }

  /** Send a message to all locally-connected clients for a specific user. */
  private broadcastToUserLocally(
    userId: string,
    message: WebSocketMessage,
  ): void {
    const roomClientIds = this.userRooms.get(userId);
    if (!roomClientIds) return;

    for (const clientId of roomClientIds) {
      const client = this.clients.get(clientId);
      if (client && client.readyState === WebSocket.OPEN) {
        this.sendToClient(client, message);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private sendToClient(client: WebSocket, message: WebSocketMessage): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
      wsMessagesSent.labels(message.type).inc();
    }
  }

  private extractToken(req: IncomingMessage): string | null {
    // Accept token via ?token= query param or Authorization: Bearer header
    const url = new URL(req.url ?? "/", "ws://localhost");
    const queryToken = url.searchParams.get("token");
    if (queryToken) return queryToken;

    const authHeader = req.headers["authorization"] ?? "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    return match ? match[1] : null;
  }

  private handleDisconnect(
    clientId: string,
    client: AuthenticatedWebSocket,
  ): void {
    // Remove client from all subscription maps
    for (const transactionId of client.subscriptions) {
      this.subscriptions.get(transactionId)?.delete(clientId);
    }
    this.leaveUserRoom(client.userId, clientId);
    this.clients.delete(clientId);

    // Update user connection count
    if (client.userId) {
      const currentCount = this.userConnectionCounts.get(client.userId) || 1;
      if (currentCount <= 1) {
        this.userConnectionCounts.delete(client.userId);
      } else {
        this.userConnectionCounts.set(client.userId, currentCount - 1);
      }
    }

    // Record connection duration metric
    const durationSeconds = (Date.now() - client.connectedAt) / 1000;
    wsConnectionDuration.observe(durationSeconds);

    // Update active connections gauge
    wsActiveConnections.set(this.clients.size);

    console.log(`WebSocket client disconnected: ${clientId} (duration: ${durationSeconds}s, ${this.clients.size} active)`);
  }

  // -------------------------------------------------------------------------
  // Heartbeat – detect and clean up stale connections
  // -------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      for (const [clientId, client] of this.clients) {
        if (!client.isAlive) {
          client.missedPings += 1;
          if (client.missedPings >= this.MAX_MISSED_PINGS) {
            console.log(`Terminating stale WebSocket client after ${client.missedPings} missed pings: ${clientId}`);
            client.terminate();
            this.handleDisconnect(clientId, client);
            continue;
          }
        } else {
          client.missedPings = 0; // reset on successful pong
        }
        client.isAlive = false;
        client.ping();
      }
    }, this.HEARTBEAT_INTERVAL_MS);
  }

  // -------------------------------------------------------------------------
  // Redis pub/sub for horizontal scaling
  // -------------------------------------------------------------------------

  private async setupRedis(): Promise<void> {
    if (!process.env.REDIS_URL) return;

    this.redisPub = createClient({
      url: process.env.REDIS_URL,
    }) as RedisClientType;

    this.redisSub = createClient({
      url: process.env.REDIS_URL,
    }) as RedisClientType;

    await this.redisPub.connect();
    await this.redisSub.connect();

    await this.redisSub.subscribe(this.REDIS_CHANNEL, (rawMessage: string) => {
      try {
        const { transactionId, userId, message } = JSON.parse(rawMessage) as {
          transactionId: string;
          userId?: string | null;
          message: WebSocketMessage;
        };

        if (typeof userId === "string" && userId.length > 0) {
          this.broadcastToUserLocally(userId, message);
          return;
        }

        // Only broadcast locally – the publishing instance already did so
        this.broadcastLocally(transactionId, message);
      } catch (err) {
        console.error("Failed to handle Redis message:", err);
      }
    });

    console.log("WebSocket: Redis pub/sub connected");
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    await this.redisSub?.unsubscribe();
    await this.redisSub?.disconnect();
    await this.redisPub?.disconnect();
    this.wss.close();

    if (WebSocketManager.activeInstance === this) {
      WebSocketManager.activeInstance = null;
    }
  }

  /** Returns the number of currently connected clients. */
  get connectionCount(): number {
    return this.clients.size;
  }

  /** Returns the number of active connections for a specific user. */
  getUserConnectionCount(userId: string): number {
    return this.userConnectionCounts.get(userId) || 0;
  }

  /** Returns metrics object for monitoring. */
  getMetrics() {
    return {
      activeConnections: this.clients.size,
      maxConnectionsPerUser: this.MAX_CONNECTIONS_PER_USER,
      maxTotalConnections: this.MAX_TOTAL_CONNECTIONS,
      rateLimitWindowMs: this.RATE_LIMIT_WINDOW_MS,
      rateLimitMaxMessages: this.RATE_LIMIT_MAX_MESSAGES,
      userRoomCount: this.userRooms.size,
      subscriptionCount: this.subscriptions.size,
      totalSubscriptions: Array.from(this.subscriptions.values()).reduce(
        (sum, set) => sum + set.size,
        0,
      ),
    };
  }

  static getInstance(): WebSocketManager | null {
    return WebSocketManager.activeInstance;
  }
}
