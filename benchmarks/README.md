# Benchmarks

This directory contains load and performance testing scripts.

## WebSocket Load Testing

### Purpose

Test WebSocket server's ability to handle concurrent connections with real-time transaction status updates. Target: 1000+ concurrent connections.

### WebSocket Benchmarks

#### Node.js Load Test (Recommended)

Fast, dependency-light load testing using Node.js WebSocket.

**Usage:**

```bash
# 1000 concurrent connections for 60 seconds
node benchmarks/ws-load-test.mjs --connections=1000 --duration=60 --token='your-jwt-token'

# 5000 concurrent connections for 120 seconds
node benchmarks/ws-load-test.mjs --connections=5000 --duration=120 --token='your-jwt-token'

# Custom server URL
node benchmarks/ws-load-test.mjs \
  --url=ws://ws-server.example.com \
  --connections=2000 \
  --duration=60 \
  --token='your-jwt-token'
```

**Options:**

- `--connections` - Number of concurrent connections (default: 1000)
- `--duration` - Test duration in seconds (default: 60)
- `--url` - WebSocket server URL (default: ws://localhost:3000)
- `--token` - JWT token for authentication (required)
- `--transactions` - Number of transactions per connection (default: 10)
- `--message-rate` - Messages per second per connection (default: 1)
- `--debug` - Enable debug logging

**Output:**

Displays real-time metrics and final summary including:
- Connection success/failure rates
- Message throughput (msg/sec)
- Subscription acknowledgments
- Transaction updates received
- Error rates and details

#### k6 Load Test

Professional load testing framework with advanced features.

**Installation:**

```bash
# macOS
brew install k6

# Linux
sudo apt install k6

# Or download from https://k6.io/docs/getting-started/installation/
```

**Usage:**

```bash
# 100 concurrent connections for 30 seconds
k6 run -e TARGET_URL=ws://localhost:3000 -e CONNECTIONS=100 benchmarks/ws-load-test.js

# 1000 concurrent connections for 60 seconds
k6 run -e TARGET_URL=ws://localhost:3000 -e CONNECTIONS=1000 -e DURATION=60s benchmarks/ws-load-test.js

# 5000 concurrent connections for 120 seconds
k6 run \
  -e TARGET_URL=ws://localhost:3000 \
  -e CONNECTIONS=5000 \
  -e DURATION=120s \
  benchmarks/ws-load-test.js
```

**Environment Variables:**

- `TARGET_URL` - WebSocket URL (default: ws://localhost:3000)
- `CONNECTIONS` - Number of concurrent connections (default: 1000)
- `DURATION` - Test duration (default: 60s)
- `TRANSACTION_COUNT` - Transactions per connection (default: 10)
- `JWT_TOKEN` - JWT token for authentication

---

## Soroban Gas Benchmark

### Purpose

This benchmark measures Soroban gas usage for the Escrow contract methods.

### Description

- Build the `contracts/escrow` Soroban contract.
- Deploy it locally through the Soroban CLI.
- Invoke common contract methods.
- Parse and report gas usage for each method.

### Usage

1. Build the Escrow contract:

```bash
npm run contracts:build
```

2. Run the benchmark:

```bash
npm run bench:soroban-gas
```

3. Optional environment variables:

- `SOROBAN_NETWORK` - Soroban network name, default is `local`.
- `SOROBAN_RPC_URL` - RPC URL to use instead of a named network.
- `SOROBAN_SECRET_KEY` - Secret key used to invoke contract methods.
- `SKIP_BUILD=1` - Skip WASM build if the contract is already compiled.

### Notes

- The script requires the Soroban CLI installed and available in `PATH`.
- If the CLI is unavailable, the script will still emit the current WASM size and instructions.
- `soroban` output must include gas metrics for the script to parse them correctly.
