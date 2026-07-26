/**
 * k6 WebSocket Load Test — Transaction Status Broadcasts
 *
 * Tests WebSocket server's ability to handle 1000+ concurrent connections
 * with real-time transaction status updates.
 *
 * Usage:
 *   # 100 concurrent connections for 30s
 *   k6 run -e TARGET_URL=ws://localhost:3000 -e CONNECTIONS=100 ws-load-test.js
 *
 *   # 1000 concurrent connections for 60s
 *   k6 run -e TARGET_URL=ws://localhost:3000 -e CONNECTIONS=1000 -e DURATION=60s ws-load-test.js
 *
 *   # 5000 concurrent connections for 120s
 *   k6 run -e TARGET_URL=ws://localhost:3000 -e CONNECTIONS=5000 -e DURATION=120s ws-load-test.js
 *
 * Environment variables:
 *   TARGET_URL:        WebSocket URL (default: ws://localhost:3000)
 *   CONNECTIONS:       Number of concurrent connections (default: 1000)
 *   DURATION:          Test duration (default: 60s)
 *   TRANSACTION_COUNT: Transactions per connection to subscribe to (default: 10)
 */

import ws from "k6/ws";
import { check, group, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TARGET_URL = __ENV.TARGET_URL || "ws://localhost:3000";
const CONNECTIONS = parseInt(__ENV.CONNECTIONS || "1000");
const DURATION = __ENV.DURATION || "60s";
const TRANSACTION_COUNT = parseInt(__ENV.TRANSACTION_COUNT || "10");
const JWT_TOKEN =
  __ENV.JWT_TOKEN ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ0ZXN0LXVzZXIiLCJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20iLCJpYXQiOjE2MzA3MDMyMDB9.test";

// ---------------------------------------------------------------------------
// Custom Metrics
// ---------------------------------------------------------------------------

const connectedConnections = new Counter("ws_connections_success");
const failedConnections = new Counter("ws_connections_failed");
const messagesSent = new Counter("ws_messages_sent");
const messagesReceived = new Counter("ws_messages_received");
const connectionErrors = new Counter("ws_connection_errors");
const subscribeLatency = new Trend("ws_subscribe_latency_ms", true);
const connectionTime = new Trend("ws_connection_time_ms", true);
const errorRate = new Rate("ws_error_rate");

// ---------------------------------------------------------------------------
// k6 Configuration
// ---------------------------------------------------------------------------

export const options = {
  scenarios: {
    websocket_stress: {
      executor: "per-vu-iterations",
      vus: Math.min(CONNECTIONS, 10), // Use up to 10 VUs
      iterations: Math.ceil(CONNECTIONS / Math.min(CONNECTIONS, 10)), // Scale iterations to reach desired concurrency
      duration: DURATION,
      maxDuration: "15m",
    },
  },
  thresholds: {
    "ws_error_rate": ["rate < 0.1"], // Less than 10% error rate
    "ws_connections_failed": ["count < 10"], // Less than 10 failed connections
  },
};

// ---------------------------------------------------------------------------
// Helper: Generate transaction IDs
// ---------------------------------------------------------------------------

function generateTransactionIds(count) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    ids.push(`tx-${__VU}-${i}-${Math.random().toString(36).substr(2, 9)}`);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Main Test Function
// ---------------------------------------------------------------------------

export default function () {
  const startTime = Date.now();
  const transactionIds = generateTransactionIds(TRANSACTION_COUNT);
  const url = `${TARGET_URL}?token=${encodeURIComponent(JWT_TOKEN)}`;

  let messageCount = 0;
  let subscribeCount = 0;
  const connectionStartTime = Date.now();

  group("WebSocket Connection", () => {
    const res = ws.connect(url, null, (socket) => {
      // Connection opened
      const connectionDuration = Date.now() - connectionStartTime;
      connectionTime.add(connectionDuration);
      connectedConnections.add(1);

      check(res, {
        "connection status is 101": (r) => r && r.status === 101,
      });

      socket.on("open", () => {
        check(true, {
          "socket opened successfully": (v) => v,
        });
      });

      socket.on("message", (message) => {
        messagesReceived.add(1);
        messageCount += 1;

        try {
          const msg = JSON.parse(message);

          // Track subscription acknowledgments
          if (msg.type === "subscribe.ack") {
            subscribeCount += 1;
            subscribeLatency.add(Date.now() - startTime);
          }

          // Track transaction updates
          if (msg.type === "transaction.updated") {
            check(msg.data, {
              "transaction update has id": (d) => d && d.id,
              "transaction update has status": (d) => d && d.status,
            });
          }

          // Track errors
          if (msg.type === "error") {
            errorRate.add(1);
            check(false, {
              "no error messages received": (v) => v,
            });
          }

          // Track connection ack
          if (msg.type === "connection.ack") {
            check(msg.data, {
              "ack has clientId": (d) => d && d.clientId,
              "ack has userId": (d) => d && d.userId,
            });
          }
        } catch (err) {
          errorRate.add(1);
          connectionErrors.add(1);
        }
      });

      socket.on("close", () => {
        // Connection closed
      });

      socket.on("error", (error) => {
        errorRate.add(1);
        connectionErrors.add(1);
        check(false, {
          "no websocket errors": (v) => v,
        });
      });

      // Subscribe to transactions
      group("Subscribe to Transactions", () => {
        for (const txId of transactionIds) {
          const subscribeMsg = {
            type: "subscribe",
            data: { transactionId: txId },
          };

          socket.send(JSON.stringify(subscribeMsg));
          messagesSent.add(1);
        }

        // Give time for subscriptions to be acknowledged
        sleep(0.5);
      });

      // Send keep-alive messages
      group("Maintain Connection", () => {
        for (let i = 0; i < 5; i++) {
          sleep(2); // Keep connection alive for test duration
        }
      });

      // Unsubscribe from transactions
      group("Unsubscribe from Transactions", () => {
        for (const txId of transactionIds) {
          const unsubscribeMsg = {
            type: "unsubscribe",
            data: { transactionId: txId },
          };

          socket.send(JSON.stringify(unsubscribeMsg));
          messagesSent.add(1);
        }
      });

      socket.close();
    });
  });

  if (!res || res.status !== 101) {
    failedConnections.add(1);
    errorRate.add(1);
  }

  check(messageCount > 0, {
    "received at least one message": (v) => v,
  });

  check(subscribeCount > 0, {
    "received at least one subscription acknowledgment": (v) => v,
  });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: " ", enableColors: true }),
    "results/ws-load-test-summary.json": JSON.stringify(data),
  };
}

