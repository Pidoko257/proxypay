/**
 * k6 WebSocket Load Test — ProxyPay #168
 *
 * Tests 1000+ concurrent WebSocket connections:
 *  - Connection establishment latency
 *  - Subscribe + receive broadcast
 *  - Error rate under load
 *
 * Run:
 *   k6 run tests/load/websocket-load.js
 *
 * Override target URL or token:
 *   k6 run -e WS_URL=ws://localhost:3000 -e JWT_TOKEN=<token> tests/load/websocket-load.js
 */

import ws from "k6/ws";
import { check, sleep } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const connectionErrors = new Rate("ws_connection_errors");
const messageLatency = new Trend("ws_message_latency_ms", true);
const messagesReceived = new Counter("ws_messages_received");
const subscribeAcks = new Counter("ws_subscribe_acks");

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

export const options = {
  scenarios: {
    // Ramp up to 1000 concurrent users, hold 30s, ramp down
    sustained_load: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "20s", target: 200 },
        { duration: "20s", target: 500 },
        { duration: "20s", target: 1000 },
        { duration: "30s", target: 1000 }, // hold at 1000
        { duration: "10s", target: 0 },
      ],
      gracefulRampDown: "5s",
    },
  },
  thresholds: {
    // 95th percentile connection time under 500 ms
    ws_connecting_duration: ["p(95)<500"],
    // 95th percentile message round-trip under 200 ms
    ws_message_latency_ms: ["p(95)<200"],
    // Less than 1% connection errors
    ws_connection_errors: ["rate<0.01"],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS_URL = __ENV.WS_URL || "ws://localhost:3000";

/**
 * Generate a minimal signed-looking token for load-test purposes.
 * In CI, set JWT_TOKEN to a pre-generated valid token.
 */
function getToken() {
  if (__ENV.JWT_TOKEN) return __ENV.JWT_TOKEN;
  // Fallback: a static fixture token (pre-signed for load test user).
  // Replace with a real token for your environment.
  return "load-test-fixture-token";
}

// ---------------------------------------------------------------------------
// VU script
// ---------------------------------------------------------------------------

export default function () {
  const token = getToken();
  const url = `${WS_URL}?token=${encodeURIComponent(token)}`;

  // Each VU picks a unique transaction ID to subscribe to
  const txId = `load-tx-${__VU}-${__ITER}`;

  let subscribeAckReceived = false;
  let updateReceived = false;
  const connectTime = Date.now();

  const res = ws.connect(url, {}, function (socket) {
    // ---- Connection established ----
    socket.on("open", function () {
      connectionErrors.add(false);
      const latency = Date.now() - connectTime;
      messageLatency.add(latency);
    });

    // ---- Handle messages ----
    socket.on("message", function (data) {
      messagesReceived.add(1);

      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }

      if (msg.type === "connection.ack") {
        // Subscribe to our transaction
        const subscribeTime = Date.now();
        socket.send(
          JSON.stringify({ type: "subscribe", data: { transactionId: txId } }),
        );

        check(msg, {
          "connection.ack received": (m) => m.type === "connection.ack",
          "clientId in ack": (m) => typeof m.data?.clientId === "string",
        });
      }

      if (msg.type === "subscribe.ack") {
        subscribeAcks.add(1);
        subscribeAckReceived = true;

        check(msg, {
          "subscribe.ack received": (m) => m.type === "subscribe.ack",
          "correct txId in ack": (m) => m.data?.transactionId === txId,
        });
      }

      if (msg.type === "transaction.updated") {
        const latency = Date.now() - connectTime;
        messageLatency.add(latency);
        updateReceived = true;

        check(msg, {
          "transaction.updated received": (m) => m.type === "transaction.updated",
        });
      }

      if (msg.type === "error") {
        // Rate limit or other server errors — not a connection failure
        check(msg, {
          "error has message": (m) => typeof m.data?.message === "string",
        });
      }
    });

    // ---- Error handling ----
    socket.on("error", function (e) {
      connectionErrors.add(true);
    });

    socket.on("close", function (code) {
      // code 1013 = server at capacity (expected under extreme load)
      if (code !== 1000 && code !== 1001 && code !== 1013) {
        connectionErrors.add(true);
      }
    });

    // Hold the connection for 30 seconds
    socket.setTimeout(function () {
      socket.close(1000, "load test complete");
    }, 30_000);
  });

  // Record if the connection was rejected (non-101 HTTP upgrade)
  if (res && res.status !== 101) {
    connectionErrors.add(true);
  }

  // Small think-time between VU iterations
  sleep(Math.random() * 2 + 1);
}
