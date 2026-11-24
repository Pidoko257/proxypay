# Provider API Versioning and Gradual Migration Guide

This document describes the comprehensive provider API versioning system that enables safe, gradual migration from legacy API versions to newer versions.

## Overview

The versioning system addresses the key challenge of switching provider API versions in production:

- **Risk**: Switching all traffic at once can cause widespread outages
- **Solution**: Gradual migration with multiple routing strategies, compatibility layers, and automatic rollback

### Key Features

- **Multiple Routing Strategies**: FIXED, CANARY, CONDITIONAL, FAILOVER, SHADOW
- **Compatibility Layer**: Automatic request/response transformation between versions
- **Fallback Support**: Automatic fallback to secondary version on failure
- **Session Affinity**: Ensure consistent user experience during migration
- **Progress Tracking**: Monitor migration metrics and error rates
- **Automatic Rollback**: Automatic rollback when error threshold exceeded

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Transaction Request                        │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │  Version Router │
                    └────────┬────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
    ┌────────┐          ┌────────┐          ┌────────┐
    │ V1 API │          │ V2 API │          │ V3 API │
    └────────┘          └────────┘          └────────┘
         │                   │                   │
         └───────────────────┼───────────────────┘
                             │
                    ┌────────▼────────┐
                    │ Compatibility   │
                    │ Adapter         │
                    └────────┬────────┘
                             │
                             ▼
                     ┌──────────────────┐
                     │ Provider Service │
                     └──────────────────┘
```

## Core Components

### 1. Version Routing Strategies

#### FIXED
Uses a single version consistently. Simplest but no gradual migration.

```typescript
config = {
  strategy: VersionRoutingStrategy.FIXED,
  primaryVersion: ProviderApiVersion.V2,
};
```

**Use case**: Simple upgrades where V2 is fully validated

#### CANARY
Routes a percentage of traffic to the new version, gradually increasing the percentage.

```typescript
config = {
  strategy: VersionRoutingStrategy.CANARY,
  primaryVersion: ProviderApiVersion.V1,
  secondaryVersion: ProviderApiVersion.V2,
  canaryConfig: {
    trafficPercentage: 5, // Start with 5%
    maxErrorRate: 0.05,   // Rollback if error rate > 5%
    sessionAffinity: true // Same user always gets same version
  }
};
```

**Use case**: Production migrations - start at 5%, increase gradually

#### CONDITIONAL
Routes traffic based on transaction properties (amount, user, etc.)

```typescript
config = {
  strategy: VersionRoutingStrategy.CONDITIONAL,
  primaryVersion: ProviderApiVersion.V1,
  secondaryVersion: ProviderApiVersion.V2,
  conditionalRules: [
    {
      condition: ctx => ctx.amount > 10000,
      version: ProviderApiVersion.V2,
      priority: 100
    },
    {
      condition: ctx => ctx.amount <= 10000,
      version: ProviderApiVersion.V1,
      priority: 50
    }
  ]
};
```

**Use case**: Test V2 on specific transaction types first

#### FAILOVER
Uses primary version, automatically falls back to secondary on failure

```typescript
config = {
  strategy: VersionRoutingStrategy.FAILOVER,
  primaryVersion: ProviderApiVersion.V2,
  secondaryVersion: ProviderApiVersion.V1,
};
```

**Use case**: Ensure reliability during API maintenance windows

#### SHADOW
Sends real traffic to primary, replicates to secondary for comparison

```typescript
config = {
  strategy: VersionRoutingStrategy.SHADOW,
  primaryVersion: ProviderApiVersion.V1,
  secondaryVersion: ProviderApiVersion.V2,
};
```

**Use case**: Validation before actual migration - no production impact

## Configuration

### Environment Variables

Configure versioning via environment variables:

```bash
# Global
PROVIDER_VERSIONING_ENABLED=true
PROVIDER_VERSIONING_METRICS_ENABLED=true
PROVIDER_VERSIONING_LOGGING_ENABLED=false
PROVIDER_DEFAULT_ROUTING_STRATEGY=canary

# MTN Versioning
MTN_ENABLED_VERSIONS=v1,v2
MTN_DEFAULT_VERSION=v1
MTN_ROUTING_STRATEGY=canary
MTN_PRIMARY_VERSION=v1
MTN_SECONDARY_VERSION=v2
MTN_V1_BASE_URL=https://api.mtn.com/v1
MTN_V2_BASE_URL=https://api.mtn.com/v2
MTN_CANARY_TRAFFIC_PERCENTAGE=10
MTN_CANARY_MAX_ERROR_RATE=0.05

# Airtel Versioning
AIRTEL_ENABLED_VERSIONS=v1,v2
AIRTEL_DEFAULT_VERSION=v1
AIRTEL_ROUTING_STRATEGY=canary
# ... similar to MTN

