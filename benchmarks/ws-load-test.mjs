#!/usr/bin/env node

/**
 * WebSocket Load Testing Suite
 *
 * Node.js-based load testing for WebSocket connections with transaction status updates.
 * Can test 1000+ concurrent connections with configurable message rate.
 *
 * Usage:
 *   node ws-load-test.mjs --connections=1000 --duration=60 --url=ws://localhost:3000
 *
 * Options:
 *   --connections    Number of concurrent connections (default: 1000)
 *   --duration       Test duration in seconds (default: 60)
 *   --url            WebSocket server URL (default: ws://localhost:3000)
 *   --token          JWT token for authentication (required)
 *   --transactions   Number of transactions per connection (default: 10)
 *   --message-rate   Messages per second per connection (default: 1)
 *   --debug          Enable debug logging
 */

import WebSocket from "ws";
import { performance } from "perf_hooks";

// Parse CLI arguments
const args = process.argv.slice(2).reduce((acc, arg) => {
  const [key, value] = arg.split("=");
  acc[key.replace("--", "")] = value || true;
  return acc;
}, {});

const config = {
  url: args.url || "ws://localhost:3000",
  connections: parseInt(args.connections || "1000"),
  duration: parseInt(args.duration || "60"),
  token:
    args.token ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ0ZXN0LXVzZXIiLCJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20iLCJpYXQiOjE2MzA3MDMyMDB9.test",
  transactions: parseInt(args.transactions || "10"),
  messageRate: parseInt(args["message-rate"] || "1"),
  debug: args.debug === "true" || args.debug === true,
};

// Metrics
const metrics = {
  connectionsCreated: 0,
  connectionsSucceeded: 0,
  connectionsFailed: 0,
  connectionsActive: 0,
  messagesSent: 0,
  messagesReceived: 0,
  subscribesAcknowledged: 0,
  transactionUpdatesReceived: 0,
  errors: [],
  connectionTimes: [],
  messageLatencies: [],
  startTime: performance.now(),
};

// Helper functions
function log(message, data = "") {
  console.log(`[${new Date().toISOString()}] ${message} ${data}`);
}

function debug(message, data = "") {
  if (config.debug) {
    console.debug(`[DEBUG] ${message}`, data);
  }
}

function generateTransactionIds(count, prefix) {
  return Array.from({ length: count }, (_, i) =>
    `${prefix}-tx-${i}-${Math.random().toString(36).substr(2, 9)}`
  );
}

// WebSocket client
function createConnection(clientId) {
  return new Promise((resolve, reject) => {
    const startTime = performance.now();
    const wsUrl = `${config.url}?token=${encodeURIComponent(config.token)}`;
    const ws = new WebSocket(wsUrl);
    const transactionIds = generateTransactionIds(config.transactions, clientId);
    let isConnected = false;

    const timeout = setTimeout(() => {
      if (!isConnected) {
        ws.terminate();
        reject(new Error("Connection timeout"));
      }
    }, 10000);

    ws.on("open", () => {
      const connectionTime = performance.now() - startTime;
      metrics.connectionTimes.push(connectionTime);
      metrics.connectionsSucceeded += 1;
      metrics.connectionsActive += 1;
      isConnected = true;
      clearTimeout(timeout);

      debug(`Client ${clientId} connected (${connectionTime.toFixed(2)}ms)`);

      // Subscribe to transactions
      let subscriptionIndex = 0;
      const subscribeInterval = setInterval(() => {
        if (subscriptionIndex >= transactionIds.length) {
          clearInterval(subscribeInterval);
          resolve(ws);
          return;
        }

        const txId = transactionIds[subscriptionIndex++];
        const msg = {
          type: "subscribe",
          data: { transactionId: txId },
        };

        try {
          ws.send(JSON.stringify(msg));
          metrics.messagesSent += 1;
        } catch (err) {
          debug(`Failed to send subscribe message: ${err.message}`);
        }
      }, 100); // Spread subscriptions over 1 second
    });

    ws.on("message", (data) => {
      try {
        metrics.messagesReceived += 1;
        const msg = JSON.parse(data.toString());

        if (msg.type === "subscribe.ack") {
          metrics.subscribesAcknowledged += 1;
          debug(`Client ${clientId} subscription acked`);
        } else if (msg.type === "transaction.updated") {
          metrics.transactionUpdatesReceived += 1;
          debug(`Client ${clientId} received transaction update: ${msg.data.id}`);
        } else if (msg.type === "connection.ack") {
          debug(`Client ${clientId} received connection ack`);
        } else if (msg.type === "error") {
          metrics.errors.push(`Error: ${msg.data.message}`);
          debug(`Client ${clientId} received error: ${msg.data.message}`);
        }
      } catch (err) {
        metrics.errors.push(`Message parsing error: ${err.message}`);
        debug(`Failed to parse message: ${err.message}`);
      }
    });

    ws.on("error", (err) => {
      metrics.errors.push(err.message);
      debug(`Client ${clientId} websocket error: ${err.message}`);
      reject(err);
    });

    ws.on("close", () => {
      metrics.connectionsActive -= 1;
      debug(`Client ${clientId} disconnected`);
    });
  });
}

