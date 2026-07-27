# NoSQL Event Log Storage Guide

## Overview

ProxyPay now supports scalable event logging to NoSQL databases (Azure Cosmos DB or AWS DynamoDB) with high-volume write optimization, flexible queries, and automatic data expiration.

## Table of Contents

1. [Architecture](#architecture)
2. [Setup](#setup)
3. [Configuration](#configuration)
4. [Usage](#usage)
5. [Query Examples](#query-examples)
6. [Best Practices](#best-practices)
7. [Troubleshooting](#troubleshooting)

## Architecture

### High-Level Design

```
Application
    ↓
EventLogService (Abstraction)
    ├─→ Cosmos DB Provider
    ├─→ DynamoDB Provider
    └─→ Batch Writer (5s or 100 events)
         ↓
    NoSQL Database
         ├─→ Automatic TTL (30 days)
         ├─→ Partitioned by date
         └─→ Indexed for queries
```

### Event Structure

```typescript
{
  // Keys
  partitionKey: "2024-07-27",           // Date-based for time-series
  sortKey: "1721991000#uuid-123",       // Timestamp#ID for ordering

  // Identification
  id: "event-uuid",
  timestamp: 1721991000,                // Unix milliseconds
  timestampISO: "2024-07-27T12:30:00Z",

  // Classification
  category: "transaction|payment|auth|...",
  severity: "debug|info|warning|error|critical",
  type: "transaction.initiated",
  source: "service-name",

  // Details
  title: "Human-readable title",
  description: "Detailed description",
  metadata: { /* custom fields */ },

  // Correlation
  correlationId: "trace-id",            // Distributed tracing
  transactionId: "txn-123",
  userId: "user-456",
  providerId: "mtn",                    // Mobile money provider

  // Status
  status: "pending|completed|failed",
  errorCode: "ERR_TIMEOUT",
  errorMessage: "Provider timed out",

  // Performance
  durationMs: 1250,
  retryCount: 2,

  // Tags for filtering
  tags: ["payment", "mtn", "completed"],

  // Automatic expiration
  ttl: 2592000,                         // 30 days in seconds
  version: 1,
  createdAt: 1721991000
}
```

## Setup

### 1. Azure Cosmos DB Setup

```bash
# Create Cosmos DB account
az cosmosdb create \
  --name proxypay-events \
  --resource-group my-rg \
  --kind GlobalDocumentDB \
  --locations regionName=eastus failoverPriority=0

# Get connection string
az cosmosdb keys list \
  --name proxypay-events \
  --resource-group my-rg \
  --type connection-strings
```

### 2. AWS DynamoDB Setup

```bash
# Create DynamoDB table (using CLI)
aws dynamodb create-table \
  --table-name event-log \
  --attribute-definitions \
    AttributeName=partitionKey,AttributeType=S \
    AttributeName=sortKey,AttributeType=S \
  --key-schema \
    AttributeName=partitionKey,KeyType=HASH \
    AttributeName=sortKey,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1 \
  --time-to-live-specification \
    Enabled=true,AttributeName=ttl

# Create Global Secondary Indexes
aws dynamodb update-table \
  --table-name event-log \
  --attribute-definitions \
    AttributeName=userId,AttributeType=S \
    AttributeName=transactionId,AttributeType=S \
    AttributeName=timestamp,AttributeType=N \
  --global-secondary-index-updates \
    '[{"Create":{"IndexName":"userIdIndex",...}}]'
```

## Configuration

### Environment Variables

```bash
# Select provider
EVENT_LOG_PROVIDER=dynamodb              # or "cosmos"

# Batching
EVENT_LOG_BATCH_SIZE=100                 # Events per batch
EVENT_LOG_BATCH_INTERVAL_MS=5000         # Flush interval
EVENT_LOG_ENABLE_BATCHING=true           # Batch writes

# DynamoDB
DYNAMODB_REGION=us-east-1
DYNAMODB_TABLE_NAME=event-log
DYNAMODB_BILLING_MODE=PAY_PER_REQUEST   # or PROVISIONED
DYNAMODB_READ_CAPACITY=100               # If PROVISIONED
DYNAMODB_WRITE_CAPACITY=100              # If PROVISIONED

# Cosmos DB
COSMOS_ENDPOINT=https://account.documents.azure.com:443/
COSMOS_KEY=your-primary-key
COSMOS_DATABASE_ID=events
COSMOS_CONTAINER_ID=logs
COSMOS_PARTITION_KEY=/partitionKey
COSMOS_THROUGHPUT=400                    # RU/s
```

### Programmatic Configuration

```typescript
import { EventLogService } from "src/services/eventLog/eventLogService";
import { EventLogConfig } from "src/services/eventLog/types";

// DynamoDB Configuration
const dynamoConfig: EventLogConfig = {
  provider: "dynamodb",
  batchSize: 100,
  batchIntervalMs: 5000,
  enableBatching: true,
  enableMetrics: true,
  dynamodb: {
    region: "us-east-1",
    tableName: "event-log",
    billingMode: "PAY_PER_REQUEST",
    endpoint: "http://localhost:8000", // For local testing
  },
};

// Cosmos DB Configuration
const cosmosConfig: EventLogConfig = {
  provider: "cosmos",
  batchSize: 100,
  batchIntervalMs: 5000,
  enableBatching: true,
  cosmosDb: {
    endpoint: process.env.COSMOS_ENDPOINT || "",
    key: process.env.COSMOS_KEY || "",
    databaseId: "events",
    containerId: "logs",
    partitionKey: "/partitionKey",
    throughput: 400,
  },
};

// Initialize service
const eventLogService = new EventLogService(dynamoConfig);
await eventLogService.initialize();
```

## Usage

### Basic Event Logging

```typescript
import { EventLogService } from "src/services/eventLog/eventLogService";
import { EventCategory, EventSeverity } from "src/services/eventLog/types";

const eventLog = await getEventLogService(config);

// Simple event
await eventLog.log({
  category: EventCategory.SYSTEM,
  type: "app.startup",
  title: "Application Started",
  description: "ProxyPay service started successfully",
  severity: EventSeverity.INFO,
  metadata: {
    version: "1.0.0",
    environment: "production",
  },
});
```

### Transaction Logging

```typescript
// Log transaction initiated
await eventLog.logTransaction("txn-123", "initiated", {
  amount: "1000",
  currency: "XAF",
  provider: "mtn",
  userId: "user-456",
});

// Log transaction completed
await eventLog.logTransaction("txn-123", "completed", {
  amount: "1000",
  provider: "mtn",
  duration: 2500,
  fee: "10",
});

// Log transaction failed
await eventLog.logTransaction("txn-123", "failed", {
  error: "PROVIDER_TIMEOUT",
  provider: "mtn",
  retries: 2,
});
```

### Payment Logging

```typescript
await eventLog.logPayment(
  "mtn",                          // Provider
  "initiated",                    // Type
  "1000",                         // Amount
  "237671234567",                 // Phone number
  {
    fee: "10",
    channel: "api",
    userId: "user-456",
  }
);
```

### Authentication Logging

```typescript
// Successful login
await eventLog.logAuth("user-456", "login", true, {
  method: "password",
  ipAddress: "192.168.1.1",
});

// Failed login
await eventLog.logAuth("user-456", "login", false, {
  reason: "invalid_credentials",
  ipAddress: "192.168.1.1",
  attempts: 3,
});
```

### Security Event Logging

```typescript
await eventLog.logSecurity(
  "suspicious_activity",
  EventSeverity.WARNING,
  {
    userId: "user-456",
    activity: "rapid_transactions",
    count: 10,
    timeframe: "1h",
    action: "flagged_for_review",
  }
);
```

### Compliance Event Logging

```typescript
await eventLog.logCompliance("kyc_verification", "user-456", {
  level: "full",
  status: "verified",
  provider: "entrust",
  documents: ["id_card", "address_proof"],
});
```

### Batch Logging

```typescript
// High-volume batch logging
const events = [
  {
    type: "payment.initiated",
    title: "Payment 1",
    metadata: { provider: "mtn" },
  },
  {
    type: "payment.completed",
    title: "Payment 2",
    metadata: { provider: "airtel" },
  },
];

await eventLog.logBatch(events);
```

## Query Examples

### Query by Correlation ID (Trace)

```typescript
// Get all events for a distributed trace
const events = await eventLog.queryByCorrelationId("trace-id-xyz");

events.forEach((event) => {
  console.log(`${event.source}: ${event.type} (${event.durationMs}ms)`);
});

// Output:
// auth-service: auth.login.success (125ms)
// user-service: user.loaded (85ms)
// payment-service: payment.initiated (2500ms)
```

### Query by Transaction ID

```typescript
const events = await eventLog.queryByTransactionId("txn-123");

// Get timeline of transaction
const timeline = events
  .sort((a, b) => a.timestamp - b.timestamp)
  .map((e) => ({
    time: new Date(e.timestamp).toISOString(),
    event: e.type,
    status: e.status,
    duration: e.durationMs,
  }));
```

### Query by User ID

```typescript
const userEvents = await eventLog.queryByUserId("user-456");

// Find user's activity
const activities = userEvents.reduce(
  (acc, event) => {
    acc[event.type] = (acc[event.type] || 0) + 1;
    return acc;
  },
  {} as Record<string, number>
);

console.log("User activities:", activities);
```

### Advanced Filtering

```typescript
const response = await eventLog.query({
  category: ["payment", "transaction"],
  severity: ["error", "critical"],
  startDate: "2024-07-20",
  endDate: "2024-07-27",
  providerId: "mtn",
  limit: 100,
  sortBy: "timestamp",
  sortOrder: "desc",
});

console.log(`Found ${response.count} events, has more: ${response.hasMore}`);
```

### Statistics & Analytics

```typescript
const stats = await eventLog.getStats(
  "2024-07-01",
  "2024-07-31"
);

console.log("Monthly statistics:");
console.log(`- Transactions: ${stats.categoryCounts.transaction}`);
console.log(`- Errors: ${stats.severityCounts.error}`);
console.log(`- Avg response: ${stats.averageResponseTime}ms`);
console.log(`- P95 response: ${stats.p95ResponseTime}ms`);
console.log(`- Top errors:`, stats.errorCounts);
```

## Best Practices

### 1. Event Naming

Use hierarchical naming for types:
```typescript
// Good
"transaction.deposit.initiated"
"payment.mtn.completed"
"auth.totp.verified"

// Avoid
"event1"
"action"
"something_happened"
```

### 2. Metadata

Keep metadata structured and useful:
```typescript
// Good
{
  type: "payment.completed",
  metadata: {
    provider: "mtn",
    amount: "1000",
    currency: "XAF",
    fee: "10",
    duration: 2500,
  }
}

// Avoid
{
  type: "payment",
  metadata: {
    info: "payment to mtn for 1000 XAF with 10 fee",
  }
}
```

### 3. Privacy

Never log sensitive data:
```typescript
// Good - masked
{
  metadata: {
    phoneNumber: "*****4567",
    email: "u***@example.com",
  }
}

// Avoid - exposed PII
{
  metadata: {
    phoneNumber: "237671234567",
    email: "user@example.com",
    idNumber: "12345678",
  }
}
```

### 4. Performance

Use batching for high volume:
```typescript
// Good - batched
const events = [];
for (const transaction of transactions) {
  events.push(/* event */);
}
await eventLog.logBatch(events);

// Avoid - individual writes
for (const transaction of transactions) {
  await eventLog.log(/* event */);
}
```

### 5. Correlation

Always include correlation IDs for tracing:
```typescript
await eventLog.log({
  correlationId: req.headers["x-correlation-id"],
  transactionId: txn.id,
  userId: req.user.id,
  // ... rest
});
```

## Monitoring

### Health Checks

```typescript
const isHealthy = await eventLog.healthCheck();
if (!isHealthy) {
  // Alert or failover
}
```

### Metrics

```typescript
const metrics = eventLog.getMetrics();
console.log({
  eventsWritten: metrics.eventsWritten,
  eventsQueried: metrics.eventsQueried,
  avgWriteLatency: metrics.averageWriteLatencyMs,
  avgQueryLatency: metrics.averageQueryLatencyMs,
  failedWrites: metrics.failedWrites,
  failedQueries: metrics.failedQueries,
});
```

### Storage Management

```typescript
// Check storage usage
const stats = await eventLog.getStorageStats();
console.log(`Documents: ${stats.documentCount}, Size: ${stats.storageUsedMB}MB`);

// Clean up old events (older than 90 days)
const deleted = await eventLog.deleteOldEvents(
  new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
);
console.log(`Deleted ${deleted} old events`);
```

## Pricing Comparison

### Cosmos DB (on-demand)

- **Write**: $1.25 per million operations
- **Read**: $0.25 per million operations
- **Storage**: $0.25 per GB/month

For 1M events/day (30M/month):
- Writes: 1M × $1.25 = $1.25
- Storage: ~30GB × $0.25 = $7.50
- **Total: ~$38.75/month**

### DynamoDB (on-demand)

- **Write**: $1.25 per million operations
- **Read**: $0.25 per million operations
- **Storage**: $0.25 per GB/month

For 1M events/day (30M/month):
- Writes: 1M × $1.25 = $1.25
- Storage: ~30GB × $0.25 = $7.50
- **Total: ~$38.75/month**

### DynamoDB (provisioned)

- **Throughput**: $0.47/hour (100 WCU, 100 RCU)
- **Storage**: $0.25 per GB/month

For 1M events/day:
- Throughput: 24 × $0.47 = $11.28/day = $338.40/month
- Storage: ~30GB × $0.25 = $7.50
- **Total: ~$345.90/month**

**Recommendation**: Use **on-demand billing** for variable workloads, **provisioned** for predictable traffic.

## Troubleshooting

### High Write Latency

**Symptoms**: Slow event logging, batches backing up

**Solutions**:
1. Increase batch size: `EVENT_LOG_BATCH_SIZE=200`
2. Adjust batch interval: `EVENT_LOG_BATCH_INTERVAL_MS=10000`
3. For Cosmos DB: increase RU/s
4. For DynamoDB: increase provisioned throughput

### Connection Timeout

**Symptoms**: "Connection refused" errors

**Solutions**:
1. Verify endpoint URL
2. Check credentials/keys
3. Verify network/firewall rules
4. For local testing: ensure DynamoDB Local is running

### TTL Not Working

**Symptoms**: Old events not being deleted

**Solutions**:
1. Verify TTL is enabled in table
2. Check TTL attribute name matches ("ttl")
3. Ensure TTL value is in seconds (not milliseconds)

### Query Performance

**Symptoms**: Slow queries

**Solutions**:
1. Use Global Secondary Indexes
2. Filter by partition key when possible
3. Use limit/pagination
4. Consider batch query from application layer

---

**Related Documentation**:
- [Circuit Breaker Guide](./CIRCUIT_BREAKER_GUIDE.md)
- [Monitoring & Observability](./MONITORING.md)
- [API Reference](./API.md)
