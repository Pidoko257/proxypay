# Circuit Breaker Integration Examples

This document provides practical examples of how to use the circuit breaker pattern in ProxyPay.

## Table of Contents

1. [Basic Usage](#basic-usage)
2. [With Fallback Providers](#with-fallback-providers)
3. [Checking Circuit Status](#checking-circuit-status)
4. [Manual Recovery](#manual-recovery)
5. [Monitoring](#monitoring)
6. [Error Handling](#error-handling)

## Basic Usage

### Simple Protected Call

```typescript
import { executeWithCircuitBreakerEnhanced } from "../utils/circuitBreakerEnhanced";
import { CircuitBreakerConfig } from "../utils/circuitBreakerEnhanced";

const config: CircuitBreakerConfig = {
  timeoutMs: 5000,
  resetTimeoutMs: 30000,
  rollingCountTimeoutMs: 300000,
  rollingCountBuckets: 10,
  volumeThreshold: 3,
  errorThresholdPercentage: 50,
  capacity: 100,
};

async function sendPayoutWithCircuitBreaker(
  phoneNumber: string,
  amount: string,
): Promise<{ success: boolean; data?: unknown; error?: unknown }> {
  const result = await executeWithCircuitBreakerEnhanced(
    {
      provider: "mtn",
      operation: "sendPayout",
      execute: async () => {
        const mtnProvider = await loadMTNProvider();
        const response = await mtnProvider.sendPayout(phoneNumber, amount);

        return {
          success: response.status === "SUCCESS",
          data: response,
          error:
            response.status !== "SUCCESS"
              ? new Error(response.message)
              : undefined,
        };
      },
    },
    config,
  );

  if (result.success) {
    return { success: true, data: result.data };
  } else {
    return { success: false, error: result.error };
  }
}
```

## With Fallback Providers

### Primary + Backup Provider Failover

```typescript
async function sendPayoutWithFailover(
  phoneNumber: string,
  amount: string,
): Promise<{
  success: boolean;
  provider: string;
  data?: unknown;
  error?: unknown;
}> {
  const config: CircuitBreakerConfig = {
    timeoutMs: 5000,
    resetTimeoutMs: 30000,
    rollingCountTimeoutMs: 300000,
    rollingCountBuckets: 10,
    volumeThreshold: 3,
    errorThresholdPercentage: 50,
    capacity: 100,
  };

  const result = await executeWithCircuitBreakerEnhanced(
    {
      provider: "mtn",
      operation: "sendPayout",
      execute: async () => {
        logger.debug("Attempting MTN payout", { phoneNumber, amount });
        const mtn = await loadMTNProvider();
        const response = await mtn.sendPayout(phoneNumber, amount);

        return {
          success: response.status === "SUCCESS",
          provider: "mtn",
          data: response,
          error:
            response.status !== "SUCCESS"
              ? new Error(response.message)
              : undefined,
        };
      },
      // Fallback to Airtel if MTN fails or circuit is open
      fallback: async (error) => {
        logger.warn("MTN failed, falling over to Airtel", {
          phoneNumber,
          error: error.message,
        });

        try {
          const airtel = await loadAirtelProvider();
          const response = await airtel.sendPayout(phoneNumber, amount);

          return {
            success: response.success,
            provider: "airtel",
            data: response,
            error: response.error ? new Error(response.error) : undefined,
            isFromFallback: true,
          };
        } catch (airtelError) {
          logger.error("Both MTN and Airtel failed", {
            phoneNumber,
            mtnError: error.message,
            airtelError:
              airtelError instanceof Error
                ? airtelError.message
                : String(airtelError),
          });

          return {
            success: false,
            provider: "none",
            error: new Error(
              `All providers failed: MTN(${error.message}), Airtel(${airtelError})`,
            ),
          };
        }
      },
    },
    config,
  );

  return {
    success: result.success,
    provider: result.provider || (result.isFromFallback ? "airtel" : "mtn"),
    data: result.data,
    error: result.error,
  };
}
```

### Three-Tier Fallback Chain

```typescript
async function sendPayoutWithChain(
  phoneNumber: string,
  amount: string,
): Promise<PayoutResult> {
  const config = getCircuitBreakerConfig("mtn");
  const providers = ["mtn", "airtel", "orange"];
  let lastError: unknown;

  for (const provider of providers) {
    try {
      const result = await executeWithCircuitBreakerEnhanced(
        {
          provider,
          operation: "sendPayout",
          execute: async () => {
            const instance = await loadProvider(provider);
            const response = await instance.sendPayout(phoneNumber, amount);
            return {
              success: response.status === "SUCCESS",
              provider,
              data: response,
              error: response.status !== "SUCCESS" ? response.error : undefined,
            };
          },
        },
        config,
      );

      if (result.success) {
        logger.info("Payout succeeded", { provider, phoneNumber });
        return { success: true, provider, data: result.data };
      }

      lastError = result.error;
    } catch (error) {
      lastError = error;
      logger.warn(`Provider ${provider} failed, trying next`, { error });
    }
  }

  logger.error("All providers exhausted", { lastError, phoneNumber });
  throw new PayoutError("All providers failed", lastError);
}
```

## Checking Circuit Status

### Check Single Operation

```typescript
import { getCircuitBreakerStatus } from "../utils/circuitBreakerEnhanced";

function checkMTNPayoutHealth(): boolean {
  const status = getCircuitBreakerStatus("mtn", "sendPayout");

  if (status.state === "open") {
    logger.warn("MTN payout circuit is open", {
      failureCount: status.failureCount,
      lastChange: status.lastStateChange,
    });
    return false;
  }

  if (status.state === "half-open") {
    logger.info("MTN payout circuit is testing recovery");
    return true; // Allow requests through for testing
  }

  return true; // Circuit is closed, all good
}
```

### Check All Provider Operations

```typescript
import { getProviderCircuitBreakerStatuses } from "../utils/circuitBreakerEnhanced";

function getProviderHealth(provider: string): HealthStatus {
  const statuses = getProviderCircuitBreakerStatuses(provider);

  const openCount = statuses.filter((s) => s.state === "open").length;
  const halfOpenCount = statuses.filter((s) => s.state === "half-open").length;

  return {
    provider,
    healthy: openCount === 0,
    degraded: halfOpenCount > 0,
    details: statuses,
  };
}

// Usage
const mtnHealth = getProviderHealth("mtn");
if (mtnHealth.healthy) {
  console.log("✅ MTN is healthy");
} else if (mtnHealth.degraded) {
  console.log("⚠️ MTN is degraded, recovery in progress");
} else {
  console.log("❌ MTN is down");
}
```

## Manual Recovery

### Reset Specific Circuit

```typescript
import { resetCircuitBreaker } from "../utils/circuitBreakerEnhanced";

// Called by operations team when provider is confirmed recovered
function manualRecovery(provider: string, operation: string): void {
  resetCircuitBreaker(provider, operation);
  logger.info(`Circuit breaker manually reset for ${provider}:${operation}`);

  // Send alert to ops team
  alertManager.notify({
    level: "info",
    title: `Manual recovery: ${provider}`,
    message: `Circuit breaker for ${provider}:${operation} has been reset`,
  });
}

// Usage
manualRecovery("mtn", "sendPayout");
```

### Reset All Circuits for Provider

```typescript
import { resetAllCircuitBreakers } from "../utils/circuitBreakerEnhanced";

function recoveryDrillForProvider(provider: string): void {
  resetAllCircuitBreakers(provider);
  logger.info(`All circuit breakers reset for ${provider}`);

  // Trigger health check
  checkProviderHealth(provider);
}

// Usage: After maintenance on provider
recoveryDrillForProvider("airtel");
```

## Monitoring

### Health Check Endpoint

```typescript
import { getCircuitBreakerMetrics } from "../utils/circuitBreakerEnhanced";
import express, { Request, Response } from "express";

const app = express();

app.get("/api/health/circuit-breaker", (_req: Request, res: Response) => {
  const metrics = getCircuitBreakerMetrics();

  const summary = {
    timestamp: new Date().toISOString(),
    totalBreakers: Object.values(metrics).reduce(
      (sum, ops) => sum + ops.length,
      0,
    ),
    open: Object.values(metrics).reduce(
      (sum, ops) => sum + ops.filter((s) => s.state === "open").length,
      0,
    ),
    halfOpen: Object.values(metrics).reduce(
      (sum, ops) => sum + ops.filter((s) => s.state === "half-open").length,
      0,
    ),
    closed: Object.values(metrics).reduce(
      (sum, ops) => sum + ops.filter((s) => s.state === "closed").length,
      0,
    ),
  };

  const isHealthy = summary.open === 0 && summary.halfOpen === 0;

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? "healthy" : "degraded",
    ...summary,
    providers: metrics,
  });
});
```

### Prometheus Exporter

```typescript
import { register } from "prom-client";

app.get("/metrics", async (_req: Request, res: Response) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

// Metrics automatically exposed by circuit breaker:
// - provider_circuit_breaker_state
// - provider_circuit_breaker_transitions_total
// - provider_failures_total
// - provider_failover_total
```

## Error Handling

### Distinguishing Error Types

```typescript
import {
  executeWithCircuitBreakerEnhanced,
  isCircuitBreakerOpenError,
} from "../utils/circuitBreakerEnhanced";

async function robustPayout(
  phoneNumber: string,
  amount: string,
): Promise<void> {
  try {
    const result = await executeWithCircuitBreakerEnhanced(
      {
        provider: "mtn",
        operation: "sendPayout",
        execute: async () => {
          // ... implementation
        },
      },
      config,
    );

    if (!result.success) {
      throw result.error || new Error("Unknown error");
    }
  } catch (error) {
    if (isCircuitBreakerOpenError(error)) {
      // Circuit is open - provider is down
      logger.error("Provider is down", { provider: "mtn" });
      // Queue for retry
      await transactionQueue.add({
        type: "payout",
        phoneNumber,
        amount,
        retryCount: 0,
      });
    } else if (error instanceof NetworkError) {
      // Network issue - retry immediately
      logger.warn("Network error, retrying", { error: error.message });
      await robustPayout(phoneNumber, amount);
    } else {
      // Other error - log and alert
      logger.error("Payout failed", { error, phoneNumber });
      throw error;
    }
  }
}
```

### Retry with Exponential Backoff

```typescript
async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  initialDelayMs: number = 1000,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt < maxRetries - 1) {
        const delayMs = initialDelayMs * Math.pow(2, attempt);
        logger.info(`Retry attempt ${attempt + 1} after ${delayMs}ms`, {
          error: error instanceof Error ? error.message : String(error),
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}

// Usage with circuit breaker
const result = await retryWithBackoff(
  async () => {
    return executeWithCircuitBreakerEnhanced(
      {
        provider: "mtn",
        operation: "sendPayout",
        execute: async () => {
          // ... operation
        },
      },
      config,
    );
  },
  3,
  1000,
);
```

### Graceful Degradation

```typescript
async function sendPayoutGraceful(
  phoneNumber: string,
  amount: string,
): Promise<PayoutResult> {
  // Try primary with circuit breaker
  const primaryResult = await executeWithCircuitBreakerEnhanced(
    {
      provider: "mtn",
      operation: "sendPayout",
      execute: async () => {
        // ...
      },
    },
    config,
  );

  if (primaryResult.success) {
    return { success: true, provider: "mtn", data: primaryResult.data };
  }

  // Check if circuit is open
  const status = getCircuitBreakerStatus("mtn", "sendPayout");
  if (status.state === "open") {
    // Circuit is open, queue for later
    logger.warn("Provider down, queuing transaction", { phoneNumber });
    await queue.add({ phoneNumber, amount });
    return { success: false, queued: true, provider: "none" };
  }

  // Try backup provider
  logger.info("Trying backup provider", { phoneNumber });
  const backupResult = await executeWithCircuitBreakerEnhanced(
    {
      provider: "airtel",
      operation: "sendPayout",
      execute: async () => {
        // ...
      },
    },
    config,
  );

  return backupResult.success
    ? { success: true, provider: "airtel", data: backupResult.data }
    : { success: false, error: backupResult.error, provider: "none" };
}
```

## Admin API Usage

### From Command Line

```bash
# Check health of all circuit breakers
curl http://localhost:3000/api/admin/circuit-breaker/health

# Check specific provider
curl "http://localhost:3000/api/admin/circuit-breaker/provider/mtn"

# Check specific operation
curl "http://localhost:3000/api/admin/circuit-breaker/status?provider=mtn&operation=sendPayout"

# Reset specific circuit
curl -X POST http://localhost:3000/api/admin/circuit-breaker/reset \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"provider": "mtn", "operation": "sendPayout"}'

# Reset all circuits for provider
curl -X POST http://localhost:3000/api/admin/circuit-breaker/reset-provider \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"provider": "mtn"}'
```

### From TypeScript

```typescript
import axios from "axios";

const adminClient = axios.create({
  baseURL: "http://localhost:3000",
  headers: {
    Authorization: `Bearer ${process.env.ADMIN_TOKEN}`,
  },
});

// Get health
const health = await adminClient.get("/api/admin/circuit-breaker/health");
console.log(health.data);

// Reset circuit
await adminClient.post("/api/admin/circuit-breaker/reset", {
  provider: "mtn",
  operation: "sendPayout",
});
```

---

**For more information, see:**

- [Circuit Breaker Guide](./CIRCUIT_BREAKER_GUIDE.md)
- [Deployment Strategy](./CIRCUIT_BREAKER_DEPLOYMENT.md)
- [Implementation Summary](./CIRCUIT_BREAKER_IMPLEMENTATION_SUMMARY.md)