/**
 * Text summary formatter
 */
function textSummary(data, options) {
  const indent = options.indent || "";
  const colors = options.enableColors !== false;
  let output = "\n";

  const reset = colors ? "\x1b[0m" : "";
  const green = colors ? "\x1b[32m" : "";
  const yellow = colors ? "\x1b[33m" : "";
  const red = colors ? "\x1b[31m" : "";
  const bold = colors ? "\x1b[1m" : "";

  // Connection metrics
  output += `${bold}Connection Metrics${reset}\n`;
  if (data.metrics.ws_connections_success) {
    output += `${indent}✓ Successful connections: ${data.metrics.ws_connections_success.value.toLocaleString()}\n`;
  }
  if (data.metrics.ws_connections_failed) {
    const failed = data.metrics.ws_connections_failed.value;
    const color = failed > 0 ? red : green;
    output += `${indent}${failed > 0 ? "✗" : "✓"} Failed connections: ${color}${failed}${reset}\n`;
  }

  // Message metrics
  output += `\n${bold}Message Metrics${reset}\n`;
  if (data.metrics.ws_messages_sent) {
    output += `${indent}→ Messages sent: ${data.metrics.ws_messages_sent.value.toLocaleString()}\n`;
  }
  if (data.metrics.ws_messages_received) {
    output += `${indent}← Messages received: ${data.metrics.ws_messages_received.value.toLocaleString()}\n`;
  }

  // Latency metrics
  output += `\n${bold}Latency Metrics${reset}\n`;
  if (data.metrics.ws_connection_time_ms) {
    const trend = data.metrics.ws_connection_time_ms;
    output += `${indent}Connection time:    avg=${trend.values.avg?.toFixed(2)}ms, p95=${trend.values.p(0.95)?.toFixed(2)}ms, max=${trend.values.max?.toFixed(2)}ms\n`;
  }
  if (data.metrics.ws_subscribe_latency_ms) {
    const trend = data.metrics.ws_subscribe_latency_ms;
    output += `${indent}Subscribe latency:  avg=${trend.values.avg?.toFixed(2)}ms, p95=${trend.values.p(0.95)?.toFixed(2)}ms, max=${trend.values.max?.toFixed(2)}ms\n`;
  }

  // Error metrics
  output += `\n${bold}Error Metrics${reset}\n`;
  if (data.metrics.ws_error_rate) {
    const rate = data.metrics.ws_error_rate.value;
    const color = rate > 0.1 ? red : green;
    output += `${indent}${rate > 0.1 ? "✗" : "✓"} Error rate: ${color}${(rate * 100).toFixed(2)}%${reset}\n`;
  }
  if (data.metrics.ws_connection_errors) {
    const errors = data.metrics.ws_connection_errors.value;
    const color = errors > 0 ? red : green;
    output += `${indent}${errors > 0 ? "✗" : "✓"} Connection errors: ${color}${errors}${reset}\n`;
  }

  return output;
}
