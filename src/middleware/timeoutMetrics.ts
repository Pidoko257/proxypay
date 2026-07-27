/**
 * Prometheus metrics for the timeout subsystem.
 *
 * Kept in a separate module so they can be imported by middleware, services,
 * and routes without circular-dependency issues.
 */

import { Counter, Histogram } from "prom-client";
import { register } from "../utils/metrics";

/**
 * Total number of hard timeouts, labelled by operation type and HTTP method.
 */
export const timeoutTotal = new Counter({
  name: "request_timeout_total",
  help: "Total number of request hard timeouts by operation type",
  labelNames: ["operation_type", "method"],
  registers: [register],
});

/**
 * Total number of requests that crossed the slow-request warning threshold.
 */
export const slowRequestTotal = new Counter({
  name: "request_slow_total",
  help: "Total number of requests that exceeded the slow-request warning threshold",
  labelNames: ["operation_type"],
  registers: [register],
});

/**
 * Histogram of request durations for timeout-tracked operations.
 * Covers both timed-out and successful requests so operators can see the
 * full distribution.
 */
export const timeoutDurationSeconds = new Histogram({
  name: "request_timeout_duration_seconds",
  help: "Duration of requests tracked by the adaptive timeout middleware",
  labelNames: ["operation_type"],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180],
  registers: [register],
});

/**
 * Counter for timeout recovery attempts (partial recovery workflow).
 */
export const timeoutRecoveryTotal = new Counter({
  name: "timeout_recovery_total",
  help: "Total number of partial-recovery attempts after a timeout",
  labelNames: ["operation_type", "status"],
  registers: [register],
});
