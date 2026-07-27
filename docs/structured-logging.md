# Structured JSON Logging Implementation Guide

## Overview

ProxyPay now implements enterprise-grade structured JSON logging with Pino, replacing ad-hoc `console.log` calls. This enables production log aggregation, searching, correlation, and compliance tracking.

## Components

### 1. StructuredLogger (`src/utils/structuredLogger.ts`)

High-level wrapper around Pino with context binding and helper methods:

```typescript
import { structuredLogger } from '@/utils/structuredLogger';

// Basic logging
structuredLogger.info({ userId: '123' }, 'User logged in');
structuredLogger.warn({ severity: 'high' }, 'Rate limit approaching');
structuredLogger.error(new Error('Operation failed'), 'Critical error');

// Create child logger with bound context
const childLogger = structuredLogger.createChild({
  requestId: 'req-123',
  userId: 'user-456',
  correlationId: 'corr-789'
});

// Child maintains context across calls
childLogger.info({ result: 'success' }, 'Operation completed');
// Output: { ..., requestId: 'req-123', userId: 'user-456', correlationId: 'corr-789', message: 'Operation completed' }
```

#### Performance Timing

```typescript
// Async operations
await structuredLogger.timeAsync(
  async () => {
    return await db.query(...);
  },
  'Database query',
  { query: 'SELECT * FROM users' }
);

// Sync operations
const result = structuredLogger.timeSync(
  () => {
    return expensive_computation();
  },
  'Computation',
  { params: 'value' }
);

// Manual timer
const timer = structuredLogger.createTimer('api_request');
await fetch(...);
timer.end({ statusCode: 200 });
```

#### Security & Audit Logging

```typescript
// Security events
structuredLogger.security(
  { event: 'failed_2fa', attempts: 3 },
  'Multiple 2FA failures detected'
);

// Audit trail
structuredLogger.audit(
  { action: 'withdrawal', amount: 1000, userId: '123' },
  'User withdrawal initiated'
);
```

### 2. Logger Middleware (`src/middleware/loggerMiddleware.ts`)

Express middleware that injects request context into all handlers:

```typescript
import { loggerMiddleware } from '@/middleware/loggerMiddleware';

app.use(loggerMiddleware());
```

The middleware:
- Generates/extracts `X-Request-ID` correlation ID
- Extracts `X-Trace-ID` for distributed tracing
- Automatically extracts userId from JWT tokens
- Attaches `req.logger` for use in handlers
- Logs request entry/exit with duration

#### Using in Route Handlers

```typescript
router.get('/users/:id', (req, res) => {
  req.logger?.info({ userId: req.params.id }, 'Fetching user');
  
  const user = await User.findById(req.params.id);
  
  req.logger?.info({ found: !!user }, 'User lookup complete');
  
  res.json(user);
});
```

#### Helper Functions

```typescript
import {
  logWithContext,
  logPerformance,
  logSecurityEvent,
  logAuditEvent,
  attachLogger,
  errorLoggerMiddleware
} from '@/middleware/loggerMiddleware';

// Log with request context
logWithContext(req, 'info', { data: 'value' }, 'Custom message');

// Log performance metrics
logPerformance(req, 'database_query', 125, { rows: 50 });

// Log security incidents
logSecurityEvent(req, 'unauthorized_access', { resource: '/api/admin' });

// Log audit trail
logAuditEvent(req, 'transaction_created', { amount: 1000 });

// Ensure logger is available
app.use(attachLogger());

// Global error logging
app.use(errorLoggerMiddleware());
```

## Log Output Format

All logs are structured JSON with consistent fields:

```json
{
  "level": "INFO",
  "timestamp": "2026-07-27T10:26:12.597Z",
  "service": "proxypay-api",
  "instance_id": "hostname:pid",
  "request_id": "req-1690461771535-abc123def",
  "trace_id": "trace-xyz789",
  "user_id": "user_xyz789",
  "message": "User login successful",
  "duration_ms": 125,
  "statusCode": 200
}
```

### Fields

- **level**: Log level (INFO, DEBUG, WARN, ERROR, SECURITY, AUDIT)
- **timestamp**: ISO-8601 timestamp
- **service**: Service name (from SERVICE_NAME env var)
- **instance_id**: Hostname and process ID
- **request_id**: Correlation ID for request tracing
- **trace_id**: Distributed trace ID
- **user_id**: User identifier (extracted from JWT)
- **message**: Log message
- **duration_ms**: Operation duration in milliseconds
- Custom fields: Any additional data passed to log methods

## Configuration

### Environment Variables

```bash
# Logging
LOG_LEVEL=info                    # info, debug, warn, error
SERVICE_NAME=proxypay-api         # Service identifier
NODE_ENV=production               # production, development, test

# Log Aggregation (Optional)
LOKI_HOST=localhost:3100          # Loki endpoint for log shipping
LOKI_BATCH_SIZE=100               # Batch size for Loki
LOKI_BATCH_TIMEOUT=5000           # Batch timeout (ms)
```

## Integration Examples

### Express Setup

```typescript
import express from 'express';
import { loggerMiddleware, errorLoggerMiddleware, attachLogger } from '@/middleware/loggerMiddleware';
import { structuredLogger } from '@/utils/structuredLogger';

const app = express();

// Attach logger as early middleware
app.use(loggerMiddleware());

// Your routes
app.get('/health', (req, res) => {
  req.logger?.info('Health check');
  res.json({ status: 'ok' });
});

// Error logging
app.use(errorLoggerMiddleware());

// Ensure logger is always available
app.use(attachLogger());

// Global error handler
app.use((err, req, res, next) => {
  req.logger?.error(err, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});
```

