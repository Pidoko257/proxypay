# WebSocket Integration Guide

Real-time transaction status updates via WebSocket for ProxyPay.

## Overview

The ProxyPay WebSocket server enables clients to receive real-time transaction status updates without polling. Key features:

- **JWT Authentication** — Token-based connection security
- **Per-Transaction Subscriptions** — Subscribe to specific transaction status updates
- **Per-User Broadcasting** — Automatic updates for user's transactions
- **Horizontal Scaling** — Redis pub/sub for multi-instance deployments
- **Connection Management** — Rate limiting, connection limits, heartbeat
- **Metrics** — Prometheus-compatible monitoring

## Quick Start

### 1. Connect with Authentication

```typescript
import { ProxyPayWebSocketClient } from "@proxypay/sdk";

const client = new ProxyPayWebSocketClient({
  url: "ws://localhost:3000",
  token: "your-jwt-token",
});

client.on("connected", (clientId, userId) => {
  console.log(`Connected as ${userId} (${clientId})`);
});

client.on("error", (error) => {
  console.error("WebSocket error:", error);
});

await client.connect();
```

### 2. Subscribe to Transaction Updates

```typescript
// Subscribe to a specific transaction
client.subscribe("transaction-id-123");

// Listen for updates
client.on("transaction.updated", (data) => {
  console.log("Transaction updated:", data);
  // {
  //   id: "transaction-id-123",
  //   status: "completed",
  //   userId: "user-123"
  // }
});

// Unsubscribe when done
client.unsubscribe("transaction-id-123");
```

### 3. Disconnect

```typescript
client.disconnect();
```

## Connection Protocol

### Establishing Connection

1. **Open WebSocket** to `ws://server:port`
2. **Include JWT Token** via query param or Authorization header:
   - Query: `ws://server:port?token=JWT_TOKEN`
   - Header: `Authorization: Bearer JWT_TOKEN`
3. **Receive Connection Ack**:
   ```json
   {
     "type": "connection.ack",
     "data": {
       "clientId": "user-123::1234567890::abc123",
       "userId": "user-123"
     }
   }
   ```

### Message Format

All messages follow a standard JSON format:

```json
{
  "type": "message_type",
  "data": {
    "key": "value"
  }
}
```

### Authentication Failures

- Invalid token: `close(1008, "Invalid or expired token")`
- Missing token: `close(1008, "Authentication required")`
- Invalid payload: `close(1008, "Invalid authentication payload")`

## Client API

### ProxyPayWebSocketClient

Complete TypeScript client with automatic reconnection and event handling.

#### Constructor

```typescript
new ProxyPayWebSocketClient(options: ClientOptions)
```

**Options:**

```typescript
interface ClientOptions {
  url: string;                    // WebSocket server URL
  token: string;                  // JWT authentication token
  reconnect?: boolean;            // Auto-reconnect (default: true)
  reconnectInterval?: number;     // ms between reconnect attempts (default: 1000)
  reconnectMaxAttempts?: number;  // Max reconnection attempts (default: 10)
  heartbeatInterval?: number;     // Heartbeat interval in ms (default: 30000)
  debug?: boolean;                // Enable debug logging (default: false)
}
```

#### Methods

```typescript
// Connection management
async connect(): Promise<void>
disconnect(): void
isConnected(): boolean

// Subscriptions
subscribe(transactionId: string): void
unsubscribe(transactionId: string): void
getSubscriptions(): string[]

// Event management
on(event: EventType, handler: Function): void
off(event: EventType, handler: Function): void
once(event: EventType, handler: Function): void

// State queries
getClientId(): string | null
getUserId(): string | null
```

#### Events

```typescript
type EventType =
  | "connected"           // Successfully authenticated
  | "disconnected"        // Connection closed
  | "reconnecting"        // Attempting to reconnect
  | "error"               // Error occurred
  | "transaction.updated" // Transaction status changed
  | "subscribed"          // Subscription acknowledged
  | "unsubscribed"        // Unsubscription acknowledged
```

**Event Handlers:**

