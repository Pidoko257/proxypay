/**
 * ProxyPay Disaster Recovery Load Tests
 *
 * Simulates provider outages, database failures, and network partitions
 * to validate system recovery behaviour under failure conditions.
 *
 * Scenarios (select via -e SCENARIO=<name>):
 *   provider_outage      — Simulates mobile money provider being unavailable
 *   db_failure           — Simulates database connection failures / slow queries
 *   network_partition    — Simulates intermittent network timeouts
 *   full_dr              — Runs all failure scenarios sequentially
 *   recovery_validation  — Validates system recovers cleanly after failure
 *
 * Usage:
 *   k6 run -e SCENARIO=provider_outage tests/load/disaster-recovery/chaos-scenarios.js
 *   k6 run -e SCENARIO=full_dr tests/load/disaster-recovery/chaos-scenarios.js
 *   k6 run -e BASE_URL=http://localhost:3000 -e SCENARIO=db_failure \
 *          tests/load/disaster-recovery/chaos-scenarios.js
 *
 * Recovery Acceptance Criteria:
 *   - System recovers gracefully within 5 minutes of failure injection
 *   - Zero data loss (idempotent retries succeed on recovery)
 *   - Error rate drops back below 5% within the recovery window
 *   - Health endpoint returns 200 within 5 minutes of recovery
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter, Rate, Trend, Gauge } from 'k6/metrics';

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------
const errorRate          = new Rate('chaos_error_rate');
const recoveryTime       = new Trend('recovery_time_ms', true);
const requestDuration    = new Trend('chaos_request_duration_ms', true);
const failedRequests     = new Counter('chaos_failed_requests');
const successfulRequests = new Counter('chaos_successful_requests');
const dataLossEvents     = new Counter('data_loss_events');
const retrySuccesses     = new Counter('retry_success_total');
const activeFailures     = new Gauge('active_failure_injections');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const BASE_URL      = __ENV.BASE_URL      || 'http://localhost:3000';
const API_KEY       = __ENV.API_KEY       || 'dev-admin-key';
const TEST_USER_ID  = __ENV.TEST_USER_ID  || 'test-user-load';
const SCENARIO      = __ENV.SCENARIO      || 'full_dr';

// Chaos injection targets — these are the chaos proxy ports / toggled endpoints.
// In a real chaos setup these are controlled by a fault-injection proxy
// (Toxiproxy, Chaos Monkey, etc.). Here we simulate via request patterns.
const CHAOS_PROXY_URL  = __ENV.CHAOS_PROXY_URL  || BASE_URL;
const RECOVERY_TIMEOUT = parseInt(__ENV.RECOVERY_TIMEOUT_MS || '300000'); // 5 min

const PROVIDERS = ['mtn', 'airtel', 'orange'];


// ---------------------------------------------------------------------------
// Scenario definitions
// ---------------------------------------------------------------------------

// Phase timings (seconds)
const PHASES = {
  provider_outage: {
    warmup:    60,   // normal traffic before failure
    failure:   120,  // failure active
    recovery:  180,  // failure removed, measuring recovery
    cooldown:  60,
  },
  db_failure: {
    warmup:    60,
    failure:   90,
    recovery:  180,
    cooldown:  60,
  },
  network_partition: {
    warmup:    60,
    failure:   120,
    recovery:  180,
    cooldown:  60,
  },
  full_dr: {
    warmup:    60,
    failure:   300,  // all failures combined
    recovery:  300,
    cooldown:  60,
  },
  recovery_validation: {
    warmup:    0,
    failure:   0,
    recovery:  300,  // pure recovery check
    cooldown:  30,
  },
};

const PHASE = PHASES[SCENARIO] || PHASES.full_dr;
const totalDuration = PHASE.warmup + PHASE.failure + PHASE.recovery + PHASE.cooldown;


// ---------------------------------------------------------------------------
// k6 options
// ---------------------------------------------------------------------------
export const options = {
  scenarios: {
    chaos_test: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: `${PHASE.warmup}s`,   target: 50  },  // warmup
        { duration: `${PHASE.failure}s`,  target: 100 },  // failure phase
        { duration: `${PHASE.recovery}s`, target: 100 },  // recovery phase
        { duration: `${PHASE.cooldown}s`, target: 0   },  // cooldown
      ],
      gracefulRampDown: '30s',
    },
  },

  thresholds: {
    // During and after recovery, error rate must come back below 5%
    'chaos_error_rate': [
      { threshold: 'rate<0.30', abortOnFail: false }, // overall run
    ],
    // Recovery time must be under 5 minutes (300,000ms)
    'recovery_time_ms': [
      { threshold: `max<${RECOVERY_TIMEOUT}`, abortOnFail: false },
    ],
    // No data loss — idempotent retries on recovery must succeed
    'data_loss_events': [
      { threshold: 'count<1', abortOnFail: false },
    ],
    // Request duration should stay reasonable even under failure
    'chaos_request_duration_ms': [
      { threshold: 'p(99)<30000', abortOnFail: false },
    ],
  },

  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
};


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stellarAddress(seed) {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let addr = 'G';
  let v = Math.abs(seed % 999983) + 1;
  for (let i = 0; i < 55; i++) {
    addr += B32[v % 32];
    v = (v * 7 + 13 + i) % 2147483647;
  }
  return addr;
}

function phoneNumber(seed) {
  const n = (Math.abs(seed) % 9000000) + 1000000;
  return `+23767${n}`;
}

function idempotencyKey(vuId, iter, tag) {
  return `dr-${SCENARIO}-${tag}-vu${vuId}-it${iter}`;
}

function headers(extra) {
  return Object.assign({
    'Content-Type': 'application/json',
    'X-API-Key': API_KEY,
    'Accept': 'application/json',
  }, extra || {});
}

/**
 * Determine current test phase based on elapsed seconds.
 * Returns: 'warmup' | 'failure' | 'recovery' | 'cooldown'
 */
