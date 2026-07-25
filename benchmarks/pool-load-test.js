import http from "k6/http";
import { check, sleep } from "k6";

/**
 * Load test for database connection pooling
 * Tests pool saturation and latency degradation under load
 *
 * Run: k6 run benchmarks/pool-load-test.js
 */

export const options = {
  stages: [
    // Warm up: 10 VUs for 30s
    { duration: "30s", target: 10 },
    // Ramp up to 50 VUs over 1m
    { duration: "1m", target: 50 },
    // Peak: 100 VUs for 2m
    { duration: "2m", target: 100 },
    // Stress: 200 VUs for 1m
    { duration: "1m", target: 200 },
    // Ramp down
    { duration: "1m", target: 0 },
  ],
  thresholds: {
    "http_req_duration": ["p(95)<2000", "p(99)<5000"],
    "http_req_failed": ["rate<0.1"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

export default function () {
  // Transaction list endpoint (read-heavy)
  const listRes = http.get(
    `${BASE_URL}/api/transactions?limit=10&offset=0`,
    {
      headers: {
        Authorization: `Bearer ${__ENV.JWT_TOKEN}`,
      },
      tags: { name: "ListTransactions" },
    },
  );

  check(listRes, {
    "list transactions status": (r) => r.status === 200,
    "list transactions duration": (r) => r.timings.duration < 2000,
  });

  // Admin stats endpoint (query-heavy)
  const statsRes = http.get(`${BASE_URL}/api/admin/stats`, {
    headers: {
      Authorization: `Bearer ${__ENV.JWT_TOKEN}`,
    },
    tags: { name: "GetStats" },
  });

  check(statsRes, {
    "stats status": (r) => r.status === 200,
    "stats duration": (r) => r.timings.duration < 3000,
  });

  // Health check endpoint (simple query)
  const healthRes = http.get(`${BASE_URL}/health`);

  check(healthRes, {
    "health status": (r) => r.status === 200,
    "health duration": (r) => r.timings.duration < 500,
  });

  sleep(1);
}

/**
 * Setup: Log pool metrics before test
 */
export function setup() {
  console.log(`Starting pool load test against ${BASE_URL}`);
  console.log(`Peak VUs: 200`);
  console.log(`Total duration: 5m`);
}

/**
 * Teardown: Log pool metrics after test
 */
export function teardown() {
  console.log("Pool load test completed");
  console.log("Check /metrics endpoint for pool utilization data");
}