```typescript
// connected: (clientId: string, userId: string) => void
client.on("connected", (clientId, userId) => {
  console.log(`Connected: ${clientId} for user ${userId}`);
});

// disconnected: (reason: string) => void
client.on("disconnected", (reason) => {
  console.log(`Disconnected: ${reason}`);
});

// reconnecting: (attempt: number) => void
client.on("reconnecting", (attempt) => {
  console.log(`Attempting to reconnect (${attempt}/10)`);
});

// error: (error: Error) => void
client.on("error", (error) => {
  console.error(`Error: ${error.message}`);
});

// transaction.updated: (data: TransactionUpdate) => void
client.on("transaction.updated", (data) => {
  console.log(`Transaction ${data.id} is now ${data.status}`);
});

// subscribed: (transactionId: string) => void
client.on("subscribed", (txId) => {
  console.log(`Subscribed to ${txId}`);
});

// unsubscribed: (transactionId: string) => void
client.on("unsubscribed", (txId) => {
  console.log(`Unsubscribed from ${txId}`);
});
```

## Server Message Types

### Subscribe

```json
{
  "type": "subscribe",
  "data": {
    "transactionId": "transaction-id-123"
  }
}
```

**Response:**

```json
{
  "type": "subscribe.ack",
  "data": {
    "transactionId": "transaction-id-123"
  }
}
```

### Unsubscribe

```json
{
  "type": "unsubscribe",
  "data": {
    "transactionId": "transaction-id-123"
  }
}
```

### Transaction Update (Server → Client)

```json
{
  "type": "transaction.updated",
  "data": {
    "id": "transaction-id-123",
    "status": "completed",
    "userId": "user-123"
  }
}
```

### Error

```json
{
  "type": "error",
  "data": {
    "message": "Rate limit exceeded"
  }
}
```

## Configuration

### Environment Variables

```bash
# Connection limits
WS_MAX_CONNECTIONS_PER_USER=5              # Default: 5
WS_MAX_TOTAL_CONNECTIONS=10000             # Default: 10000

# Rate limiting
WS_RATE_LIMIT_WINDOW_MS=1000               # Default: 1000
WS_RATE_LIMIT_MAX_MESSAGES=10              # Default: 10

# Redis (optional, for horizontal scaling)
REDIS_URL=redis://localhost:6379
```

### Limits

| Setting | Default | Purpose |
|---------|---------|---------|
| Max connections per user | 5 | Prevent resource exhaustion per user |
| Max total connections | 10,000 | Server capacity limit |
| Rate limit window | 1000ms | Message rate window |
| Max messages/window | 10 | Messages allowed per window |
| Heartbeat interval | 10s | Detect stale connections |
| Max missed pings | 2 | Terminate after N missed pings |

## Monitoring

### Admin Metrics Endpoint

```bash
GET /api/admin/websocket/metrics
```

**Response:**

```json
{
  "status": "active",
  "timestamp": "2026-07-26T16:22:47.013Z",
  "connections": {
    "active": 1234,
    "maxPerUser": 5,
    "maxTotal": 10000
  },
  "rateLimiting": {
    "windowMs": 1000,
    "maxMessagesPerWindow": 10
  },
  "subscriptions": {
    "uniqueTransactions": 5678,
    "totalSubscriptions": 12345,
    "userRooms": 1234
  }
}
```

### Prometheus Metrics

Available metrics (Prometheus format):

- `ws_connections_total` — Total connections established
- `ws_active_connections` — Currently active connections
- `ws_messages_sent_total` — Messages sent (by type)
- `ws_messages_received_total` — Messages received (by type)
- `ws_rate_limit_exceeded_total` — Rate limit violations
- `ws_connection_duration_seconds` — Connection duration histogram
- `ws_connection_time_ms` — Connection establishment time
- `ws_subscribe_latency_ms` — Subscription acknowledgment latency

Access via: `GET /metrics`

## Error Handling

### Common Errors

