/**
 * k6 benchmark — Callback Ingestion Service
 *
 * Usage:
 *   # 1k req/s for 30s
 *   k6 run -e TARGET_URL=http://localhost:3001 -e RPS=1000 k6-bench.js
 *
 *   # 5k req/s for 30s
 *   k6 run -e TARGET_URL=http://localhost:3001 -e RPS=5000 k6-bench.js
 *
 *   # 10k req/s for 30s
 *   k6 run -e TARGET_URL=http://localhost:3001 -e RPS=10000 k6-bench.js
 *
 *   # Run against Go service
 *   k6 run -e TARGET_URL=http://localhost:3002 -e RPS=10000 k6-bench.js
 *
 *   # Mixed DB-pool / provider-throttle / queue load scenario (issue #841)
 *   k6 run -e SCENARIO=mixed -e TARGET_URL=http://localhost:3001 k6-bench.js
 *
 * Output: k6 summary + JSON results file (results/<runtime>-<rps>.json)
 *
 * ---------------------------------------------------------------------------
 * Tested budgets (issue #841) — record these alongside any capacity run.
 * ---------------------------------------------------------------------------
 *   Instance      : 4 vCPU / 8 GiB (app), 4 vCPU / 16 GiB (PostgreSQL 16)
 *   DB pool       : max 20 connections per app instance (PG max_connections=100)
 *   Redis         : 1 GiB, maxmemory-policy allkeys-lru (job queue backend)
 *   Provider mock : 200 req/s sustained throttle per provider key
 *   Thresholds    : P95 < 250ms, P99 < 600ms, error rate < 1%,
 *                   queue backlog < 5000 jobs, provider 429 rate < 5%
 * ---------------------------------------------------------------------------
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend, Gauge } from "k6/metrics";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TARGET_URL = __ENV.TARGET_URL || "http://localhost:3001";
const RPS        = parseInt(__ENV.RPS || "1000");
const DURATION   = __ENV.DURATION   || "30s";
const WARMUP     = __ENV.WARMUP     || "5s";
const SCENARIO   = __ENV.SCENARIO   || "ingest";

// Mixed-traffic budgets (issue #841)
const MIXED_RPS          = parseInt(__ENV.MIXED_RPS || "500");
const MIXED_DURATION     = __ENV.MIXED_DURATION || "60s";
const QUEUE_BACKLOG_MAX  = parseInt(__ENV.QUEUE_BACKLOG_MAX || "5000");
const PROVIDER_429_MAX   = parseFloat(__ENV.PROVIDER_429_MAX || "0.05");

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const errorRate    = new Rate("error_rate");
const publishLatency = new Trend("publish_latency_ms", true);

// Mixed-traffic metrics
const provider429Rate = new Rate("provider_429_rate");
const queueBacklog    = new Gauge("queue_backlog");
const dbPoolLatency   = new Trend("db_pool_latency_ms", true);

// ---------------------------------------------------------------------------
// k6 options — constant arrival rate (most accurate for req/s targets)
// ---------------------------------------------------------------------------

const ingestOptions = {
  scenarios: {
    constant_rps: {
      executor: "constant-arrival-rate",
      rate: RPS,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: Math.min(RPS * 2, 5000),
      maxVUs: Math.min(RPS * 4, 20000),
    },
  },
  thresholds: {
    http_req_duration: [
      "p(50)<50",    // P50 < 50ms
      "p(95)<200",   // P95 < 200ms
      "p(99)<500",   // P99 < 500ms
    ],
    error_rate: ["rate<0.01"],  // < 1% errors
  },
  summaryTrendStats: ["min", "med", "avg", "p(90)", "p(95)", "p(99)", "max", "count"],
};

// Mixed traffic: DB pool + provider throttle + job queue in one scenario.
// Fails the run when latency, error, backlog, or provider-throttle budgets
// are exceeded.
const mixedOptions = {
  scenarios: {
    mixed_traffic: {
      executor: "constant-arrival-rate",
      rate: MIXED_RPS,
      timeUnit: "1s",
      duration: MIXED_DURATION,
      preAllocatedVUs: Math.min(MIXED_RPS * 2, 2000),
      maxVUs: Math.min(MIXED_RPS * 4, 8000),
    },
  },
  thresholds: {
    http_req_duration: [
      "p(95)<250",   // P95 < 250ms
      "p(99)<600",   // P99 < 600ms
    ],
    error_rate: ["rate<0.01"],           // < 1% errors
    provider_429_rate: [`rate<${PROVIDER_429_MAX}`], // provider throttle budget
    queue_backlog: [`value<${QUEUE_BACKLOG_MAX}`],   // queue backlog budget
    db_pool_latency_ms: ["p(95)<100"],   // DB pool acquisition budget
  },
  summaryTrendStats: ["min", "med", "avg", "p(90)", "p(95)", "p(99)", "max", "count"],
};

export const options = SCENARIO === "mixed" ? mixedOptions : ingestOptions;

// ---------------------------------------------------------------------------
// Realistic payload — varies reference per VU to avoid dedup
// ---------------------------------------------------------------------------

function makePayload() {
  return JSON.stringify({
    event_type: "payment.callback",
    provider:   "mtn",
    reference:  `REF-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    amount:     5000.00,
    currency:   "XAF",
    status:     "success",
    timestamp:  new Date().toISOString(),
    metadata: {
      customer_id: "cust-bench",
      channel:     "mobile",
      region:      "CM",
    },
  });
}

// ---------------------------------------------------------------------------
// Test function
// ---------------------------------------------------------------------------

export default function () {
  if (SCENARIO === "mixed") {
    mixedTraffic();
    return;
  }

  const start = Date.now();

  const res = http.post(`${TARGET_URL}/ingest`, makePayload(), {
    headers: { "Content-Type": "application/json" },
    timeout: "5s",
  });

  const latency = Date.now() - start;
  publishLatency.add(latency);

  const ok = check(res, {
    "status is 202": (r) => r.status === 202,
    "has reference":  (r) => r.json("reference") !== undefined,
  });

  errorRate.add(!ok);
}

// ---------------------------------------------------------------------------
// Mixed traffic — DB pool + provider throttle + job queue
// ---------------------------------------------------------------------------

function mixedTraffic() {
  // 1) Ingest callback — exercises DB pool + enqueues a job.
  const ingestStart = Date.now();
  const ingestRes = http.post(`${TARGET_URL}/ingest`, makePayload(), {
    headers: { "Content-Type": "application/json" },
    timeout: "5s",
  });
  dbPoolLatency.add(Date.now() - ingestStart);

  const ingestOk = check(ingestRes, {
    "ingest status is 202": (r) => r.status === 202,
    "ingest has reference": (r) => r.json("reference") !== undefined,
  });
  errorRate.add(!ingestOk);

  // 2) Provider call — hits the provider mock throttle; 429 is expected
  //    under load but must stay within budget.
  const providerRes = http.post(`${TARGET_URL}/provider/dispatch`, makePayload(), {
    headers: { "Content-Type": "application/json" },
    timeout: "5s",
  });
  provider429Rate.add(providerRes.status === 429);
  const providerOk = check(providerRes, {
    "provider status is 200 or 429": (r) => r.status === 200 || r.status === 429,
  });
  errorRate.add(!providerOk);

  // 3) Queue backlog probe — reads current job-queue depth from Redis-backed
  //    metrics endpoint and records it against the backlog budget.
  const backlogRes = http.get(`${TARGET_URL}/metrics/queue`, { timeout: "5s" });
  if (backlogRes.status === 200) {
    const backlog = backlogRes.json("backlog");
    if (typeof backlog === "number") {
      queueBacklog.add(backlog);
    }
  }

  sleep(0.01);
}

// ---------------------------------------------------------------------------
// Summary — print key metrics to stdout
// ---------------------------------------------------------------------------

export function handleSummary(data) {
  const rps    = data.metrics.http_reqs?.values?.rate?.toFixed(1) ?? "N/A";
  const p50    = data.metrics.http_req_duration?.values?.["p(50)"]?.toFixed(2) ?? "N/A";
  const p95    = data.metrics.http_req_duration?.values?.["p(95)"]?.toFixed(2) ?? "N/A";
  const p99    = data.metrics.http_req_duration?.values?.["p(99)"]?.toFixed(2) ?? "N/A";
  const errors = (data.metrics.error_rate?.values?.rate * 100)?.toFixed(2) ?? "N/A";

  console.log("\n========================================");
  console.log(`  Benchmark: ${TARGET_URL}  @  ${RPS} req/s`);
  console.log("========================================");
  console.log(`  Throughput : ${rps} req/s`);
  console.log(`  P50 latency: ${p50} ms`);
  console.log(`  P95 latency: ${p95} ms`);
  console.log(`  P99 latency: ${p99} ms`);
  console.log(`  Error rate : ${errors}%`);

  if (SCENARIO === "mixed") {
    const p429    = (data.metrics.provider_429_rate?.values?.rate * 100)?.toFixed(2) ?? "N/A";
    const backlog = data.metrics.queue_backlog?.values?.value?.toFixed(0) ?? "N/A";
    const dbP95   = data.metrics.db_pool_latency_ms?.values?.["p(95)"]?.toFixed(2) ?? "N/A";
    console.log("----------------------------------------");
    console.log(`  Provider 429 : ${p429}%  (budget < ${(PROVIDER_429_MAX * 100).toFixed(0)}%)`);
    console.log(`  Queue backlog: ${backlog}  (budget < ${QUEUE_BACKLOG_MAX})`);
    console.log(`  DB pool P95  : ${dbP95} ms`);
  }

  console.log("========================================\n");

  return {
    stdout: JSON.stringify(data, null, 2),
  };
}
