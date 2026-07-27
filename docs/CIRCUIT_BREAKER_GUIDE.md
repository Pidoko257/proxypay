# Circuit Breaker Pattern Implementation Guide

## Overview

The circuit breaker pattern prevents cascading failures by detecting when external services (mobile money providers) are experiencing problems and temporarily halting requests to those services. This guide explains the implementation, configuration, and monitoring of ProxyPay's circuit breaker system.

## Table of Contents

1. [Architecture](#architecture)
2. [How It Works](#how-it-works)
3. [Configuration](#configuration)
4. [Integration with Mobile Money Providers](#integration-with-mobile-money-providers)
5. [Monitoring & Alerting](#monitoring--alerting)
6. [Best Practices](#best-practices)
7. [Troubleshooting](#troubleshooting)

## Architecture

### Circuit Breaker States

The circuit breaker operates in three states:

```
┌─────────────────────────────────────────────────────┐
│                 CLOSED (Normal)                      │
│ • All requests pass through to provider              │
│ • Success/failure metrics tracked                    │
└────────────────────┬────────────────────────────────┘
                     │
        Error rate > threshold
                     ▼
┌─────────────────────────────────────────────────────┐
│                 OPEN (Failing)                       │
│ • Requests immediately fail with CIRCUIT_OPEN error │
│ • Fallback providers attempted if configured         │
│ • No requests sent to primary provider              │
└────────────────────┬────────────────────────────────┘
                     │
        Reset timeout expires
                     ▼
┌─────────────────────────────────────────────────────┐
│              HALF-OPEN (Testing)                     │
│ • Limited requests allowed to test recovery         │
│ • If success: transition to CLOSED                  │
│ • If failure: return to OPEN                        │
└─────────────────────────────────────────────────────┘
```

### Architecture Diagram

```
MobileMoneyService
       │
       ├─► executeProviderOperation()
       │        │
       │        └─► executeWithCircuitBreaker()
       │                 │
       │                 ├─► CircuitBreakerManager
       │                 │        │
       │                 │        ├─► Get/Create Breaker
       │                 │        ├─► Metrics & Monitoring
       │                 │        └─► State Management
       │                 │
       │                 └─► Provider Operation
       │                      (MTN, Airtel, Orange, etc.)
       │
       └─► Fallback Provider (if enabled)
```

## How It Works

### 1. Request Execution Flow

```typescript
// Example: MTN sendPayout request
const result = await executeWithCircuitBreaker({
  provider: "mtn",
  operation: "sendPayout",
  execute: async () => {
    // Primary operation
    const response = await mtnProvider.sendPayout(phoneNumber, amount);
    return {
      success: response.status === "SUCCESS",
      data: response,
      error: response.status !== "SUCCESS" ? response.error : undefined,
    };
  },
  fallback: async (error) => {
    // Fallback: use Airtel if MTN fails
    const response = await airtelProvider.sendPayout(phoneNumber, amount);
    return {
      success: response.success,
      data: response.data,
      error: response.error,
      isFromFallback: true,
    };
  },
});
```

### 2. Failure Detection

The circuit breaker monitors:

- **Error Rate**: Percentage of failed requests
- **Volume Threshold**: Minimum number of requests before triggering state change
- **Time Window**: Rolling window to track failures (default: 5 minutes)
- **Timeout**: Maximum request duration before automatic failure

When the error rate exceeds the threshold for the configured volume, the circuit **opens**.

### 3. Recovery Testing

When the circuit is open:

1. Requests fail immediately (no provider call)
2. After `resetTimeout` (default: 30 seconds), circuit transitions to **half-open**
3. Limited requests are allowed through to test if the provider recovered
4. If success: circuit **closes** and returns to normal
5. If failure: circuit remains **open** and waits for next reset

## Configuration

### Environment Variables

```bash
# Core Circuit Breaker Settings
PROVIDER_CIRCUIT_BREAKER_TIMEOUT_MS=5000              # Request timeout (ms)
PROVIDER_CIRCUIT_BREAKER_RESET_TIMEOUT_MS=30000       # Time before testing recovery (ms)
PROVIDER_CIRCUIT_BREAKER_ROLLING_WINDOW_MS=300000     # Observation window (5 minutes)
PROVIDER_CIRCUIT_BREAKER_ROLLING_BUCKETS=10           # Buckets in rolling window
PROVIDER_CIRCUIT_BREAKER_VOLUME_THRESHOLD=3           # Min requests before evaluating
PROVIDER_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE=50 # Error % to trigger open

# Failover Settings
PROVIDER_FAILOVER_ENABLED=true                         # Enable failover to backup providers
PROVIDER_BACKUP_MTN=airtel                             # Backup for MTN
PROVIDER_BACKUP_AIRTEL=orange                          # Backup for Airtel
PROVIDER_BACKUP_ORANGE=mtn                             # Backup for Orange
```

### Database Configuration (Provider Settings)

Provider-specific settings can be configured in the database:

```sql
-- Override circuit breaker settings for MTN
UPDATE provider_settings
SET
  timeout_ms = 7000,
  failure_threshold = 5,
  fallback_order = 'airtel'
WHERE provider_name = 'mtn';
```

### Programmatic Configuration

```typescript
const config: CircuitBreakerConfig = {
  timeoutMs: 5000, // Request timeout
  resetTimeoutMs: 30000, // Time to half-open state
  rollingCountTimeoutMs: 300000, // 5-minute window
  rollingCountBuckets: 10, // 10 buckets of 30s each
  volumeThreshold: 3, // Min 3 requests
  errorThresholdPercentage: 50, // Fail if >50% errors
  capacity: 100, // Max concurrent requests
  enableExponentialBackoff: true, // (Future: longer waits on repeated failures)
  maxBackoffMs: 300000, // (Future: max 5 minutes)
};
```

## Integration with Mobile Money Providers

### Using Circuit Breaker in Services

#### Basic Usage

```typescript
import { executeWithCircuitBreakerEnhanced } from "../utils/circuitBreakerEnhanced";

export class MobileMoneyService {
  async sendPayout(
    provider: string,
    phoneNumber: string,
    amount: string,
  ): Promise<{ success: boolean; data?: unknown; error?: unknown }> {
    const config = this.getCircuitBreakerConfig(provider);

    const result = await executeWithCircuitBreakerEnhanced(
      {
        provider,
        operation: "sendPayout",
        execute: async () => {
          const providerInstance = await this.getProvider(provider);
          const response = await providerInstance.sendPayout(
            phoneNumber,
            amount,
          );
          return {
            success: response.success,
            data: response.data,
            error: !response.success ? response.error : undefined,
          };
        },
      },
      config,
    );

    return result.success
      ? { success: true, data: result.data }
      : { success: false, error: result.error };
  }
}
```

#### With Fallback to Backup Provider

```typescript
async executeProviderOperation(
  operation: string,
  primaryProvider: string,
  phoneNumber: string,
  amount: string
): Promise<ProviderResult> {
  const config = this.getCircuitBreakerConfig(primaryProvider);
  const backupProvider = this.getBackupProvider(primaryProvider);

  return executeWithCircuitBreakerEnhanced(
    {
      provider: primaryProvider,
      operation,
      execute: async () => {
        const provider = await this.getProvider(primaryProvider);
        const response = await provider[operation](phoneNumber, amount);
        return {
          success: response.success,
          data: response.data,
          error: response.error,
          provider: primaryProvider,
        };
      },
      // Fallback to backup provider if primary is down
      fallback: async (error) => {
        if (!backupProvider) {
          return { success: false, error };
        }

        logger.warn(
          `Failing over from ${primaryProvider} to ${backupProvider}`,
          { error: error.message }
        );

        const backup = await this.getProvider(backupProvider);
        const response = await backup[operation](phoneNumber, amount);
        return {
          success: response.success,
          data: response.data,
          error: response.error,
          provider: backupProvider,
          isFromFallback: true,
        };
      },
    },
    config
  );
}
```

## Monitoring & Alerting

### Metrics Exposed

The circuit breaker exposes Prometheus metrics:

```
# Gauge: Current state of circuit breaker (0=closed, 0.5=half-open, 1=open)
provider_circuit_breaker_state{provider="mtn",operation="sendPayout"}

# Counter: State transitions
provider_circuit_breaker_transitions_total{
  provider="mtn",
  operation="sendPayout",
  state="open"
}

# Circuit breaker specific metrics
circuit_breaker_failures_total{provider="mtn",operation="sendPayout"}
circuit_breaker_successes_total{provider="mtn",operation="sendPayout"}
circuit_breaker_open_duration_seconds{provider="mtn",operation="sendPayout"}
```

### Status Endpoints

#### Get Status of Single Circuit Breaker

```http
GET /api/admin/circuit-breaker/status?provider=mtn&operation=sendPayout

{
  "provider": "mtn",
  "operation": "sendPayout",
  "state": "closed",
  "consecutiveFailures": 0,
  "successCount": 1250,
  "failureCount": 5,
  "lastStateChange": "2024-07-27T12:00:00Z",
  "nextResetTime": null
}
```

#### Get All Statuses for Provider

```http
GET /api/admin/circuit-breaker/provider/mtn

[
  {
    "provider": "mtn",
    "operation": "sendPayout",
    "state": "closed",
    "successCount": 1250,
    "failureCount": 5
  },
  {
    "provider": "mtn",
    "operation": "requestPayment",
    "state": "closed",
    "successCount": 890,
    "failureCount": 2
  }
]
```

### Grafana Dashboard

Create a Grafana dashboard to visualize:

1. **Circuit Breaker State** (multi-series gauge)
   - Shows current state of each provider operation
   - Color-coded: green (closed), yellow (half-open), red (open)

2. **Provider Error Rates** (graph)
   - Error percentage over time
   - Threshold line at 50%

3. **Failover Events** (counter)
   - Number of times each provider failed over to backup
   - Helps identify chronic issues

4. **Recovery Time** (gauge)
   - Time circuit stays open before recovery
   - Indicates provider stability

### Alerting Rules

#### Alert: Provider Circuit Open

```yaml
- alert: ProviderCircuitBreakerOpen
  expr: provider_circuit_breaker_state{operation="sendPayout"} == 1
  for: 1m
  annotations:
    summary: "{{ $labels.provider }} circuit breaker is OPEN"
    description: "Provider {{ $labels.provider }} has been unreachable for >1 minute"
```

#### Alert: High Failover Rate

```yaml
- alert: HighProviderFailoverRate
  expr: |
    rate(provider_failover_total[5m]) > 0.1
  for: 5m
  annotations:
    summary: "{{ $labels.from_provider }} experiencing high failover rate"
    description: ">10% of requests failing over to {{ $labels.to_provider }}"
```

#### Alert: Circuit Breaker Stuck Open

```yaml
- alert: CircuitBreakerStuckOpen
  expr: |
    (time() - circuit_breaker_last_state_change_seconds) > 300
    and
    provider_circuit_breaker_state == 1
  annotations:
    summary: "{{ $labels.provider }} circuit open for >5 minutes"
    description: "Provider {{ $labels.provider }} may need manual intervention"
```

## Best Practices

### 1. **Timeout Configuration**

```typescript
// ✅ Good: Realistic timeout based on SLA
const config = {
  timeoutMs: 5000, // MTN typical response time: 2-3s
};

// ❌ Bad: Too aggressive
const config = {
  timeoutMs: 100, // Too short, will timeout legitimate requests
};

// ❌ Bad: Too permissive
const config = {
  timeoutMs: 60000, // Too long, holds resources
};
```

### 2. **Threshold Configuration**

```typescript
// ✅ Good: Balance between responsiveness and false positives
const config = {
  volumeThreshold: 5, // At least 5 requests before deciding
  errorThresholdPercentage: 50, // Fail if >50% of recent requests fail
  rollingCountTimeoutMs: 300000, // 5-minute observation window
};

// ❌ Bad: Too sensitive to single failures
const config = {
  volumeThreshold: 1, // Opens on first failure!
  errorThresholdPercentage: 10, // Too strict
};

// ❌ Bad: Ignores real problems
const config = {
  volumeThreshold: 1000, // Never reaches threshold
  errorThresholdPercentage: 90, // Requires almost all to fail
};
```

### 3. **Fallback Strategy**

```typescript
// ✅ Good: Cascade through providers
const fallback = async (error) => {
  // Try backup provider
  const backup = await getBackupProvider();
  if (backup) {
    return executeBackupProvider(backup);
  }

  // Fall back to queue for later retry
  await queueTransaction(transaction);
  return { success: false, queued: true };
};

// ❌ Bad: Cascade infinitely
const fallback = async (error) => {
  // Retry same provider immediately
  return executeOperation();
};

// ❌ Bad: Lose transactions
const fallback = async (error) => {
  return { success: false, error };
};
```

### 4. **Monitoring and Alerting**

```typescript
// ✅ Good: Track meaningful metrics
export function recordCircuitBreakerEvent(
  provider: string,
  operation: string,
  event: "open" | "close" | "half-open" | "failure",
) {
  circuitBreakerMetrics.inc({
    provider,
    operation,
    event,
  });

  if (event === "open") {
    alert.send(`Provider ${provider} circuit opened`);
  }
}

// ❌ Bad: Too noisy
export function recordCircuitBreakerEvent(
  provider: string,
  operation: string,
  event: "open" | "close" | "half-open" | "failure",
) {
  // Alert on every transition (too many alerts)
  alert.send(`Circuit breaker event: ${event}`);
}
```

### 5. **Testing Recovery**

```typescript
// ✅ Good: Realistic health check
async function checkProviderHealth(provider: string): Promise<boolean> {
  try {
    const balance = await provider.getBalance();
    return balance !== null;
  } catch (error) {
    return false;
  }
}

// ❌ Bad: Meaningless check
async function checkProviderHealth(provider: string): Promise<boolean> {
  // Just checks if service is reachable, not if it works
  return fetch(`${provider.baseUrl}/health`).then(() => true);
}
```

### 6. **Provider Configuration**

```typescript
// ✅ Good: Different configs per provider
const configs = {
  mtn: { timeoutMs: 5000, resetTimeoutMs: 30000 }, // Fast, frequent resets
  airtel: { timeoutMs: 8000, resetTimeoutMs: 60000 }, // Slower, longer reset
  orange: { timeoutMs: 3000, resetTimeoutMs: 15000 }, // Very fast, quick recovery
};

// ❌ Bad: One-size-fits-all
const config = { timeoutMs: 5000, resetTimeoutMs: 30000 };
// Doesn't account for actual provider performance differences
```

## Troubleshooting

### Issue: Circuit Breaker Constantly Opening

**Symptoms:**

- `provider_circuit_breaker_state == 1` (open) frequently
- High error rates in logs
- Requests failing with `CIRCUIT_OPEN`

**Diagnosis:**

1. Check provider status:

```bash
curl https://provider.api/health
```

2. Check timeout configuration:

```bash
echo $PROVIDER_CIRCUIT_BREAKER_TIMEOUT_MS  # Should match provider SLA
```

3. Review error logs:

```bash
kubectl logs -f deployment/proxypay --tail=100 | grep "circuit breaker"
```

**Solutions:**

- Increase timeout if provider is genuinely slow
- Add provider to maintenance mode temporarily
- Verify network connectivity to provider
- Check provider API credentials

### Issue: Requests Still Failing After Recovery

**Symptoms:**

- Circuit is `closed` (recovered)
- Requests still intermittently fail
- Error pattern unclear

**Diagnosis:**

1. Check metrics:

```sql
SELECT * FROM metrics
WHERE provider='mtn' AND metric='circuit_breaker_state'
ORDER BY timestamp DESC LIMIT 10;
```

2. Check for transient errors:

```bash
grep -i "temporary\|transient\|timeout" app.log | tail -20
```

**Solutions:**

- Implement exponential backoff in application
- Add jitter to retry logic (prevent thundering herd)
- Check for rate limiting from provider
- Verify request format matches provider expectations

### Issue: Too Many Failover Events

**Symptoms:**

- `provider_failover_total` increasing rapidly
- Requests bouncing between providers
- One provider always fails as backup

**Diagnosis:**

```bash
# Check failover chain
curl http://localhost:3000/api/admin/circuit-breaker/metrics | \
  jq '.[] | select(.provider=="mtn")'
```

**Solutions:**

1. Fix the primary provider issue first
2. Adjust fallback chain to skip unreliable providers:

```bash
PROVIDER_BACKUP_MTN=orange  # Skip Airtel if it's also failing
```

3. Implement failover backoff to avoid cascading failure:

```typescript
if (consecutiveFailovers > 3) {
  // Stop failover, queue for retry
  await queue.add({ operation, priority: "low" });
  return { success: false, queued: true };
}
```

### Issue: Circuit Breaker Not Opening When Expected

**Symptoms:**

- Provider clearly failing but circuit remains `closed`
- No alert being triggered
- Requests still going to failing provider

**Diagnosis:**

1. Check volume threshold:

```bash
echo $PROVIDER_CIRCUIT_BREAKER_VOLUME_THRESHOLD
```

2. Verify error rate:

```
(failures / total) * 100 > ERROR_THRESHOLD_PERCENTAGE?
```

3. Check rolling window:

```bash
echo $PROVIDER_CIRCUIT_BREAKER_ROLLING_WINDOW_MS  # Default: 5 min
```

**Solutions:**

- Lower `VOLUME_THRESHOLD` to catch issues faster
- Lower `ERROR_THRESHOLD_PERCENTAGE` if provider is unreliable
- Increase `ROLLING_WINDOW_MS` to accumulate more data

## Example: Complete Provider Integration

```typescript
import {
  executeWithCircuitBreakerEnhanced,
  getCircuitBreakerStatus,
  resetCircuitBreaker,
} from "./utils/circuitBreakerEnhanced";

export class MobileMoneyOrchestrator {
  private config: Record<string, CircuitBreakerConfig> = {
    mtn: {
      timeoutMs: 5000,
      resetTimeoutMs: 30000,
      rollingCountTimeoutMs: 300000,
      rollingCountBuckets: 10,
      volumeThreshold: 3,
      errorThresholdPercentage: 50,
      capacity: 100,
    },
    airtel: {
      timeoutMs: 8000,
      resetTimeoutMs: 60000,
      rollingCountTimeoutMs: 300000,
      rollingCountBuckets: 10,
      volumeThreshold: 3,
      errorThresholdPercentage: 50,
      capacity: 100,
    },
  };

  async sendPayout(
    providerName: string,
    phoneNumber: string,
    amount: string,
  ): Promise<TransactionResult> {
    const backupProvider = this.getBackupProvider(providerName);

    const result = await executeWithCircuitBreakerEnhanced(
      {
        provider: providerName,
        operation: "sendPayout",
        execute: async () => {
          const provider = await this.loadProvider(providerName);
          const response = await provider.sendPayout(phoneNumber, amount);

          return {
            success: response.status === "SUCCESS",
            data: response,
            error:
              response.status !== "SUCCESS"
                ? new Error(response.message)
                : undefined,
          };
        },
        fallback: backupProvider
          ? async (error) => {
              logger.warn(
                `Failover from ${providerName} to ${backupProvider}: ${error.message}`,
              );

              const backup = await this.loadProvider(backupProvider);
              const response = await backup.sendPayout(phoneNumber, amount);

              return {
                success: response.status === "SUCCESS",
                data: response,
                error:
                  response.status !== "SUCCESS"
                    ? new Error(response.message)
                    : undefined,
                isFromFallback: true,
              };
            }
          : undefined,
      },
      this.config[providerName],
    );

    if (!result.success) {
      // Log and alert on circuit breaker open
      if (result.error?.code === "CIRCUIT_OPEN") {
        const status = getCircuitBreakerStatus(providerName, "sendPayout");
        alertManager.notifyProviderDown(providerName, status);
      }

      throw new TransactionError(
        "PROVIDER_UNAVAILABLE",
        `Provider ${providerName} is unavailable`,
        result.error,
      );
    }

    return {
      transactionId: result.data.id,
      status: "PENDING",
      provider: result.provider,
      durationMs: result.durationMs,
    };
  }
}
```

---

## Related Documentation

- [Resilience Patterns](./RESILIENCE_PATTERNS.md)
- [Mobile Money Integration](./MOBILE_MONEY_INTEGRATION.md)
- [Monitoring & Observability](./MONITORING.md)
- [Provider Configuration](./PROVIDER_CONFIG.md)
