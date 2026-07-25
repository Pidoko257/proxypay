/**
 * Enhanced WebSocket tests covering:
 *  - Connection limits (MAX_CONNECTIONS)
 *  - Per-client message rate limiting
 *  - Client SDK (ProxyPayWebSocketClient) reconnection + subscription recovery
 */

import { createServer, Server } from "http";
import { WebSocket } from "ws";
import jwt from "jsonwebtoken";
import { WebSocketManager } from "../src/websocket/websocketManager";
import { ProxyPayWebSocketClient } from "../src/websocket/client";

const TEST_SECRET = "test-jwt-secret-enhanced";
const TEST_PORT = 9878;

function makeToken(
  payload: object = { userId: "user-enhanced", email: "u@test.com" },
) {
  return jwt.sign(payload, TEST_SECRET, { expiresIn: "1h" });
}

function wsUrl(token?: string): string {
  const base = `ws://localhost:${TEST_PORT}`;
  return token ? `${base}?token=${token}` : base;
}

function waitForMessage(ws: WebSocket, timeoutMs = 2000): Promise<object> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("waitForMessage timeout")),
      timeoutMs,
    );
    ws.once("message", (raw) => {
      clearTimeout(t);
      try {
        resolve(JSON.parse(raw.toString()));
      } catch (e) {
        reject(e);
      }
    });
    ws.once("error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

function waitForClose(
  ws: WebSocket,
  timeoutMs = 3000,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("waitForClose timeout")),
      timeoutMs,
    );
    ws.once("close", (code, reasonBuf) => {
      clearTimeout(t);
      resolve({ code, reason: reasonBuf.toString() });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("WebSocketManager – enhanced features", () => {
  let manager: WebSocketManager;
  let httpServer: Server;
  const openSockets: WebSocket[] = [];

  beforeAll((done) => {
    process.env.JWT_SECRET = TEST_SECRET;
    httpServer = createServer();
    manager = new WebSocketManager(httpServer);
    httpServer.listen(TEST_PORT, done);
  });

  afterAll(async () => {
    // close any lingering sockets
    for (const s of openSockets) {
      if (s.readyState < 2) s.close();
    }
    await manager.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
  }, 20_000);

  // -------------------------------------------------------------------------
  // 1. Connection Limits
  // -------------------------------------------------------------------------

  describe("connection limits", () => {
    it("exposes MAX_CONNECTIONS constant", () => {
      expect(WebSocketManager.MAX_CONNECTIONS).toBeGreaterThan(0);
    });

    it("rejects new connections when at capacity (code 1013)", async () => {
      // Temporarily patch the limit down to 1 so we can trigger it quickly
      const original = WebSocketManager.MAX_CONNECTIONS;
      Object.defineProperty(WebSocketManager, "MAX_CONNECTIONS", {
        value: 1,
        writable: true,
        configurable: true,
      });

      // First connection should succeed
      const ws1 = new WebSocket(wsUrl(makeToken({ userId: "cap-u1", email: "a@b.com" })));
      openSockets.push(ws1);
      await waitForMessage(ws1); // connection.ack

      // Second connection should be rejected (over cap)
      const ws2 = new WebSocket(wsUrl(makeToken({ userId: "cap-u2", email: "b@b.com" })));
      openSockets.push(ws2);
      const { code } = await waitForClose(ws2);
      expect(code).toBe(1013);

      ws1.close();
      // Restore original limit
      Object.defineProperty(WebSocketManager, "MAX_CONNECTIONS", {
        value: original,
        writable: true,
        configurable: true,
      });
      await sleep(100);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Rate Limiting
  // -------------------------------------------------------------------------

  describe("rate limiting", () => {
    it("returns a RATE_LIMIT_EXCEEDED error when client sends too many messages", async () => {
      const ws = new WebSocket(wsUrl(makeToken({ userId: "rl-user", email: "rl@test.com" })));
      openSockets.push(ws);
      await waitForMessage(ws); // connection.ack

      // Collect all messages received
      const received: Array<{ type: string; data: any }> = [];
      ws.on("message", (raw) => {
        try {
          received.push(JSON.parse(raw.toString()));
        } catch {}
      });

      // Send more than RATE_LIMIT_MAX_MESSAGES (10) in one burst
      for (let i = 0; i < 15; i++) {
        ws.send(JSON.stringify({ type: "subscribe", data: { transactionId: `tx-rl-${i}` } }));
      }

      await sleep(500);

      const rateLimitErrors = received.filter(
        (m) => m.type === "error" && m.data?.code === "RATE_LIMIT_EXCEEDED",
      );
      expect(rateLimitErrors.length).toBeGreaterThan(0);
      ws.close();
    });

    it("disconnects client after repeated rate limit violations", async () => {
      const ws = new WebSocket(
        wsUrl(makeToken({ userId: "rl-ban", email: "rlban@test.com" })),
      );
      openSockets.push(ws);
      await waitForMessage(ws); // connection.ack

      // Keep sending bursts until we trigger MAX_VIOLATIONS (3) — each burst exceeds the window
      for (let burst = 0; burst < 4; burst++) {
        for (let i = 0; i < 15; i++) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({ type: "subscribe", data: { transactionId: `tx-ban-${burst}-${i}` } }),
            );
          }
        }
        // Brief pause so the next burst lands in a new rate window
        await sleep(50);
      }

      // Eventually the server should disconnect the client
      const close = await waitForClose(ws, 5000).catch(() => ({ code: 0, reason: "" }));
      // code 1008 (policy violation) or 1000 on clean close
      expect([1000, 1008]).toContain(close.code);
    });
  });

  // -------------------------------------------------------------------------
  // 3. getConnectionStats
  // -------------------------------------------------------------------------

  describe("getConnectionStats", () => {
    it("increments rejectedConnections when capacity is hit", async () => {
      const original = WebSocketManager.MAX_CONNECTIONS;
      Object.defineProperty(WebSocketManager, "MAX_CONNECTIONS", {
        value: 0,
        writable: true,
        configurable: true,
      });

      const beforeStats = manager.getConnectionStats();
      const ws = new WebSocket(wsUrl(makeToken({ userId: "stats-u", email: "s@s.com" })));
      openSockets.push(ws);
      await waitForClose(ws);

      const afterStats = manager.getConnectionStats();
      expect(afterStats.rejectedConnections).toBeGreaterThan(
        beforeStats.rejectedConnections,
      );

      Object.defineProperty(WebSocketManager, "MAX_CONNECTIONS", {
        value: original,
        writable: true,
        configurable: true,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// ProxyPayWebSocketClient SDK tests
// ---------------------------------------------------------------------------

describe("ProxyPayWebSocketClient SDK", () => {
  let manager: WebSocketManager;
  let httpServer: Server;
  const SDK_PORT = 9879;

  beforeAll((done) => {
    process.env.JWT_SECRET = TEST_SECRET;
    httpServer = createServer();
    manager = new WebSocketManager(httpServer);
    httpServer.listen(SDK_PORT, done);
  });

  afterAll(async () => {
    await manager.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
  }, 15_000);

  it("connects and receives connection.ack, emitting 'connect' event", (done) => {
    const token = makeToken({ userId: "sdk-u1", email: "sdk@test.com" });
    const client = new ProxyPayWebSocketClient(
      `ws://localhost:${SDK_PORT}`,
      token,
    );
    client.on("connect", () => {
      expect(client.isConnected).toBe(true);
      client.disconnect();
      done();
    });
    client.connect();
  });

  it("subscribes to a transaction and receives updates", (done) => {
    const token = makeToken({ userId: "sdk-u2", email: "sdk2@test.com" });
    const client = new ProxyPayWebSocketClient(
      `ws://localhost:${SDK_PORT}`,
      token,
    );

    client.on("connect", () => {
      client.subscribe("tx-sdk-001");
    });

    client.on("transaction.updated", (payload) => {
      expect(payload.id).toBe("tx-sdk-001");
      expect(payload.status).toBe("completed");
      client.disconnect();
      done();
    });

    client.connect();

    // Broadcast after a short delay to give the client time to subscribe
    setTimeout(() => {
      manager.broadcastTransactionUpdate({
        id: "tx-sdk-001",
        status: "completed",
      });
    }, 300);
  });

  it("recovers subscriptions after reconnect", (done) => {
    const token = makeToken({ userId: "sdk-u3", email: "sdk3@test.com" });
    const client = new ProxyPayWebSocketClient(
      `ws://localhost:${SDK_PORT}`,
      token,
      { initialReconnectDelayMs: 100, debug: false },
    );

    let connectCount = 0;

    client.on("connect", () => {
      connectCount++;

      if (connectCount === 1) {
        // Subscribe, then force a disconnect
        client.subscribe("tx-recovery");
        // Brutally close the internal socket after 200 ms
        setTimeout(() => {
          (client as any).ws?.close(1001, "test disconnect");
        }, 200);
      }

      if (connectCount === 2) {
        // After reconnect, subscription should have been re-sent — broadcast and verify
        setTimeout(() => {
          manager.broadcastTransactionUpdate({
            id: "tx-recovery",
            status: "processing",
          });
        }, 200);
      }
    });

    client.on("transaction.updated", (payload) => {
      if (payload.id === "tx-recovery" && connectCount === 2) {
        expect(payload.status).toBe("processing");
        client.disconnect();
        done();
      }
    });

    client.connect();
  }, 10_000);

  it("does not reconnect after explicit disconnect()", (done) => {
    const token = makeToken({ userId: "sdk-u4", email: "sdk4@test.com" });
    const client = new ProxyPayWebSocketClient(
      `ws://localhost:${SDK_PORT}`,
      token,
      { initialReconnectDelayMs: 100 },
    );

    client.on("connect", () => {
      client.disconnect();

      // Wait long enough that a reconnect attempt would have fired
      setTimeout(() => {
        expect(client.isConnected).toBe(false);
        expect(client.connectionAttempts).toBe(0);
        done();
      }, 500);
    });

    client.connect();
  });

  it("respects maxReconnectAttempts option", (done) => {
    const token = makeToken({ userId: "sdk-u5", email: "sdk5@test.com" });
    // Point at a non-existent port to force immediate failures
    const client = new ProxyPayWebSocketClient(
      `ws://localhost:19999`,
      token,
      { initialReconnectDelayMs: 50, maxReconnectAttempts: 2 },
    );

    client.on("error", () => {/* expected */});

    client.connect();

    // After enough time for 2 attempts + delays, reconnect should stop
    setTimeout(() => {
      expect(client.connectionAttempts).toBeLessThanOrEqual(2);
      client.disconnect();
      done();
    }, 1500);
  }, 5_000);
});
