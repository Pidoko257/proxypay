# IP Whitelist & Rate Limit Bypass Guide

## Overview

ProxyPay's IP whitelist system allows trusted partners to bypass rate limiting while maintaining security through tier-based access control, geolocation validation, and comprehensive logging.

## Quick Start

### 1. Configure Whitelist

```bash
export IP_WHITELIST_ENABLED=true
export IP_WHITELIST_STORAGE=memory  # or 'database'
export IP_WHITELIST_CACHE_TTL=300   # 5 minutes
export IP_WHITELIST_LOG_ACCESS=true
```

### 2. Add Trusted Partner

```bash
curl -X POST http://localhost:3000/api/admin/whitelist/ips \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "ipAddress": "203.0.113.42",
    "partnerId": "partner-123",
    "partnerName": "Acme Corp",
    "tier": "standard",
    "contactEmail": "api@acme.com",
    "bypassRateLimit": true
  }'
```

### 3. Make API Calls

Partner makes requests from whitelisted IP:
- Rate limiting automatically bypassed
- Custom limits apply if configured
- Access logged for audit trail

## Partner Tiers

### BASIC
- Bypass rate limiting for basic endpoints
- Custom limits: 100 req/min, 10K req/day
- Limited to specific endpoints (optional)

### STANDARD
- Full rate limit bypass
- Custom limits: 1K req/min, 100K req/day
- All endpoints available

### PREMIUM
- Unlimited requests
- Priority processing
- Dedicated support
- All endpoints available

### ENTERPRISE
- Unlimited requests
- Priority processing
- Dedicated support
- Custom integration support
- All endpoints available

## API Reference

### List Whitelisted IPs

```bash
GET /api/admin/whitelist/ips?status=active&tier=standard&limit=50
```

Query params:
- `status`: active|inactive|blocked|suspended
- `tier`: basic|standard|premium|enterprise
- `partnerId`: Filter by partner
- `search`: Search by IP, name, or email
- `limit`: Default 100
- `offset`: Default 0

### Add IP to Whitelist

```bash
POST /api/admin/whitelist/ips
```

Body:
```json
{
  "ipAddress": "203.0.113.42",
  "ipType": "single",
  "partnerId": "partner-123",
  "partnerName": "Acme Corp",
  "tier": "standard",
  "contactEmail": "api@acme.com",
  "bypassRateLimit": true,
  "customLimits": {
    "requestsPerSecond": 10,
    "requestsPerMinute": 100,
    "requestsPerHour": 10000,
    "maxConcurrentRequests": 50
  },
  "expectedCountries": ["US", "CA"],
  "allowedEndpoints": ["/api/transactions", "/api/users"],
  "allowedMethods": ["GET", "POST"],
  "maxRequestsPerDay": 100000,
  "tags": ["payment-processor"],
  "reason": "Payment processor integration"
}
```

### Get IP Details

```bash
GET /api/admin/whitelist/ips/203.0.113.42
```

Response:
```json
{
  "id": "uuid",
  "ipAddress": "203.0.113.42",
  "partnerId": "partner-123",
  "partnerName": "Acme Corp",
  "tier": "standard",
  "bypassRateLimit": true,
  "status": "active",
  "createdAt": 1721991000,
  "updatedAt": 1721991000
}
```

### Update IP

```bash
PATCH /api/admin/whitelist/ips/203.0.113.42
```

```json
{
  "tier": "premium",
  "customLimits": { "requestsPerSecond": 50 },
  "notes": "Upgraded to premium"
}
```

### Block/Unblock IP

```bash
POST /api/admin/whitelist/ips/203.0.113.42/block
POST /api/admin/whitelist/ips/203.0.113.42/unblock
```

### Delete IP

```bash
DELETE /api/admin/whitelist/ips/203.0.113.42
```

### Get Statistics

```bash
GET /api/admin/whitelist/stats
```

Response:
```json
{
  "totalWhitelisted": 50,
  "activeCount": 48,
  "inactiveCount": 1,
  "blockedCount": 1,
  "byTier": {
    "basic": 10,
    "standard": 25,
    "premium": 10,
    "enterprise": 5
  },
  "totalPartners": 20
}
```

### Access Logs

```bash
GET /api/admin/whitelist/access-logs/203.0.113.42?limit=100
```

Response:
```json
{
  "logs": [
    {
      "id": "uuid",
      "ipAddress": "203.0.113.42",
      "timestamp": 1721991000,
      "endpoint": "/api/transactions",
      "method": "POST",
      "statusCode": 200,
      "responseTimeMs": 125,
      "bypassRateLimit": true
    }
  ]
}
```

### Get Partner IPs

```bash
GET /api/admin/whitelist/partner/partner-123
```

## CIDR Support

Add CIDR blocks for multiple IPs:

```bash
curl -X POST http://localhost:3000/api/admin/whitelist/ips \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "ipAddress": "203.0.113.0/24",
    "ipType": "cidr",
    "partnerId": "partner-123",
    "tier": "standard",
    "contactEmail": "api@acme.com"
  }'
```

