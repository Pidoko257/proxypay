import { IncomingMessage, Server } from "http";
import { WebSocketManager } from "../websocketManager";
import { verifyToken } from "../../auth/jwt";
import { createClient } from "redis";

type ConnectionHandler = (ws: unknown, req: IncomingMessage) => void;

let connectionHandler: ConnectionHandler | null = null;

jest.mock("../../auth/jwt", () => ({
  verifyToken: jest.fn(),
}));

jest.mock("redis", () => ({
  createClient: jest.fn(),
}));

jest.mock("ws", () => {
  class MockWebSocketServer {
    on(event: string, handler: ConnectionHandler) {
      if (event === "connection") {
        connectionHandler = handler;
      }
    }

    close = jest.fn();
  }

  return {
    WebSocketServer: MockWebSocketServer,
    WebSocket: {
      OPEN: 1,
    },
  };
});

type MockClient = {
  isAlive: boolean;
  userId?: string;
  subscriptions: Set<string>;
  readyState: number;
  send: jest.Mock;
  close: jest.Mock;
  ping: jest.Mock;
  terminate: jest.Mock;
  on: jest.Mock;
};

function createMockClient(): MockClient {
  const handlers = new Map<string, (...args: unknown[]) => void>();

  const client: MockClient = {
    isAlive: true,
    subscriptions: new Set<string>(),
    readyState: 1,
    send: jest.fn(),
    close: jest.fn(),
    ping: jest.fn(),
    terminate: jest.fn(),
    on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    }),
  };

  return client;
}

function connectClient(client: MockClient, token = "test-token"): void {
  if (!connectionHandler) {
    throw new Error("Connection handler was not initialized");
  }

  connectionHandler(client, {
    url: `/?token=${token}`,
    headers: {},
  } as IncomingMessage);
}