| Error | Cause | Resolution |
|-------|-------|-----------|
| Invalid token | Expired or malformed JWT | Regenerate token, verify expiry |
| Maximum connections exceeded | Too many active connections | Close unused connections, increase limit |
| Rate limit exceeded | Too many messages in window | Reduce message frequency |
| Connection timeout | Failed to establish connection | Check server availability, network |

### Client Reconnection

The client automatically reconnects with exponential backoff:

```
Attempt 1: 1s
Attempt 2: 1s
Attempt 3: 1s
...
Attempt 10: Max 10 attempts
```

To manually control reconnection:

```typescript
const client = new ProxyPayWebSocketClient({
  url: "ws://...",
  token: "...",
  reconnect: false,  // Disable auto-reconnect
});

// Manual reconnection
client.connect().then(() => {
  console.log("Connected");
}).catch((err) => {
  console.error("Connection failed:", err);
  // Implement custom retry logic
});
```

## Best Practices

### 1. Always Clean Up

```typescript
client.on("error", (error) => {
  console.error("Unrecoverable error:", error);
  client.disconnect();
});

// When application exits
process.on("SIGTERM", () => {
  client.disconnect();
  process.exit(0);
});
```

### 2. Handle Reconnection

```typescript
client.on("reconnecting", (attempt) => {
  if (attempt > 3) {
    console.warn("Too many reconnection attempts, giving up");
    client.disconnect();
  }
});
```

### 3. Manage Subscriptions

```typescript
// Subscribe only to needed transactions
client.subscribe("active-tx-id");

// Unsubscribe when complete
client.on("transaction.updated", (data) => {
  if (data.status === "completed" || data.status === "failed") {
    client.unsubscribe(data.id);
  }
});
```

### 4. Implement Retry Logic

```typescript
async function connectWithRetry(maxAttempts = 3) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await client.connect();
      return;
    } catch (err) {
      console.warn(`Connection attempt ${i + 1} failed:`, err);
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
  throw new Error("Failed to connect after max attempts");
}
```

### 5. Debug Mode

Enable debug logging during development:

```typescript
const client = new ProxyPayWebSocketClient({
  url: "ws://localhost:3000",
  token: "...",
  debug: true,  // Logs all WebSocket events
});
```

## Testing

### Load Testing (1000+ connections)

**Node.js Load Test:**

```bash
node benchmarks/ws-load-test.mjs \
  --connections=1000 \
  --duration=60 \
  --token='your-jwt-token'
```

**k6 Load Test:**

```bash
k6 run \
  -e TARGET_URL=ws://localhost:3000 \
  -e CONNECTIONS=1000 \
  -e DURATION=60s \
  benchmarks/ws-load-test.js
```

### Unit Tests

```bash
npm test -- src/websocket/__tests__/
```

## Architecture

### Server Architecture

```
HTTP Server
    ↓
WebSocketServer (ws library)
    ├─ Connection Handler
    │  ├─ JWT Authentication
    │  ├─ Connection Limits
    │  └─ Rate Limiting
    ├─ Message Handler
    │  ├─ Subscribe/Unsubscribe
    │  ├─ Transaction Updates
    │  └─ Heartbeat/Ping-Pong
    ├─ Broadcasting
    │  ├─ Local Broadcasting
    │  ├─ Redis Pub/Sub (distributed)
    │  └─ Metrics Collection
    └─ Cleanup
       ├─ Stale Connection Detection
       └─ Graceful Disconnection
```

### Horizontal Scaling with Redis

```
Instance 1                Instance 2
    ↓                         ↓
WebSocket Server 1    WebSocket Server 2
    ↓                         ↓
Redis Pub/Sub Channel (transaction.updates)
```

When a transaction is updated:
1. Database updates transaction status
2. `transactionModel.updateStatus()` broadcasts to WebSocket
3. Local clients receive update immediately
4. Server publishes to Redis channel
5. Other instances receive via Redis sub and deliver to their clients

### Transaction Status Update Flow