# Orange Versioning
ORANGE_ENABLED_VERSIONS=v1,v2
ORANGE_DEFAULT_VERSION=v1
ORANGE_ROUTING_STRATEGY=canary
# ... similar to MTN
```

## Usage

### 1. Initialize Versioning System

```typescript
import {
  CompatibilityAdapter,
  VersionAdapterFactory,
  VersionedProviderLoader,
  registerAllCompatibilityBridges
} from './versioning';

// Create adapter and factory
const adapter = new CompatibilityAdapter();
const factory = new VersionAdapterFactory(adapter);
const loader = new VersionedProviderLoader(adapter, factory);

// Register provider-specific mappings
registerAllCompatibilityBridges(adapter);

// Register provider versions
loader.registerProviderVersion('mtn', ProviderApiVersion.V1, mtnV1Instance);
loader.registerProviderVersion('mtn', ProviderApiVersion.V2, mtnV2Instance);

// Register routing configuration
loader.registerRoutingConfig('mtn', {
  provider: 'mtn',
  strategy: VersionRoutingStrategy.CANARY,
  primaryVersion: ProviderApiVersion.V1,
  secondaryVersion: ProviderApiVersion.V2,
  canaryConfig: { trafficPercentage: 10 }
});
```

### 2. Execute Transactions with Automatic Routing

```typescript
const context: TransactionContext = {
  provider: 'mtn',
  phoneNumber: '237123456789',
  amount: 5000,
  userId: 'user123',
  sessionId: 'session123'
};

const result = await loader.executeWithFallback(
  'mtn',
  context,
  async (instance, version) => {
    return instance.sendPayout(context.phoneNumber, context.amount);
  }
);

console.log(`Transaction successful: ${result.success}`);
console.log(`API version used: ${result.apiVersion}`);
console.log(`Fallback used: ${result.fallbackUsed}`);
console.log(`Execution time: ${result.executionTimeMs}ms`);
```

### 3. Use Pre-built Migration Plans

```typescript
import { MigrationStrategies } from './versioning/migration-strategy';

// Choose a migration plan
const conservativePlan = MigrationStrategies.conservativeRollout(
  'mtn',
  ProviderApiVersion.V2
);

// Use the plan phases
for (const phase of conservativePlan.phases) {
  console.log(`Phase: ${phase.phase}`);
  console.log(`Strategy: ${phase.strategy}`);
  console.log(`Canary traffic: ${phase.canaryTraffic}%`);
  
  // Apply this phase's configuration
  applyPhaseConfig(phase);
  
  // Wait for phase duration or monitoring
  await monitorPhase(conservativePlan.rollbackThreshold);
}
```

### 4. Monitor Migration Progress

```typescript
import { MigrationProgressTracker } from './versioning/migration-strategy';

const tracker = new MigrationProgressTracker(
  'mtn',
  ProviderApiVersion.V1,
  ProviderApiVersion.V2
);

// Start automatic metrics collection
tracker.startMetricsCollection(60000); // Log every 60 seconds

// Record transactions
tracker.recordTransaction(success, latencyMs, userId);

// Check status
const status = tracker.getStatus();
console.log(`Success rate: ${(status.metrics.errorRate * 100).toFixed(2)}%`);
console.log(`Avg latency: ${status.metrics.avgLatencyMs.toFixed(0)}ms`);

// Check if rollback needed
if (tracker.shouldRollback(0.05)) {
  tracker.recordRollback();
  // Perform rollback logic
}

// Get estimated completion time
const timeRemaining = tracker.getEstimatedTimeToCompletion();
console.log(`Estimated completion in ${timeRemaining / 1000 / 60} minutes`);
```

## Migration Playbook

### Scenario 1: Canary Migration (Recommended)

1. **Phase 1: Planning** (1-2 days)
   - Validate V2 API compatibility
   - Run integration tests
   - Prepare rollback procedures

2. **Phase 2: Internal Testing** (3-5 days)
   - Route internal transactions to V2
   - Monitor all metrics
   - Verify error handling

3. **Phase 3: Early Adopters** (2-3 days)
   - Route 100% of early adopter traffic to V2
   - Gather user feedback
   - Validate real-world usage

4. **Phase 4: Canary Rollout** (3-7 days)
   - Start with 5% of production traffic
   - Monitor error rate and latency
   - Increase by 5% daily if metrics healthy

5. **Phase 5: Gradual Expansion** (7-14 days)
   - Increase to 50% traffic
   - Continue monitoring
   - Expand to 100%

6. **Phase 6: Complete** (1 day)
   - Switch all traffic to V2
   - Decommission V1 if no longer needed

### Scenario 2: Shadow Mode Validation

Use when you want to validate V2 without production impact:

1. **Week 1: Shadow Traffic**
   - Send 100% of requests to V2 in background
   - Compare responses with V1
   - Build confidence in V2

2. **Week 2: Canary Switchover**
   - Switch to canary strategy with 5% V2 traffic
   - Continue canary rollout as above

### Scenario 3: Geographic Rollout

For providers with strong regional differences:

1. **Phase 1: Single Region Test**
   - Route all traffic from region A to V2
   - Monitor for 1-2 weeks

2. **Phase 2: Multi-Region Canary**
   - Enable canary across other regions
   - Start at 5% traffic

3. **Phase 3: Global Rollout**
   - Expand canary to 100%
   - Complete migration

## Compatibility Mapping

The system includes provider-specific request/response mappings:

### MTN V1 → V2 Mapping

**Request:**
```typescript
// V1
{ phone_number: "237...", amount: "1000", external_id: "ext123" }