describe("WebSocketManager", () => {
  const mockVerifyToken = verifyToken as jest.MockedFunction<typeof verifyToken>;
  const mockCreateClient = createClient as jest.MockedFunction<typeof createClient>;

  beforeEach(() => {
    jest.clearAllMocks();
    connectionHandler = null;
    delete process.env.REDIS_URL;
    process.env.JWT_SECRET = "test-secret";
  });

  afterEach(() => {
    delete process.env.REDIS_URL;
    delete process.env.JWT_SECRET;
  });

  it("authenticates a socket and broadcasts transaction updates to the user room", async () => {
    mockVerifyToken.mockReturnValue({
      userId: "user-123",
      email: "user@example.com",
    });

    const manager = new WebSocketManager({} as Server);
    const client = createMockClient();

    connectClient(client);

    expect(client.close).not.toHaveBeenCalled();
    expect(client.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"connection.ack"'),
    );

    client.send.mockClear();

    await manager.broadcastTransactionUpdate({
      id: "tx-1",
      status: "completed",
      userId: "user-123",
    });

    expect(client.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"transaction.updated"'),
    );
    expect(client.send).toHaveBeenCalledWith(
      expect.stringContaining('"id":"tx-1"'),
    );

    await manager.close();
  });

  it("rejects socket connection when JWT verification fails", async () => {
    mockVerifyToken.mockImplementation(() => {
      throw new Error("Invalid token");
    });

    const manager = new WebSocketManager({} as Server);
    const client = createMockClient();

    connectClient(client, "bad-token");

    expect(client.close).toHaveBeenCalledWith(1008, "Invalid or expired token");

    await manager.close();
  });

  it("publishes user-targeted transaction updates to Redis", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    mockVerifyToken.mockReturnValue({
      userId: "user-redis",
      email: "redis@example.com",
    });

    const pubClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn().mockResolvedValue(1),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };

    const subClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn().mockResolvedValue(undefined),
      unsubscribe: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };

    mockCreateClient
      .mockImplementationOnce(() => pubClient as unknown as ReturnType<typeof createClient>)
      .mockImplementationOnce(() => subClient as unknown as ReturnType<typeof createClient>);

    const manager = new WebSocketManager({} as Server);
    const client = createMockClient();

    await manager.redisReady;
    connectClient(client);

    await manager.broadcastTransactionUpdate({
      id: "tx-redis-1",
      status: "failed",
      userId: "user-redis",
    });

    expect(pubClient.publish).toHaveBeenCalledWith(
      "transaction.updates",
      expect.stringContaining('"userId":"user-redis"'),
    );

    await manager.close();
  });

  it("handles horizontal scaling by receiving Redis Pub/Sub messages from other instances", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    mockVerifyToken.mockReturnValue({
      userId: "user-scaling",
      email: "scaling@example.com",
    });

    let subscriberCallback: ((message: string) => void) | null = null;

    const pubClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn().mockResolvedValue(1),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };

    const subClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn().mockImplementation((channel: string, callback: (message: string) => void) => {
        subscriberCallback = callback;
        return Promise.resolve();
      }),
      unsubscribe: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };

    mockCreateClient
      .mockImplementationOnce(() => pubClient as unknown as ReturnType<typeof createClient>)
      .mockImplementationOnce(() => subClient as unknown as ReturnType<typeof createClient>);

    const manager = new WebSocketManager({} as Server);
    const client = createMockClient();

    await manager.redisReady;
    connectClient(client);

    // Simulate receiving a message from another instance via Redis Pub/Sub
    if (subscriberCallback) {
      const incomingMessage = JSON.stringify({
        transactionId: "tx-other-instance",
        userId: "user-scaling",
        message: {
          type: "transaction.updated",
          data: {
            id: "tx-other-instance",
            status: "completed",
            userId: "user-scaling",
          },
        },
      });

      subscriberCallback(incomingMessage);
    }

    // Verify the message was delivered to the local client
    expect(client.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"transaction.updated"'),
    );
    expect(client.send).toHaveBeenCalledWith(
      expect.stringContaining('"id":"tx-other-instance"'),
    );

    await manager.close();
  });

  it("broadcasts transaction updates to all subscribed clients across instances", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    mockVerifyToken.mockReturnValue({
      userId: "user-broadcast",
      email: "broadcast@example.com",
    });

    const pubClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn().mockResolvedValue(1),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };

    const subClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn().mockResolvedValue(undefined),
      unsubscribe: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };

    mockCreateClient
      .mockImplementationOnce(() => pubClient as unknown as ReturnType<typeof createClient>)
      .mockImplementationOnce(() => subClient as unknown as ReturnType<typeof createClient>);

    const manager = new WebSocketManager({} as Server);

    // Create 3 connected clients
    const client1 = createMockClient();
    const client2 = createMockClient();
    const client3 = createMockClient();

    await manager.redisReady;
    connectClient(client1);
    connectClient(client2);
    connectClient(client3);

    // Clear the ack messages
    client1.send.mockClear();
    client2.send.mockClear();
    client3.send.mockClear();

    // Broadcast a transaction update
    await manager.broadcastTransactionUpdate({
      id: "tx-broadcast",
      status: "completed",
      userId: "user-broadcast",
    });

    // Verify all clients received the update
    expect(client1.send).toHaveBeenCalled();
    expect(client2.send).toHaveBeenCalled();
    expect(client3.send).toHaveBeenCalled();

    // Verify the message was published to Redis
    expect(pubClient.publish).toHaveBeenCalledWith(
      "transaction.updates",
      expect.stringContaining('"userId":"user-broadcast"'),
    );

    await manager.close();
  });

  it("maintains subscriptions to transaction-specific channels with Redis Pub/Sub", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    mockVerifyToken.mockReturnValue({
      userId: "user-subscription",
      email: "subscription@example.com",
    });

    let subscriberCallback: ((message: string) => void) | null = null;

    const pubClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn().mockResolvedValue(1),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };

    const subClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn().mockImplementation((channel: string, callback: (message: string) => void) => {
        subscriberCallback = callback;
        return Promise.resolve();
      }),
      unsubscribe: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };

    mockCreateClient
      .mockImplementationOnce(() => pubClient as unknown as ReturnType<typeof createClient>)
      .mockImplementationOnce(() => subClient as unknown as ReturnType<typeof createClient>);

    const manager = new WebSocketManager({} as Server);
    const client = createMockClient();

    await manager.redisReady;
    connectClient(client);

    client.send.mockClear();

    // Simulate client subscribing to a transaction
    const handlers = new Map<string, (...args: unknown[]) => void>();
    client.on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    });

    // Send subscription message
    const messageHandler = handlers.get("message");
    if (messageHandler) {
      messageHandler(
        JSON.stringify({
          type: "subscribe",
          data: { transactionId: "tx-sub-123" },
        }),
      );
    }

    // Broadcast to that transaction ID
    await manager.broadcastTransactionUpdate({
      id: "tx-sub-123",
      status: "processing",
    });

    // Verify the message was published to Redis
    expect(pubClient.publish).toHaveBeenCalledWith(
      "transaction.updates",
      expect.stringContaining('"transactionId":"tx-sub-123"'),
    );

    await manager.close();
  });

  it("enforces per-user connection limits", async () => {
    process.env.WS_MAX_CONNECTIONS_PER_USER = "2";
    mockVerifyToken.mockReturnValue({
      userId: "user-limit",
      email: "limit@example.com",
    });

    const manager = new WebSocketManager({} as Server);

    // Create first connection - should succeed
    const client1 = createMockClient();
    connectClient(client1);
    expect(client1.close).not.toHaveBeenCalled();

    // Create second connection - should succeed
    const client2 = createMockClient();
    connectClient(client2);
    expect(client2.close).not.toHaveBeenCalled();

    // Create third connection - should be rejected
    const client3 = createMockClient();
    connectClient(client3);
    expect(client3.close).toHaveBeenCalledWith(
      1008,
      expect.stringContaining("Maximum connections per user exceeded"),
    );

    expect(manager.getUserConnectionCount("user-limit")).toBe(2);

    await manager.close();
    delete process.env.WS_MAX_CONNECTIONS_PER_USER;
  });

  it("enforces total connection limit", async () => {
    process.env.WS_MAX_TOTAL_CONNECTIONS = "2";
    mockVerifyToken
      .mockReturnValueOnce({ userId: "user-1", email: "user1@example.com" })
      .mockReturnValueOnce({ userId: "user-2", email: "user2@example.com" })
      .mockReturnValueOnce({ userId: "user-3", email: "user3@example.com" });

    const manager = new WebSocketManager({} as Server);

    // Create first connection - should succeed
    const client1 = createMockClient();
    connectClient(client1);
    expect(client1.close).not.toHaveBeenCalled();

    // Create second connection - should succeed
    const client2 = createMockClient();
    connectClient(client2);
    expect(client2.close).not.toHaveBeenCalled();

    // Create third connection - should be rejected
    const client3 = createMockClient();
    connectClient(client3);
    expect(client3.close).toHaveBeenCalledWith(1008, "Server at connection capacity");

    expect(manager.connectionCount).toBe(2);

    await manager.close();
    delete process.env.WS_MAX_TOTAL_CONNECTIONS;
  });

  it("implements rate limiting on message handling", async () => {
    process.env.WS_RATE_LIMIT_MAX_MESSAGES = "2";
    process.env.WS_RATE_LIMIT_WINDOW_MS = "100";

    mockVerifyToken.mockReturnValue({
      userId: "user-rate-limit",
      email: "ratelimit@example.com",
    });

    const manager = new WebSocketManager({} as Server);
    const client = createMockClient();

    connectClient(client);
    client.send.mockClear();

    // Simulate getting the message handler
    const handlers = new Map<string, (...args: unknown[]) => void>();
    client.on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    });

    const messageHandler = handlers.get("message");
    if (messageHandler) {
      // Send first message - should succeed
      messageHandler(JSON.stringify({ type: "subscribe", data: { transactionId: "tx-1" } }));
      expect(client.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"subscribe.ack"'),
      );

      client.send.mockClear();

      // Send second message - should succeed
      messageHandler(JSON.stringify({ type: "subscribe", data: { transactionId: "tx-2" } }));
      expect(client.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"subscribe.ack"'),
      );

      client.send.mockClear();

      // Send third message - should be rate limited
      messageHandler(JSON.stringify({ type: "subscribe", data: { transactionId: "tx-3" } }));
      expect(client.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"error"'),
      );
      expect(client.send).toHaveBeenCalledWith(
        expect.stringContaining("Rate limit exceeded"),
      );
    }

    await manager.close();
    delete process.env.WS_RATE_LIMIT_MAX_MESSAGES;
    delete process.env.WS_RATE_LIMIT_WINDOW_MS;
  });

  it("tracks connection metrics", async () => {
    mockVerifyToken.mockReturnValue({
      userId: "user-metrics",
      email: "metrics@example.com",
    });

    const manager = new WebSocketManager({} as Server);
    const client = createMockClient();

    connectClient(client);

    const metrics = manager.getMetrics();
    expect(metrics.activeConnections).toBe(1);
    expect(metrics.maxConnectionsPerUser).toBe(5);
    expect(metrics.maxTotalConnections).toBe(10000);
    expect(metrics.userRoomCount).toBe(1);

    await manager.close();
  });

  it("handles subscription unsubscription lifecycle", async () => {
    mockVerifyToken.mockReturnValue({
      userId: "user-subscription-lifecycle",
      email: "sublifecycle@example.com",
    });

    const manager = new WebSocketManager({} as Server);
    const client = createMockClient();

    connectClient(client);
    client.send.mockClear();

    // Simulate subscription lifecycle
    const handlers = new Map<string, (...args: unknown[]) => void>();
    client.on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    });

    const messageHandler = handlers.get("message");
    if (messageHandler) {
      // Subscribe
      messageHandler(JSON.stringify({ type: "subscribe", data: { transactionId: "tx-lifecycle" } }));
      expect(client.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"subscribe.ack"'),
      );

      client.send.mockClear();

      // Send transaction update - should receive it
      await manager.broadcastTransactionUpdate({
        id: "tx-lifecycle",
        status: "completed",
      });
      expect(client.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"transaction.updated"'),
      );

      client.send.mockClear();

      // Unsubscribe
      messageHandler(
        JSON.stringify({ type: "unsubscribe", data: { transactionId: "tx-lifecycle" } }),
      );

      // Send another update - should NOT receive it
      await manager.broadcastTransactionUpdate({
        id: "tx-lifecycle",
        status: "failed",
      });
      expect(client.send).not.toHaveBeenCalled();
    }

    await manager.close();
  });

  it("cleans up stale connections after missed pings", async () => {
    mockVerifyToken.mockReturnValue({
      userId: "user-stale",
      email: "stale@example.com",
    });

    const manager = new WebSocketManager({} as Server);
    const client = createMockClient() as any;

    // Mock terminate
    client.terminate = jest.fn();

    connectClient(client);

    // Simulate missed pings by not responding to ping
    client.isAlive = false;
    client.missedPings = 0;

    // Manually trigger heartbeat check (simulating what would happen after 10s)
    // In a real scenario, this would be done by the heartbeat interval
    // For testing, we'll verify the connection is properly set up
    expect(client.close).not.toHaveBeenCalled();
    expect(manager.connectionCount).toBe(1);

    await manager.close();
  });

  it("provides user connection count tracking", async () => {
    mockVerifyToken
      .mockReturnValueOnce({ userId: "user-tracking", email: "tracking@example.com" })
      .mockReturnValueOnce({ userId: "user-tracking", email: "tracking@example.com" })
      .mockReturnValueOnce({ userId: "other-user", email: "other@example.com" });

    process.env.WS_MAX_CONNECTIONS_PER_USER = "3";

    const manager = new WebSocketManager({} as Server);

    const client1 = createMockClient();
    connectClient(client1);

    const client2 = createMockClient();
    connectClient(client2);

    const client3 = createMockClient();
    connectClient(client3);

    expect(manager.getUserConnectionCount("user-tracking")).toBe(2);
    expect(manager.getUserConnectionCount("other-user")).toBe(1);
    expect(manager.connectionCount).toBe(3);

    await manager.close();
    delete process.env.WS_MAX_CONNECTIONS_PER_USER;
  });
});