```
POST /api/transactions/{id}/cancel
    ↓
TransactionController
    ↓
TransactionModel.updateStatus(id, status)
    ↓
Database UPDATE
    ↓
WebSocketManager.broadcastTransactionUpdate()
    ├─ Local broadcast (immediate)
    ├─ Redis publish (for other instances)
    └─ Prometheus metrics increment
    ↓
Client receives in real-time
```

## API Reference

### Transaction Status Values

```typescript
enum TransactionStatus {
  Pending = "pending",
  Processing = "processing",
  Completed = "completed",
  Failed = "failed",
  Cancelled = "cancelled",
  Review = "review",
  OnHold = "on_hold",
}
```

### WebSocket Close Codes

| Code | Meaning |
|------|---------|
| 1008 | Authentication error (invalid token, missing auth) |
| 1008 | Connection limit exceeded |
| 1000 | Normal closure |
| 1006 | Abnormal closure (network error) |

## Troubleshooting

### Connections Not Persisting

**Problem:** Clients disconnect immediately after connecting.

**Solution:**
- Verify JWT token is valid and not expired
- Check WebSocket URL is correct (ws:// not http://)
- Verify server is running and WebSocket server is initialized

### Messages Not Being Received

**Problem:** Client doesn't receive transaction updates.

**Solution:**
- Verify subscription was acknowledged (`subscribe.ack`)
- Check transaction ID is correct
- Enable debug logging to see message flow
- Verify user has permission to see transaction

### Rate Limiting Issues

**Problem:** Client receiving "Rate limit exceeded" errors.

**Solution:**
- Increase `WS_RATE_LIMIT_MAX_MESSAGES` environment variable
- Increase `WS_RATE_LIMIT_WINDOW_MS` if applicable
- Reduce message sending frequency in client code

### High Memory Usage

**Problem:** WebSocket server consuming excessive memory.

**Solution:**
- Check `ws_active_connections` metric — may be at capacity
- Decrease `WS_MAX_TOTAL_CONNECTIONS` if needed
- Verify stale connections are being cleaned up
- Monitor with Redis memory usage if using Redis scaling

## Examples

### React Component

```typescript
import { useEffect, useState } from "react";
import { ProxyPayWebSocketClient } from "@proxypay/sdk";

export function TransactionMonitor({ transactionId, token }) {
  const [status, setStatus] = useState("pending");
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const client = new ProxyPayWebSocketClient({
      url: "ws://localhost:3000",
      token,
    });

    client.on("connected", () => setConnected(true));
    client.on("disconnected", () => setConnected(false));
    client.on("transaction.updated", (data) => {
      setStatus(data.status);
    });

    client.connect().catch(console.error);
    client.subscribe(transactionId);

    return () => {
      client.unsubscribe(transactionId);
      client.disconnect();
    };
  }, [transactionId, token]);

  return (
    <div>
      <p>Status: {status}</p>
      <p>Connected: {connected ? "✓" : "✗"}</p>
    </div>
  );
}
```

### Vue 3 Composable

```typescript
import { ref, onMounted, onUnmounted } from "vue";
import { ProxyPayWebSocketClient } from "@proxypay/sdk";

export function useTransactionUpdates(transactionId, token) {
  const status = ref("pending");
  const connected = ref(false);
  const error = ref<Error | null>(null);

  let client: ProxyPayWebSocketClient | null = null;

  onMounted(async () => {
    client = new ProxyPayWebSocketClient({
      url: "ws://localhost:3000",
      token,
    });

    client.on("connected", () => {
      connected.value = true;
    });

    client.on("disconnected", () => {
      connected.value = false;
    });

    client.on("transaction.updated", (data) => {
      status.value = data.status;
    });

    client.on("error", (err) => {
      error.value = err;
    });

    try {
      await client.connect();
      client.subscribe(transactionId);
    } catch (err) {
      error.value = err as Error;
    }
  });

  onUnmounted(() => {
    if (client) {
      client.unsubscribe(transactionId);
      client.disconnect();
    }
  });

  return { status, connected, error };
}
```

## See Also

- [Transaction API Documentation](/docs/api/transactions.md)
- [Authentication Guide](/docs/auth.md)
- [Performance Monitoring](/docs/monitoring.md)