Supports:
- Single IP: `203.0.113.42`
- CIDR: `203.0.113.0/24`
- Range: `203.0.113.1-203.0.113.254`

## Configuration Options

```typescript
interface WhitelistConfig {
  // Enable/disable
  enableWhitelist: boolean;

  // Storage
  storageProvider: "memory" | "database" | "redis";
  syncInterval?: number; // ms

  // Caching
  enableCache: boolean;
  cacheTTL?: number; // seconds

  // Logging
  enableLogging: boolean;
  logBypassedRequests: boolean;

  // Validation
  validateGeolocation: boolean;
  allowGeolocationMismatch: boolean;

  // Security
  blockUnwhitelisted?: boolean;
  requireApiKey?: boolean;
}
```

## Usage Examples

### Setup in Express App

```typescript
import { getWhitelistManager } from "src/services/ipWhitelist/whitelistManager";
import { createRateLimitBypassMiddleware } from "src/middleware/rateLimitBypass";
import ipWhitelistRoutes from "src/routes/admin/ipWhitelistRoutes";

// Initialize
const whitelistManager = await getWhitelistManager({
  enableWhitelist: true,
  storageProvider: "memory",
  enableCache: true,
  cacheTTL: 300,
});

// Add middleware
app.use(createRateLimitBypassMiddleware());

// Add routes
app.use("/api/admin", ipWhitelistRoutes);
```

### Check if Request Should Bypass Rate Limit

```typescript
import { shouldBypassRateLimit } from "src/middleware/rateLimitBypass";

app.use((req, res, next) => {
  if (shouldBypassRateLimit(req)) {
    // Skip rate limiting
    console.log("Rate limit bypassed for whitelisted IP");
  }
  next();
});
```

### Get Custom Limits

```typescript
import { getCustomLimits } from "src/middleware/rateLimitBypass";

const limits = getCustomLimits(req);
if (limits) {
  // Apply custom limits instead of default
  console.log("Custom limits:", limits);
}
```

## Security Best Practices

### 1. Use CIDR Blocks

Instead of individual IPs, use CIDR blocks:
```
✅ Good:  203.0.113.0/24  (256 IPs)
❌ Avoid: 203.0.113.42    (Single IP, less flexible)
```

### 2. Set Endpoint Restrictions

Limit to specific endpoints:
```json
{
  "allowedEndpoints": [
    "/api/transactions/deposit",
    "/api/transactions/withdraw"
  ]
}
```

### 3. Set Method Restrictions

Only allow GET for read operations:
```json
{
  "allowedMethods": ["GET", "POST"]
}
```

### 4. Monitor Access

Check access logs regularly:
```bash
GET /api/admin/whitelist/access-logs/203.0.113.42
```

### 5. Implement Daily Quotas

Set maximum requests per day:
```json
{
  "maxRequestsPerDay": 1000000
}
```

### 6. Geographic Validation

Validate origin countries:
```json
{
  "expectedCountries": ["US", "CA", "MX"]
}
```

## Troubleshooting

### Rate Limiting Not Bypassed

1. Verify IP is active:
   ```bash
   GET /api/admin/whitelist/ips/203.0.113.42
   # Check: status === "active"
   ```

2. Check if bypassed:
   ```bash
   GET /api/admin/whitelist/ips
   # Find IP, check: bypassRateLimit === true
   ```

3. Verify middleware added:
   ```typescript
   app.use(createRateLimitBypassMiddleware());
   ```

### IP Not Found

1. Add to whitelist:
   ```bash
   POST /api/admin/whitelist/ips { ipAddress: "..." }
   ```

2. Verify CIDR format if using blocks:
   ```bash
   # Valid: 203.0.113.0/24
   # Invalid: 203.0.113.0/24/8
   ```

### Performance Issues

1. Enable caching:
   ```typescript
   enableCache: true,
   cacheTTL: 300
   ```

2. Use database storage for large lists:
   ```
   IP_WHITELIST_STORAGE=database
   ```

## Monitoring

### Key Metrics to Track

1. **Bypass Rate**: Percentage of requests bypassing rate limit
2. **Access Patterns**: Top endpoints accessed by whitelisted IPs
3. **Custom Limit Hits**: How often custom limits are exceeded
4. **Geographic Mismatches**: Requests from unexpected locations

### Example Prometheus Queries

```promql
# Rate of requests bypassing rate limit
rate(whitelist_bypassed_total[5m])

# Requests by partner
whitelist_requests_total{partnerId="partner-123"}

# Custom limit violations
whitelist_custom_limit_exceeded_total
```

## Compliance

### Audit Trail

All changes logged with:
- Timestamp
- Admin user ID
- IP address changed
- Changes made

### Data Retention

- Whitelist entries: Indefinite
- Access logs: 90 days (configurable)
- Change logs: 1 year

---

## Summary

The IP whitelist system provides:

✅ Rate limit bypass for trusted partners
✅ Tier-based access control
✅ CIDR block support
✅ Comprehensive logging & audit trail
✅ Geolocation validation
✅ Custom limits per partner
✅ Easy administration via REST API
✅ High-performance caching

For support: contact api-support@example.com