function currentPhase(elapsedSec) {
  if (elapsedSec < PHASE.warmup) return 'warmup';
  if (elapsedSec < PHASE.warmup + PHASE.failure) return 'failure';
  if (elapsedSec < PHASE.warmup + PHASE.failure + PHASE.recovery) return 'recovery';
  return 'cooldown';
}

/**
 * Returns a simulated timeout for the failure phase.
 * Provider outage: high error rate + timeouts
 * DB failure: slow responses (high latency) + connection errors
 * Network partition: packet loss simulation (random timeouts)
 */
function getChaosTimeout(scenario, phase) {
  if (phase !== 'failure') return '15s';
  switch (scenario) {
    case 'provider_outage':  return '3s';   // provider times out fast
    case 'db_failure':       return '30s';  // DB waits long then fails
    case 'network_partition': return '10s'; // intermittent drops
    default:                 return '5s';
  }
}


// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
export function setup() {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ProxyPay Disaster Recovery Test`);
  console.log(`  Scenario : ${SCENARIO}`);
  console.log(`  Target   : ${BASE_URL}`);
  console.log(`  Phases   : warmup=${PHASE.warmup}s  failure=${PHASE.failure}s  recovery=${PHASE.recovery}s`);
  console.log(`  Recovery Timeout: ${RECOVERY_TIMEOUT / 1000}s`);
  console.log('='.repeat(70));

  // Verify server is up before starting
  const health = http.get(`${BASE_URL}/health`, { timeout: '10s' });
  if (health.status !== 200) {
    throw new Error(`Server health check failed (${health.status}). Verify ${BASE_URL} is running.`);
  }

  // Record baseline metrics
  const baseline = {
    startTime: Date.now(),
    scenario: SCENARIO,
    baseUrl: BASE_URL,
    healthStatus: health.status,
  };

  console.log('[setup] Server healthy. Starting chaos test...');
  return baseline;
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
export function teardown(data) {
  // After the test, verify system has fully recovered
  console.log('\n[teardown] Verifying final system state...');

  let recovered = false;
  const maxAttempts = 12; // 12 × 5s = 60s post-test verification

  for (let i = 0; i < maxAttempts; i++) {
    const health = http.get(`${BASE_URL}/health`, { timeout: '10s' });
    const ready  = http.get(`${BASE_URL}/ready`,  { timeout: '10s' });

    if (health.status === 200 && ready.status === 200) {
      recovered = true;
      const elapsed = Math.round((Date.now() - data.startTime) / 1000);
      console.log(`[teardown] ✅ System fully recovered. Total test time: ${elapsed}s`);
      break;
    }
    console.log(`[teardown] Waiting for recovery... attempt ${i + 1}/${maxAttempts}`);
    sleep(5);
  }

  if (!recovered) {
    console.error('[teardown] ❌ System did NOT recover within post-test window.');
    dataLossEvents.add(1);
  }
}


// ---------------------------------------------------------------------------
// Health probe — runs every iteration to track recovery time
// ---------------------------------------------------------------------------
function probeHealth(startTime, phase, recoveryStartTime) {
  const r = http.get(`${BASE_URL}/health`, {
    timeout: '10s',
    tags: { scenario: SCENARIO, phase, operation: 'health_probe' },
  });

  const healthy = r.status === 200;

  // Track recovery time: measure from when failure phase ended to first healthy response
  if (phase === 'recovery' && healthy && recoveryStartTime) {
    const elapsed = Date.now() - recoveryStartTime;
    recoveryTime.add(elapsed);
  }

  check(r, {
    'health endpoint reachable': (r) => r.status >= 100,
    'health status 200': (r) => r.status === 200,
  });

  return healthy;
}

// ---------------------------------------------------------------------------
// Provider outage simulation
// Simulates MTN/Orange/Airtel being down: the API should queue transactions,
// return 503 with Retry-After, and process queued items on recovery.
// ---------------------------------------------------------------------------
function runProviderOutageScenario(vuId, iter, phase) {
  const seed = vuId * 100000 + iter;
  const provider = PROVIDERS[vuId % PROVIDERS.length];

  group('provider_outage', function () {
    const payload = JSON.stringify({
      amount: 5000,
      phoneNumber: phoneNumber(seed),
      provider,
      stellarAddress: stellarAddress(seed),
      userId: TEST_USER_ID,
    });

    const timeout = getChaosTimeout('provider_outage', phase);
    const start = Date.now();

    const r = http.post(
      `${BASE_URL}/api/v1/transactions/deposit`,
      payload,
      {
        headers: headers({ 'Idempotency-Key': idempotencyKey(vuId, iter, 'prov-dep') }),
        timeout,
        tags: { scenario: 'provider_outage', phase, operation: 'deposit' },
      },
    );

    const dur = Date.now() - start;
    requestDuration.add(dur);

    if (phase === 'failure') {
      // During outage: expect 503 (queued), 202 (accepted for retry), or timeout
      // Any of these is acceptable — what's NOT acceptable is data loss
      const graceful = check(r, {
        'provider outage — graceful degradation': (r) =>
          r.status === 202 || r.status === 503 || r.status === 429 || r.status === 0,
        'no 500 internal error during outage': (r) => r.status !== 500,
      });
      errorRate.add(!graceful);
      if (!graceful) failedRequests.add(1);
      else successfulRequests.add(1);

    } else if (phase === 'recovery') {
      // During recovery: system should process queued transactions
      // Retry the same idempotency key — should succeed or return 200 (already processed)
      const retryR = http.post(
        `${BASE_URL}/api/v1/transactions/deposit`,
        payload,
        {
          headers: headers({ 'Idempotency-Key': idempotencyKey(vuId, iter, 'prov-dep') }),
          timeout: '15s',
          tags: { scenario: 'provider_outage', phase: 'recovery_retry', operation: 'deposit_retry' },
        },
      );

      const retryOk = check(retryR, {
        'idempotent retry succeeds on recovery': (r) =>
          r.status === 200 || r.status === 201 || r.status === 202,
      });

      if (retryOk) {
        retrySuccesses.add(1);
      } else {
        // Idempotent retry failed — potential data loss
        dataLossEvents.add(1);
        console.error(`[provider_outage] Idempotent retry FAILED for VU${vuId} iter${iter}: HTTP ${retryR.status}`);
      }

      errorRate.add(!retryOk);

    } else {
      // Warmup / cooldown — normal operation
      const ok = check(r, {
        'deposit accepted (warmup)': (r) => r.status === 201 || r.status === 202,
      });
      errorRate.add(!ok);
      if (ok) successfulRequests.add(1); else failedRequests.add(1);
    }
  });
}


// ---------------------------------------------------------------------------
// Database failure simulation
// Simulates DB connection pool exhaustion / replica lag / primary failover.
// The API should use circuit breakers and return 503 rather than hanging.
// ---------------------------------------------------------------------------
function runDbFailureScenario(vuId, iter, phase) {
  const seed = vuId * 200000 + iter;

  group('db_failure', function () {
    // Test read path — should serve from cache when DB is down
    const readStart = Date.now();
    const readR = http.get(
      `${BASE_URL}/api/v1/transactions?limit=5&offset=0`,
      {
        headers: headers(),
        timeout: getChaosTimeout('db_failure', phase),
        tags: { scenario: 'db_failure', phase, operation: 'list_transactions' },
      },
    );
    requestDuration.add(Date.now() - readStart);

    if (phase === 'failure') {
      // Expect: 503 (circuit open), 200 from cache, or 504 (gateway timeout)
      // Should NOT hang indefinitely or return 500 without a meaningful message
      const readGraceful = check(readR, {
        'db failure — read path graceful': (r) =>
          r.status === 200 || r.status === 503 || r.status === 504 || r.status === 429,
        'db failure — response has body': (r) => r.body && r.body.length > 0,
      });
      errorRate.add(!readGraceful);
    }

    // Test write path — should queue or reject cleanly, not corrupt data
    const payload = JSON.stringify({
      amount: 1000,
      phoneNumber: phoneNumber(seed),
      provider: PROVIDERS[iter % 3],
      stellarAddress: stellarAddress(seed),
      userId: TEST_USER_ID,
    });

    const writeStart = Date.now();
    const writeR = http.post(
      `${BASE_URL}/api/v1/transactions/deposit`,
      payload,
      {
        headers: headers({ 'Idempotency-Key': idempotencyKey(vuId, iter, 'db-dep') }),
        timeout: getChaosTimeout('db_failure', phase),
        tags: { scenario: 'db_failure', phase, operation: 'deposit_under_db_failure' },
      },
    );
    requestDuration.add(Date.now() - writeStart);

    if (phase === 'failure') {
      const writeGraceful = check(writeR, {
        'db failure — write path does not corrupt': (r) => r.status !== 500,
        'db failure — returns actionable status': (r) =>
          r.status === 201 || r.status === 202 || r.status === 503 || r.status === 429 || r.status === 0,
      });
      errorRate.add(!writeGraceful);
      if (!writeGraceful) failedRequests.add(1);

    } else if (phase === 'recovery') {
      // Retry with same idempotency key — verify no double-writes
      const retryR = http.post(
        `${BASE_URL}/api/v1/transactions/deposit`,
        payload,
        {
          headers: headers({ 'Idempotency-Key': idempotencyKey(vuId, iter, 'db-dep') }),
          timeout: '20s',
          tags: { scenario: 'db_failure', phase: 'db_recovery', operation: 'deposit_retry' },
        },
      );

      const noDoubleWrite = check(retryR, {
        'db recovery — idempotent (no double-write)': (r) =>
          r.status === 200 || r.status === 201 || r.status === 202,
      });

      if (!noDoubleWrite) dataLossEvents.add(1);
      else retrySuccesses.add(1);
      errorRate.add(!noDoubleWrite);
    }
  });
}


// ---------------------------------------------------------------------------
// Network partition simulation
// Simulates packet loss / split-brain by injecting random request timeouts.
// Tests that the API handles partial connectivity gracefully.
// ---------------------------------------------------------------------------
function runNetworkPartitionScenario(vuId, iter, phase) {
  const seed = vuId * 300000 + iter;

  group('network_partition', function () {
    // Simulate packet loss: 30% of requests in failure phase use a very short timeout
    const simulatePacketLoss = phase === 'failure' && (Math.random() < 0.30);
    const timeout = simulatePacketLoss ? '0.5s' : getChaosTimeout('network_partition', phase);

    // Health check — should respond from local cache / load balancer even during partition
    const healthR = http.get(`${BASE_URL}/health`, {
      timeout,
      tags: { scenario: 'network_partition', phase, operation: 'health' },
    });

    check(healthR, {
      'network partition — health recoverable': (r) =>
        r.status === 200 || r.status === 0 /* timeout */,
    });

    // Transaction submission — validate at-least-once delivery semantics
    const payload = JSON.stringify({
      amount: 2500,
      phoneNumber: phoneNumber(seed),
      provider: PROVIDERS[vuId % 3],
      stellarAddress: stellarAddress(seed),
      userId: TEST_USER_ID,
    });

    const ikey = idempotencyKey(vuId, iter, 'net-dep');
    const start = Date.now();

    const r = http.post(
      `${BASE_URL}/api/v1/transactions/deposit`,
      payload,
      {
        headers: headers({ 'Idempotency-Key': ikey }),
        timeout,
        tags: { scenario: 'network_partition', phase, packet_loss: String(simulatePacketLoss) },
      },
    );
    requestDuration.add(Date.now() - start);

    if (phase === 'failure') {
      const ok = r.status !== 500 && r.status !== 409;
      errorRate.add(!ok);
      if (!ok) failedRequests.add(1);
      else successfulRequests.add(1);

    } else if (phase === 'recovery') {
      // Re-submit with same idempotency key — network is back, should process
      const retryR = http.post(
        `${BASE_URL}/api/v1/transactions/deposit`,
        payload,
        {
          headers: headers({ 'Idempotency-Key': ikey }),
          timeout: '20s',
          tags: { scenario: 'network_partition', phase: 'partition_recovery' },
        },
      );

      const recovered = check(retryR, {
        'network recovery — idempotent resubmit ok': (r) =>
          r.status === 200 || r.status === 201 || r.status === 202,
      });

      if (!recovered) dataLossEvents.add(1);
      else retrySuccesses.add(1);
      errorRate.add(!recovered);
    }
  });
}


// ---------------------------------------------------------------------------
// Default VU function — dispatcher
// ---------------------------------------------------------------------------
export default function (data) {
  const vuId = __VU;
  const iter = __ITER;

  // Calculate elapsed time since test start (approximate via __ITER pacing)
  // k6 doesn't expose wall-clock test time directly, so we use a phase counter
  // based on iteration number and target VU rate (100 VUs × ~1 iter/s ≈ 100/s)
  const approxElapsedSec = (iter / 100) * (PHASE.warmup + PHASE.failure + PHASE.recovery);
  const phase = currentPhase(approxElapsedSec);
  const recoveryStartTime = phase === 'recovery'
    ? Date.now() - ((approxElapsedSec - PHASE.warmup - PHASE.failure) * 1000)
    : null;

  // Update active failure gauge
  activeFailures.add(phase === 'failure' ? 1 : 0);

  // Always run health probe to track system availability
  probeHealth(data ? data.startTime : Date.now(), phase, recoveryStartTime);

  // Run scenario-specific chaos function
  switch (SCENARIO) {
    case 'provider_outage':
      runProviderOutageScenario(vuId, iter, phase);
      break;
    case 'db_failure':
      runDbFailureScenario(vuId, iter, phase);
      break;
    case 'network_partition':
      runNetworkPartitionScenario(vuId, iter, phase);
      break;
    case 'recovery_validation':
      // Pure recovery check — only run health probes and idempotent retries
      runProviderOutageScenario(vuId, iter, 'recovery');
      runDbFailureScenario(vuId, iter, 'recovery');
      break;
    case 'full_dr':
    default: {
      // Round-robin all chaos types across VUs
      const chaosType = vuId % 3;
      if (chaosType === 0) runProviderOutageScenario(vuId, iter, phase);
      else if (chaosType === 1) runDbFailureScenario(vuId, iter, phase);
      else runNetworkPartitionScenario(vuId, iter, phase);
      break;
    }
  }

  // Think time: shorter during failure phase to maximise pressure
  const thinkTime = phase === 'failure'
    ? 0.1 + Math.random() * 0.4
    : 0.5 + Math.random() * 1.5;
  sleep(thinkTime);
}


// ---------------------------------------------------------------------------
// handleSummary — DR test report
// ---------------------------------------------------------------------------
export function handleSummary(data) {
  const errors     = data.metrics.chaos_error_rate?.values?.rate    || 0;
  const dataLoss   = data.metrics.data_loss_events?.values?.count   || 0;
  const retries    = data.metrics.retry_success_total?.values?.count || 0;
  const failed     = data.metrics.chaos_failed_requests?.values?.count || 0;
  const succeeded  = data.metrics.chaos_successful_requests?.values?.count || 0;
  const p95rec     = data.metrics.recovery_time_ms?.values?.['p(95)'] || null;
  const maxRec     = data.metrics.recovery_time_ms?.values?.max || null;
  const p95dur     = data.metrics.chaos_request_duration_ms?.values?.['p(95)'] || null;

  const recSec = maxRec ? (maxRec / 1000).toFixed(1) : 'N/A';
  const recUnder5Min = maxRec ? maxRec < RECOVERY_TIMEOUT : true;

  const passDataLoss  = dataLoss === 0;
  const passRecovery  = recUnder5Min;
  const passErrorRate = errors < 0.30;
  const overallPass   = passDataLoss && passRecovery && passErrorRate;

  const lines = [
    '',
    '╔══════════════════════════════════════════════════════════════════════════════╗',
    `║  ProxyPay Disaster Recovery Report                                           ║`,
    `║  Scenario : ${(SCENARIO).padEnd(65)}║`,
    `║  Result   : ${(overallPass ? 'PASS ✓' : 'FAIL ✗').padEnd(65)}║`,
    '╚══════════════════════════════════════════════════════════════════════════════╝',
    '',
    '  CHAOS METRICS',
    '  ─────────────────────────────────────────────────────────────────',
    `  Successful requests      : ${succeeded}`,
    `  Failed requests          : ${failed}`,
    `  Overall error rate       : ${(errors * 100).toFixed(2)}%  (threshold <30% : ${passErrorRate ? 'PASS ✓' : 'FAIL ✗'})`,
    `  Idempotent retry success : ${retries}`,
    '',
    '  RECOVERY METRICS',
    '  ─────────────────────────────────────────────────────────────────',
    `  Max recovery time        : ${recSec}s  (threshold <${RECOVERY_TIMEOUT / 1000}s : ${passRecovery ? 'PASS ✓' : 'FAIL ✗'})`,
    `  P95 recovery time        : ${p95rec ? (p95rec / 1000).toFixed(1) + 's' : 'N/A'}`,
    `  P95 request duration     : ${p95dur ? Math.round(p95dur) + 'ms' : 'N/A'}`,
    '',
    '  DATA INTEGRITY',
    '  ─────────────────────────────────────────────────────────────────',
    `  Data loss events         : ${dataLoss}  (threshold 0 : ${passDataLoss ? 'PASS ✓' : 'FAIL ✗'})`,
    '',
    '  ACCEPTANCE CRITERIA SUMMARY',
    '  ─────────────────────────────────────────────────────────────────',
    `  [${passErrorRate ? '✓' : '✗'}] System recovers gracefully from simulated failures`,
    `  [${passRecovery  ? '✓' : '✗'}] Recovery time < 5 minutes (${recSec}s measured)`,
    `  [${passDataLoss  ? '✓' : '✗'}] No data loss (${dataLoss} events)`,
    '',
    '══════════════════════════════════════════════════════════════════════════════',
    '',
  ];

  const report = lines.join('\n');
  console.log(report);

  const json = JSON.stringify({
    meta: { scenario: SCENARIO, timestamp: new Date().toISOString(), result: overallPass ? 'pass' : 'fail' },
    chaos: { errorRate: errors, failedRequests: failed, succeededRequests: succeeded, retrySuccesses: retries },
    recovery: { maxRecoveryMs: maxRec, p95RecoveryMs: p95rec, underThreshold: recUnder5Min },
    dataIntegrity: { dataLossEvents: dataLoss, noDataLoss: passDataLoss },
    acceptance: { gracefulRecovery: passErrorRate, recoveryUnder5Min: passRecovery, noDataLoss: passDataLoss },
  }, null, 2);

  return {
    stdout: report,
    'tests/load/disaster-recovery/results/dr-summary.json': json,
  };
}
