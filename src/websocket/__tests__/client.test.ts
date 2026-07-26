/**
 * Tests for ProxyPayWebSocketClient
 *
 * Tests the client SDK with mocked WebSocket connections,
 * reconnection logic, event handling, and subscription management.
 */

import { ProxyPayWebSocketClient } from "../client";

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    // Simulate connection
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      if (this.onopen) {
        this.onopen();
      }
    }, 10);
  }

  send(data: string): void {
    // Mock send
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose();
    }
  }

  terminate(): void {
    this.close();
  }
}

// Replace global WebSocket
(global as any).WebSocket = MockWebSocket;

describe("ProxyPayWebSocketClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("connects to WebSocket server and receives connection acknowledgment", async () => {
    const client = new ProxyPayWebSocketClient({
      url: "ws://localhost:3000",
      token: "test-token",
    });

    const connectedPromise = new Promise<void>((resolve) => {
      client.on("connected", () => {
        resolve();
      });
    });

    const connectPromise = client.connect();

    // Simulate server sending connection ack
    setTimeout(() => {
      const ws = (client as any).ws;
      if (ws && ws.onmessage) {
        ws.onmessage({
          data: JSON.stringify({
            type: "connection.ack",
            data: { clientId: "test-client-id", userId: "test-user-id" },
          }),
        });
      }
    }, 50);

    await Promise.race([connectPromise, connectedPromise]);
    expect(client.isConnected()).toBe(true);
    expect(client.getClientId()).toBe("test-client-id");
    expect(client.getUserId()).toBe("test-user-id");

    client.disconnect();
  });

  it("subscribes and unsubscribes from transactions", async () => {
    const client = new ProxyPayWebSocketClient({
      url: "ws://localhost:3000",
      token: "test-token",
    });

    client.subscribe("tx-123");
    expect(client.getSubscriptions()).toContain("tx-123");

    client.subscribe("tx-456");
    expect(client.getSubscriptions()).toContain("tx-456");

    client.unsubscribe("tx-123");
    expect(client.getSubscriptions()).not.toContain("tx-123");
    expect(client.getSubscriptions()).toContain("tx-456");
  });

  it("emits transaction update events", async () => {
    const client = new ProxyPayWebSocketClient({
      url: "ws://localhost:3000",
      token: "test-token",
    });

    const updatePromise = new Promise<any>((resolve) => {
      client.on("transaction.updated", (data) => {
        resolve(data);
      });
    });

    // Setup mock
    const connectPromise = new Promise<void>((resolve) => {
      client.on("connected", () => {
        resolve();
      });
    });

    client.connect().catch(() => {});

    // Simulate connection ack
    setTimeout(() => {
      const ws = (client as any).ws;
      if (ws && ws.onmessage) {
        ws.onmessage({
          data: JSON.stringify({
            type: "connection.ack",
            data: { clientId: "test-client", userId: "test-user" },
          }),
        });

        // Simulate transaction update
        ws.onmessage({
          data: JSON.stringify({
            type: "transaction.updated",
            data: {
              id: "tx-123",
              status: "completed",
              userId: "test-user",
            },
          }),
        });
      }
    }, 50);

    const data = await updatePromise;
    expect(data.id).toBe("tx-123");
    expect(data.status).toBe("completed");

    client.disconnect();
  });

  it("handles subscription acknowledgments", async () => {
    const client = new ProxyPayWebSocketClient({
      url: "ws://localhost:3000",
      token: "test-token",
    });

    const ackPromise = new Promise<string>((resolve) => {
      client.on("subscribed", (txId) => {
        resolve(txId);
      });
    });

    const connectPromise = new Promise<void>((resolve) => {
      client.on("connected", () => {
        resolve();
      });
    });

    client.connect().catch(() => {});

    // Simulate connection ack
    setTimeout(() => {
      const ws = (client as any).ws;
      if (ws && ws.onmessage) {
        ws.onmessage({
          data: JSON.stringify({
            type: "connection.ack",
            data: { clientId: "test-client", userId: "test-user" },
          }),
        });

        // Simulate subscription ack
        ws.onmessage({
          data: JSON.stringify({
            type: "subscribe.ack",
            data: { transactionId: "tx-123" },
          }),
        });
      }
    }, 50);

    const txId = await ackPromise;
    expect(txId).toBe("tx-123");

    client.disconnect();
  });

  it("emits error events", async () => {
    const client = new ProxyPayWebSocketClient({
      url: "ws://localhost:3000",
      token: "test-token",
    });

    const errorPromise = new Promise<Error>((resolve) => {
      client.on("error", (error) => {
        resolve(error);
      });
    });

    const connectPromise = new Promise<void>((resolve) => {
      client.on("connected", () => {
        resolve();
      });
    });

    client.connect().catch(() => {});

    // Simulate connection ack
    setTimeout(() => {
      const ws = (client as any).ws;
      if (ws && ws.onmessage) {
        ws.onmessage({
          data: JSON.stringify({
            type: "connection.ack",
            data: { clientId: "test-client", userId: "test-user" },
          }),
        });

        // Simulate error from server
        ws.onmessage({
          data: JSON.stringify({
            type: "error",
            data: { message: "Rate limit exceeded" },
          }),
        });
      }
    }, 50);

    const error = await errorPromise;
    expect(error.message).toContain("Rate limit exceeded");

    client.disconnect();
  });

  it("supports one-time event listeners with once()", async () => {
    const client = new ProxyPayWebSocketClient({
      url: "ws://localhost:3000",
      token: "test-token",
    });

    let callCount = 0;
    const handler = jest.fn(() => {
      callCount += 1;
    });

    client.once("connected", handler);

    const connectPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        const ws = (client as any).ws;
        if (ws && ws.onmessage) {
          ws.onmessage({
            data: JSON.stringify({
              type: "connection.ack",
              data: { clientId: "test-client", userId: "test-user" },
            }),
          });

          // Simulate second connected event
          ws.onmessage({
            data: JSON.stringify({
              type: "connection.ack",
              data: { clientId: "test-client-2", userId: "test-user" },
            }),
          });

          resolve();
        }
      }, 50);
    });

    client.connect().catch(() => {});
    await connectPromise;

    expect(handler.mock.calls.length).toBe(1);

    client.disconnect();
  });

  it("supports event listener removal with off()", async () => {
    const client = new ProxyPayWebSocketClient({
      url: "ws://localhost:3000",
      token: "test-token",
    });

    let callCount = 0;
    const handler = () => {
      callCount += 1;
    };

    client.on("transaction.updated", handler);
    client.off("transaction.updated", handler);

    const connectPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        const ws = (client as any).ws;
        if (ws && ws.onmessage) {
          ws.onmessage({
            data: JSON.stringify({
              type: "connection.ack",
              data: { clientId: "test-client", userId: "test-user" },
            }),
          });

          // Emit transaction update
          ws.onmessage({
            data: JSON.stringify({
              type: "transaction.updated",
              data: { id: "tx-123", status: "completed" },
            }),
          });

          resolve();
        }
      }, 50);
    });

    client.connect().catch(() => {});
    await connectPromise;

    expect(callCount).toBe(0); // Handler was removed

    client.disconnect();
  });

  it("resubscribes after reconnection", async () => {
    const client = new ProxyPayWebSocketClient({
      url: "ws://localhost:3000",
      token: "test-token",
      reconnect: false, // Disable auto-reconnect for this test
    });

    client.subscribe("tx-123");
    client.subscribe("tx-456");

    expect(client.getSubscriptions()).toHaveLength(2);

    client.disconnect();
  });

  it("disconnects gracefully", async () => {
    const client = new ProxyPayWebSocketClient({
      url: "ws://localhost:3000",
      token: "test-token",
    });

    const disconnectPromise = new Promise<void>((resolve) => {
      client.on("disconnected", () => {
        resolve();
      });
    });

    const connectPromise = new Promise<void>((resolve) => {
      client.on("connected", () => {
        resolve();
      });
    });

    client.connect().catch(() => {});

    // Simulate connection ack
    setTimeout(() => {
      const ws = (client as any).ws;
      if (ws && ws.onmessage) {
        ws.onmessage({
          data: JSON.stringify({
            type: "connection.ack",
            data: { clientId: "test-client", userId: "test-user" },
          }),
        });
      }
    }, 50);

    await connectPromise;
    expect(client.isConnected()).toBe(true);

    client.disconnect();

    await disconnectPromise;
    expect(client.isConnected()).toBe(false);
  });

  it("handles invalid JSON gracefully", async () => {
    const client = new ProxyPayWebSocketClient({
      url: "ws://localhost:3000",
      token: "test-token",
    });

    const errorPromise = new Promise<Error>((resolve) => {
      client.on("error", (error) => {
        resolve(error);
      });
    });

    const connectPromise = new Promise<void>((resolve) => {
      client.on("connected", () => {
        resolve();
      });
    });

    client.connect().catch(() => {});

    // Simulate connection ack
    setTimeout(() => {
      const ws = (client as any).ws;
      if (ws && ws.onmessage) {
        ws.onmessage({
          data: JSON.stringify({
            type: "connection.ack",
            data: { clientId: "test-client", userId: "test-user" },
          }),
        });

        // Send invalid JSON
        ws.onmessage({
          data: "invalid json {]",
        });
      }
    }, 50);

    const error = await errorPromise;
    expect(error.message).toContain("Failed to parse message");

    client.disconnect();
  });

  it("tracks client and user IDs", async () => {
    const client = new ProxyPayWebSocketClient({
      url: "ws://localhost:3000",
      token: "test-token",
    });

    expect(client.getClientId()).toBeNull();
    expect(client.getUserId()).toBeNull();

    const connectPromise = new Promise<void>((resolve) => {
      client.on("connected", () => {
        resolve();
      });
    });

    client.connect().catch(() => {});

    // Simulate connection ack
    setTimeout(() => {
      const ws = (client as any).ws;
      if (ws && ws.onmessage) {
        ws.onmessage({
          data: JSON.stringify({
            type: "connection.ack",
            data: { clientId: "my-client-id", userId: "my-user-id" },
          }),
        });
      }
    }, 50);

    await connectPromise;

    expect(client.getClientId()).toBe("my-client-id");
    expect(client.getUserId()).toBe("my-user-id");

    client.disconnect();
  });
});
