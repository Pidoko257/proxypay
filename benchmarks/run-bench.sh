#!/usr/bin/env bash
# run-bench.sh — Run full benchmark suite against both services
#
# Prerequisites:
#   - k6 installed (https://k6.io/docs/getting-started/installation/)
#   - Node.js service running on :3001  (cd ingest-node && npm start)
#   - Go service running on :3002       (cd ingest-go && go run main.go)
#   - Redis running on :6379
#
# Usage:
#   chmod +x benchmarks/run-bench.sh
#   ./benchmarks/run-bench.sh
#
# Mixed load scenario (issue #841):
#   ./benchmarks/run-bench.sh --mixed
#   Exercises database pool, provider throttle, and job queue traffic together.
#   Requires PostgreSQL, Redis, and the provider mock server (see below).
#
# Tested budgets (recorded for capacity planning):
#   Instance:  4 vCPU / 8 GiB RAM (c5.xlarge-class)
#   DB pool:   max 20 connections per service instance
#   Postgres:  max_connections=100, shared_buffers=2GB
#   Redis:     maxmemory 1GB, no eviction for queue keys
#   Thresholds: p95 < 250ms, p99 < 500ms, error rate < 1%, queue backlog < 500

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"
mkdir -p "$RESULTS_DIR"

NODE_URL="http://localhost:3001"
GO_URL="http://localhost:3002"
DURATION="30s"

RPS_LEVELS=(1000 5000 10000)

run_bench() {
  local url="$1"
  local rps="$2"
  local label="$3"
  local out="$RESULTS_DIR/${label}-${rps}rps.json"

  echo ""
  echo "▶ Benchmarking $label @ ${rps} req/s  →  $url"
  k6 run \
    -e TARGET_URL="$url" \
    -e RPS="$rps" \
    -e DURATION="$DURATION" \
    --summary-export="$out" \
    "$SCRIPT_DIR/k6-bench.js"
  echo "  Results saved to $out"
}

run_mixed() {
  local out="$RESULTS_DIR/mixed-load.json"
  echo ""
  echo "▶ Mixed load: DB pool + provider throttle + job queue  →  $NODE_URL"
  k6 run \
    -e TARGET_URL="$NODE_URL" \
    -e DURATION="${MIXED_DURATION:-60s}" \
    -e DB_POOL_SIZE="${DB_POOL_SIZE:-20}" \
    -e QUEUE_BACKLOG_MAX="${QUEUE_BACKLOG_MAX:-500}" \
    -e P95_MS="${P95_MS:-250}" \
    -e P99_MS="${P99_MS:-500}" \
    -e ERROR_RATE_MAX="${ERROR_RATE_MAX:-0.01}" \
    --summary-export="$out" \
    "$SCRIPT_DIR/k6-mixed-load.js"
  echo "  Results saved to $out"
}

if [ "${1:-}" = "--mixed" ]; then
  echo "========================================"
  echo "  Mixed Load Test (DB pool / throttle / queue)"
  echo "========================================"
  run_mixed
  echo ""
  echo "  Mixed load complete. Results in: $RESULTS_DIR/mixed-load.json"
  exit 0
fi

echo "========================================"
echo "  Callback Ingestion Benchmark Suite"
echo "========================================"

for rps in "${RPS_LEVELS[@]}"; do
  run_bench "$NODE_URL" "$rps" "node"
done

for rps in "${RPS_LEVELS[@]}"; do
  run_bench "$GO_URL" "$rps" "go"
done

echo ""
echo "========================================"
echo "  All benchmarks complete."
echo "  Results in: $RESULTS_DIR"
echo "========================================"

# Print summary table
echo ""
echo "| Service | RPS Target | Throughput | P50 (ms) | P95 (ms) | P99 (ms) | Errors |"
echo "|---------|-----------|------------|----------|----------|----------|--------|"

for label in node go; do
  for rps in "${RPS_LEVELS[@]}"; do
    f="$RESULTS_DIR/${label}-${rps}rps.json"
    if [ -f "$f" ]; then
      throughput=$(jq -r '.metrics.http_reqs.values.rate // "N/A"' "$f" 2>/dev/null | xargs printf "%.1f")
      p50=$(jq -r '.metrics.http_req_duration.values["p(50)"] // "N/A"' "$f" 2>/dev/null | xargs printf "%.2f")
      p95=$(jq -r '.metrics.http_req_duration.values["p(95)"] // "N/A"' "$f" 2>/dev/null | xargs printf "%.2f")
      p99=$(jq -r '.metrics.http_req_duration.values["p(99)"] // "N/A"' "$f" 2>/dev/null | xargs printf "%.2f")
      err=$(jq -r '.metrics.error_rate.values.rate // 0' "$f" 2>/dev/null | awk '{printf "%.2f%%", $1*100}')
      echo "| $label | $rps | $throughput | $p50 | $p95 | $p99 | $err |"
    fi
  done
done