// V2
{ phoneNumber: "237...", amount: 1000, externalId: "ext123" }
```

**Response:**
```typescript
// V1
{ transaction_id: "txn123", status: "success" }

// V2
{ transactionId: "txn123", status: "success" }
```

### Airtel V1 → V2 Mapping

**Request:**
```typescript
// V1
{ msisdn: "254...", amount: "2000", reference: "ref123" }

// V2
{ customer: { msisdn: "254..." }, transaction: { amount: 2000, id: "ref123" } }
```

### Orange V1 → V2 Mapping

**Request:**
```typescript
// V1
{ number: "221...", amount: "3000", txnid: "txn123" }

// V2
{ party_id: "221...", amount: 3000, request_id: "txn123" }
```

## Monitoring and Alerts

Key metrics to monitor during migration:

1. **Error Rate**: Should stay below threshold (default 5%)
2. **Latency**: V2 should be similar or faster
3. **Success Rate**: Should remain >95%
4. **Traffic Distribution**: Verify canary percentages are correct
5. **User Impact**: Track failed transactions by user

```typescript
// Access metrics
const router = loader.getRouter('mtn');
const metrics = router.getPerformanceMetrics();

metrics.forEach((perf, version) => {
  console.log(`Version ${version}:`);
  console.log(`  Calls: ${perf.calls}`);
  console.log(`  Success rate: ${(perf.successes / perf.calls * 100).toFixed(2)}%`);
  console.log(`  Avg latency: ${(perf.totalDurationMs / perf.calls).toFixed(0)}ms`);
});
```

## Rollback Procedure

Automatic rollback occurs if:
- Error rate exceeds configured threshold
- Manual rollback is triggered
- Canary health check fails

```typescript
// Manual rollback
const router = loader.getRouter('mtn');
router.rollbackCanary();

// Or update to previous phase
loader.registerRoutingConfig('mtn', {
  strategy: VersionRoutingStrategy.FIXED,
  primaryVersion: ProviderApiVersion.V1,
  // ...
});

// Re-execute pending transactions if needed
await retryFailedTransactions(startTime);
```

## Troubleshooting

### High Error Rate During Canary

1. Check compatibility mapping for data format issues
2. Verify V2 API is responding correctly
3. Review provider-specific API documentation
4. Reduce canary percentage and try again

### Latency Degradation

1. Compare V1 vs V2 timeout settings
2. Check V2 API performance
3. Verify network connectivity
4. Review database query performance (if applicable)

### Session Affinity Not Working

1. Verify `sessionAffinity: true` in canary config
2. Check session ID is being passed in context
3. Review Redis/cache for session consistency
4. Ensure distributed tracing shows same version

### Fallback Triggered Too Often

1. Increase error rate threshold if expected
2. Check V2 API compatibility
3. Verify network connectivity
4. Review provider-specific error handling

## Best Practices

1. **Always start with shadow mode** to validate before production
2. **Use session affinity** to prevent mid-transaction switches
3. **Start canary at 1-5%** even if you're confident
4. **Monitor continuously** during all migration phases
5. **Have rollback ready** - test it before production
6. **Communicate changes** to stakeholders with timelines
7. **Document provider-specific quirks** for your team
8. **Test both directions** - V1→V2 and V2→V1 fallback

## Testing

```bash
# Run versioning tests
npm test -- versioning.test.ts

# Run with coverage
npm test -- versioning.test.ts --coverage

# Test specific routing strategy
npm test -- versioning.test.ts -t "CANARY"

# Integration test
npm test -- versioning.test.ts -t "Integration"
```

## FAQ

**Q: Can I use different versions for different providers?**
A: Yes, each provider has independent routing configuration.

**Q: What happens if V2 API is down?**
A: If FAILOVER is enabled, requests automatically fall back to V1.

**Q: Can I run A/B tests with versions?**
A: Yes, use CONDITIONAL routing to split by user segment.

**Q: What's the minimum canary traffic to trust?**
A: Typically 10-20% of traffic reveals most issues, but depends on error rates.

**Q: Can I rollback to V1 after full migration?**
A: Yes, but may require data migration. Plan accordingly.

## Support

For issues or questions:
1. Check [versioning tests](./versioning/__tests__/versioning.test.ts) for examples
2. Review provider-specific bridges in [bridges.ts](./versioning/bridges.ts)
3. Check configuration examples in [config.ts](./versioning/config.ts)
4. See migration strategy examples in [migration-strategy.ts](./versioning/migration-strategy.ts)