// Main test function
async function runLoadTest() {
  log(`Starting WebSocket load test`);
  log(`Configuration:`, JSON.stringify(config, null, 2));

  const connections = [];
  const connectionBatchSize = 50; // Create in batches to avoid overwhelming the system

  // Create connections in batches
  for (let i = 0; i < config.connections; i += connectionBatchSize) {
    const batchSize = Math.min(connectionBatchSize, config.connections - i);
    const batch = [];

    for (let j = 0; j < batchSize; j++) {
      const clientId = i + j;
      metrics.connectionsCreated += 1;

      const promise = createConnection(clientId)
        .catch((err) => {
          metrics.connectionsFailed += 1;
          metrics.errors.push(err.message);
          debug(`Failed to create connection ${clientId}: ${err.message}`);
          return null;
        });

      batch.push(promise);
    }

    try {
      const results = await Promise.all(batch);
      connections.push(...results.filter((c) => c !== null));
      log(`Created ${i + batchSize}/${config.connections} connections`);
    } catch (err) {
      log(`Error creating batch: ${err.message}`);
    }

    // Rate limit connection creation
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  log(`All connections established (${connections.length} active)`);

  // Keep connections alive for the test duration
  const testEndTime = Date.now() + config.duration * 1000;

  const reportInterval = setInterval(() => {
    const elapsed = (Date.now() - metrics.startTime) / 1000;
    const rate = (metrics.messagesReceived / elapsed).toFixed(2);
    log(
      `[${elapsed.toFixed(1)}s] Active: ${metrics.connectionsActive} | Messages: Sent=${metrics.messagesSent} Received=${metrics.messagesReceived} (${rate}/s) | Subs: ${metrics.subscribesAcknowledged} | Errors: ${metrics.errors.length}`
    );
  }, 5000);

  // Wait for test duration
  while (Date.now() < testEndTime) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  clearInterval(reportInterval);

  // Gracefully close connections
  log(`Closing ${connections.length} connections...`);
  for (const ws of connections) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  }

  // Wait for connections to fully close
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Print summary
  printSummary();
}

function printSummary() {
  const elapsed = (Date.now() - metrics.startTime) / 1000;
  const avgConnectionTime =
    metrics.connectionTimes.length > 0
      ? metrics.connectionTimes.reduce((a, b) => a + b, 0) /
        metrics.connectionTimes.length
      : 0;
  const maxConnectionTime = Math.max(...metrics.connectionTimes, 0);
  const p95ConnectionTime =
    metrics.connectionTimes.length > 0
      ? metrics.connectionTimes.sort((a, b) => a - b)[
          Math.floor(metrics.connectionTimes.length * 0.95)
        ]
      : 0;

  const errorRate = (metrics.errors.length / (metrics.messagesSent || 1)) * 100;
  const messagesPerSecond = metrics.messagesReceived / elapsed;

  console.log("\n" + "=".repeat(70));
  console.log("WEBSOCKET LOAD TEST SUMMARY");
  console.log("=".repeat(70));

  console.log("\n📊 Connection Metrics:");
  console.log(`  Total Connections:       ${metrics.connectionsCreated}`);
  console.log(`  ✓ Successful:            ${metrics.connectionsSucceeded}`);
  console.log(`  ✗ Failed:                ${metrics.connectionsFailed}`);
  console.log(`  Active at End:           ${metrics.connectionsActive}`);

  console.log("\n⏱️  Connection Timing:");
  console.log(
    `  Avg Connection Time:     ${avgConnectionTime.toFixed(2)}ms`
  );
  console.log(`  P95 Connection Time:     ${p95ConnectionTime.toFixed(2)}ms`);
  console.log(`  Max Connection Time:     ${maxConnectionTime.toFixed(2)}ms`);

  console.log("\n💬 Message Metrics:");
  console.log(`  Total Sent:              ${metrics.messagesSent}`);
  console.log(`  Total Received:          ${metrics.messagesReceived}`);
  console.log(`  Messages/sec:            ${messagesPerSecond.toFixed(2)}`);

  console.log("\n✅ Business Metrics:");
  console.log(`  Subscriptions Ack'd:     ${metrics.subscribesAcknowledged}`);
  console.log(
    `  Transaction Updates:     ${metrics.transactionUpdatesReceived}`
  );

  console.log("\n⚠️  Error Metrics:");
  console.log(`  Total Errors:            ${metrics.errors.length}`);
  console.log(`  Error Rate:              ${errorRate.toFixed(2)}%`);

  if (metrics.errors.length > 0 && metrics.errors.length <= 10) {
    console.log("\n  Error Details:");
    metrics.errors.forEach((err) => {
      console.log(`    • ${err}`);
    });
  }

  console.log("\n⏳ Test Duration:          " + elapsed.toFixed(2) + "s");
  console.log("=".repeat(70));

  // Assess pass/fail
  const passed =
    metrics.connectionsFailed === 0 &&
    metrics.messagesReceived > 0 &&
    errorRate < 10;
  console.log(
    `\n${passed ? "✅ TEST PASSED" : "❌ TEST FAILED"}`
  );
}

// Run the test
runLoadTest().catch((err) => {
  log(`Test failed with error: ${err.message}`);
  process.exit(1);
});

// Handle graceful shutdown
process.on("SIGINT", () => {
  log("Received SIGINT, shutting down gracefully...");
  process.exit(0);
});