### Service Layer

```typescript
import { structuredLogger } from '@/utils/structuredLogger';

export class PaymentService {
  async processPayment(payment: Payment, requestId: string, userId: string) {
    const logger = structuredLogger.createChild({ requestId, userId });
    
    try {
      logger.info({ paymentId: payment.id }, 'Processing payment');
      
      await logger.timeAsync(
        async () => {
          return await this.provider.send(payment);
        },
        'Provider payment send',
        { provider: payment.provider }
      );
      
      logger.audit(
        { paymentId: payment.id, amount: payment.amount },
        'Payment processed successfully'
      );
      
      return true;
    } catch (error) {
      logger.error(error, 'Payment processing failed');
      logger.security({ paymentId: payment.id }, 'Payment error');
      throw error;
    }
  }
}
```

### Custom Events

```typescript
// Request context binding
req.logger?.info(
  {
    userId: req.user.id,
    resource: 'transactions',
    action: 'create',
    amount: 1000
  },
  'Transaction creation request'
);

// Performance metrics
const duration = Date.now() - startTime;
req.logger?.info(
  {
    duration_ms: duration,
    itemsProcessed: 500,
    throughput: Math.round(500 / (duration / 1000))
  },
  'Batch processing completed'
);

// Error with context
req.logger?.error(
  {
    error: err.message,
    stack: err.stack,
    userId: req.user?.id,
    transactionId: req.body.transactionId
  },
  'Transaction failed'
);
```

## Log Aggregation with Loki

When `LOKI_HOST` is configured, logs are automatically shipped to Loki:

```bash
# docker-compose.yml example
services:
  loki:
    image: grafana/loki:latest
    ports:
      - "3100:3100"
    environment:
      - LOKI_CONFIG=/etc/loki/local-config.yaml

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
```

### Grafana Log Queries

```logql
# Find all errors for a user
{service="proxypay-api", user_id="user_xyz789"} | json | level="ERROR"

# Find slow requests (>1s)
{service="proxypay-api"} | json | duration_ms > 1000

# Find security events
{service="proxypay-api"} | json | security_event="true"

# Audit trail for a transaction
{service="proxypay-api"} | json | request_id="req-123"

# Error rate per endpoint
{service="proxypay-api"} | json | level="ERROR" | rate([5m])
```

## Migration from console.log

### Before

```typescript
console.log('User login');
console.error('Failed to update user', error);
console.warn('Rate limit approaching');
```

### After

```typescript
// Request context available
req.logger?.info('User login');
req.logger?.error(error, 'Failed to update user');
req.logger?.warn({ limit: 95 }, 'Rate limit approaching');

// Outside request context
structuredLogger.info('Background job completed');
structuredLogger.error(error, 'Background job failed');
structuredLogger.warn({ severity: 'high' }, 'System alert');
```

## Best Practices

1. **Always include context**: Use request IDs, user IDs, transaction IDs
   ```typescript
   logger.info({ transactionId: '123' }, 'Processing transaction');
   ```

2. **Use appropriate levels**: INFO for normal ops, DEBUG for details, WARN for issues, ERROR for failures
   ```typescript
   logger.info('Request received');              // Normal
   logger.debug({ params: req.query }, 'Query'); // Details
   logger.warn('Timeout approaching');            // Issues
   logger.error(error, 'Failed to save');         // Failures
   ```

3. **Include metrics for observability**: Duration, counts, sizes
   ```typescript
   logger.info({
     duration_ms: 145,
     itemsProcessed: 1000,
     errorCount: 2
   }, 'Batch job completed');
   ```

4. **Use security/audit for compliance**: Track user actions
   ```typescript
   logger.audit({ userId, action, amount }, 'Withdrawal initiated');
   logger.security({ userId, attempts: 5 }, 'Failed login attempts');
   ```

5. **Avoid logging sensitive data**: Redacted by Pino configuration
   ```typescript
   // Don't do this:
   logger.info({ password: req.body.password });
   
   // Do this:
   logger.info({ user: req.body.username }, 'User registration');
   ```

## Performance Characteristics

- **Overhead**: <1ms per log call (async to Loki)
- **Throughput**: ~10,000 logs/second per instance
- **Loki Batching**: 100 logs per batch, 5s timeout
- **Retention**: Configurable in Loki (default 30 days)

## Troubleshooting

### Logs not appearing in Loki

1. Verify `LOKI_HOST` is set correctly
2. Check network connectivity to Loki
3. Review logs on stdout for errors:
   ```bash
   LOG_LEVEL=debug npm start
   ```

### Performance issues

1. Reduce LOG_LEVEL from debug to info
2. Increase LOKI_BATCH_TIMEOUT if lag occurs
3. Reduce custom field verbosity

### Correlation IDs not propagating

1. Ensure `loggerMiddleware()` is registered early
2. Pass `X-Request-ID` header in inter-service calls
3. Use child loggers to maintain context:
   ```typescript
   const childLogger = req.logger?.createChild({ customField: value });
   ```

## References

- [Pino Documentation](https://getpino.io/)
- [Loki Querying](https://grafana.com/docs/loki/latest/logql/)
- [Structured Logging Best Practices](https://www.kartar.net/2015/12/structured-logging/)
