# ProxyPay Security & Performance Implementation Plan

## Overview

This plan addresses four interconnected security and performance tasks for ProxyPay:

- **#156**: Distributed rate limiting (Redis-backed)
- **#157**: Comprehensive input validation layer
- **#158**: End-to-end encryption for sensitive data
- **#159**: Database query optimization

## Execution Strategy

**Dependencies & Order:**

1. **#157** (Validation) → Foundation for all other tasks
2. **#156** (Rate Limiting) → Can run parallel with #157
3. **#159** (Query Optimization) → Requires profiling tools
4. **#158** (E2E Encryption) → Most complex, data migration required

**Timeline:** 4-5 weeks (staggered delivery)

---

## Task #157: Comprehensive API Input Validation Layer

### Problem

- Validation is inconsistent across endpoints
- No centralized schema definitions
- Security vulnerabilities from unvalidated input
- Data corruption from invalid data types

### Solution Architecture

```
Request Flow:
┌─────────────────┐
│ Express Router  │
└────────┬────────┘
         │
    ┌────▼──────────────────┐
    │ Validation Middleware  │ ← Schema-based
    │ (Zod validators)       │
    └────┬───────────────────┘
         │
    ┌────▼──────────────────┐
    │ Custom Validators     │ ← Phone, wallet, amount
    └────┬───────────────────┘
         │
    ┌────▼──────────────────┐
    │ Controller/Service    │
    └───────────────────────┘
```

### Implementation Details

**Phase 1: Core Validation Framework (Week 1)**

Files to create:

- `src/middleware/validators/index.ts` - Main validator exports
- `src/middleware/validators/schemas.ts` - Zod schemas for all endpoints
- `src/middleware/validators/custom.ts` - Custom validators (phone, wallet, etc.)
- `src/middleware/validators/errorFormatter.ts` - Consistent error responses

**Phase 2: Endpoint Coverage (Week 1-2)**

Priority endpoints (by risk):

1. **Auth endpoints** (`POST /api/auth/register`, `/login`, `/2fa/enable`)
2. **Transaction endpoints** (`POST /api/transactions/deposit`, `/withdraw`)
3. **KYC endpoints** (`POST /api/kyc/submit`)
4. **Vault endpoints** (fund transfers)
5. **Admin endpoints** (user management)

**Phase 3: Tests & Documentation (Week 2)**

- Unit tests for all validators
- Integration tests for endpoint validation
- Error response documentation

### Key Features

```typescript
// Validation layer capabilities:
1. Body validation (request.body)
2. Query parameter validation
3. Route parameter validation
4. Nested object validation
5. Cross-field validation (e.g., min/max amounts)
6. Custom error messages per field
7. Field-level error details in response
8. Automatic type coercion where safe
9. Rate limit per validation rule
10. Audit logging of validation failures
```

### Expected Outcomes

- ✅ 100% endpoint coverage
- ✅ Consistent error response format
- ✅ Field-level validation errors
- ✅ 50+ custom validators
- ✅ Validation test suite (100+ tests)

---

## Task #156: Distributed Rate Limiting

### Problem

- No protection against brute force attacks
- No DoS protection for public endpoints
- Vulnerable to credential stuffing
- No differentiated limits per endpoint

### Solution Architecture

```
Request arrives
       │
       ├─→ Check whitelist (internal services)
       │        ↓
       │    [PASS] → Next middleware
       │
       └─→ Extract identifier (IP + endpoint)
              ↓
          Query Redis:
          ratelimit:endpoint:ip
              ↓
        ┌─────┴─────┐
        │           │
    [UNDER]    [EXCEEDED]
        │           │
    [PASS]    Return 429
                    │
              Retry-After header
              X-RateLimit-* headers
```

### Implementation Details

**Phase 1: Core Rate Limit Engine (Week 1)**

Files to create:

- `src/middleware/rateLimiters/index.ts` - Main exports
- `src/middleware/rateLimiters/engine.ts` - Redis-backed limiter
- `src/middleware/rateLimiters/config.ts` - Rate limit configurations
- `src/middleware/rateLimiters/whitelist.ts` - IP/service whitelist
- `src/middleware/rateLimiters/logger.ts` - Violation logging

**Phase 2: Endpoint-Specific Limits (Week 1-2)**

```typescript
// Examples of different limits:
AUTH_ENDPOINTS: 100 req/min per IP
DATA_ENDPOINTS: 1000 req/min per IP
ADMIN_ENDPOINTS: 10 req/min per API key
DEPOSIT: 50 req/hour per user
WITHDRAW: 30 req/hour per user
KYC_SUBMIT: 5 req/day per user
```

**Phase 3: Monitoring & Dashboards (Week 2)**

- Prometheus metrics for rate limit hits
- Dashboard showing top offenders
- Alert thresholds for sustained abuse

### Key Features

```typescript
// Capabilities:
1. Per-endpoint rate limits
2. Per-user rate limits
3. Per-IP rate limits
4. Composite keys (IP + endpoint + user)
5. Distributed across Redis
6. Horizontal scaling (multiple instances)
7. Automatic cleanup (TTL)
8. Whitelist for internal services
9. Graduated response (warn → block)
10. Detailed violation logging
11. 429 Too Many Requests response
12. Retry-After header
13. X-RateLimit-* headers (remaining, reset)
14. GraphQL-specific limits
15. WebSocket connection limits
```

### Expected Outcomes

- ✅ 15+ endpoint rate limit configs
- ✅ <5ms Redis lookup latency
- ✅ Horizontal scaling support
- ✅ 99.9% uptime for rate limiter
- ✅ Violation audit trail
- ✅ Admin dashboard for monitoring

---

## Task #158: End-to-End Encryption for Sensitive Data

### Problem

- PII stored in plaintext
- Compliance violations (GDPR, local regulations)
- Breach impact: all personal data exposed
- No audit trail for decryption access

### Solution Architecture

```
User Data Input
       │
       ├─→ Validation (before encryption)
       │
       └─→ Encryption Layer
              ├─→ Key lookup/derivation
              ├─→ AES-256-GCM encryption
              ├─→ IV + Auth Tag generation
              └─→ Store encrypted blob
                     │
                     Database (encrypted)
                     │
                  On retrieval:
                     ├─→ Audit log entry
                     ├─→ Permission check
                     ├─→ Decrypt
                     └─→ Return plaintext
```

### Implementation Details

**Phase 1: Encryption Infrastructure (Week 2-3)**

Files to create/modify:

- `src/crypto/encryption.ts` - AES-256-GCM implementation (ALREADY EXISTS)
- `src/crypto/keyManagement.ts` - Key derivation & storage
- `src/crypto/hsm.ts` - HSM integration (ALREADY EXISTS)
- `src/models/encrypted.ts` - Encrypted field decorator
- `src/migrations/009_encrypt_existing_data.sql` - Data migration

**Phase 2: Field-Level Encryption (Week 3)**

Sensitive fields to encrypt:

- `users.phone_number`
- `users.id_number`
- `users.full_name`
- `users.address`
- `users.bank_account`
- `transaction.beneficiary_phone`
- `compliance_documents.document_content`

**Phase 3: Access Audit & Key Rotation (Week 3-4)**

- Audit logging for all decryption access
- Key rotation procedures
- Emergency decryption protocols

### Key Features

```typescript
// Capabilities:
1. AES-256-GCM (industry standard)
2. Per-user key derivation
3. Master key rotation (90-day cycles)
4. HSM support for key storage
5. Transparent encryption/decryption
6. Audit trail for access
7. Batch decryption operations
8. Search on encrypted fields (if needed)
9. Key versioning
10. Backup encryption
11. Emergency decryption logging
12. Performance: <50ms per field
```

### Expected Outcomes

- ✅ All PII encrypted at rest
- ✅ <50ms encryption/decryption overhead
- ✅ Complete audit trail
- ✅ GDPR/compliance alignment
- ✅ Key rotation procedures documented
- ✅ Zero-downtime data migration

---

## Task #159: Database Query Optimization

### Problem

- N+1 query patterns in transaction service
- Slow transaction listing endpoint (2-5 seconds)
- High database CPU usage
- Memory bloat from result sets

### Solution Architecture

```
Before (N+1):
GET /transactions
  ├─→ SELECT * FROM transactions (100 rows)
  ├─→ For each transaction:
  │   ├─→ SELECT * FROM users WHERE id = ?
  │   ├─→ SELECT * FROM disputes WHERE tx_id = ?
  │   └─→ SELECT * FROM ledger_entries WHERE tx_id = ?
  └─→ Total: 1 + (100 * 3) = 301 queries

After (Optimized):
GET /transactions
  ├─→ SELECT * FROM transactions (100 rows)
  ├─→ SELECT * FROM users WHERE id IN (...)  (1 query)
  ├─→ SELECT * FROM disputes WHERE tx_id IN (...) (1 query)
  ├─→ SELECT * FROM ledger_entries WHERE tx_id IN (...) (1 query)
  └─→ Total: 4 queries + Redis cache
```

### Implementation Details

**Phase 1: Query Analysis & Profiling (Week 2)**

Tools:

- Enable `log_min_duration_statement` in PostgreSQL
- APM instrumentation (Datadog dd-trace already in use)
- Identify slowest queries

**Phase 2: Query Optimization (Week 3)**

Optimization techniques:

1. **JOIN operations** - Replace N+1 with single JOIN
2. **DataLoader** - Batch query execution
3. **Query result caching** - Redis L2 cache
4. **Pagination** - Limit result sets
5. **Materialized views** - Pre-computed aggregates
6. **Index improvements** - Add composite indexes

**Phase 3: Monitoring & Benchmarks (Week 3-4)**

- Performance baseline establishment
- Continuous monitoring
- Query execution plan documentation

### Key Optimizations

```typescript
// Priority optimizations:
1. Transaction listing: JOIN users, disputes, ledger
   Expected: 5sec → 500ms (10x improvement)

2. User transaction history: DataLoader for batching
   Expected: 2sec → 200ms (10x improvement)

3. Transaction details: Single JOIN query
   Expected: 1sec → 50ms (20x improvement)

4. Cache layer: Redis for frequently accessed
   Expected: Cache hit rate 70%+

5. Pagination: Enforce limits
   Expected: Memory usage -60%
```

### Query Examples

```sql
-- BEFORE: 1 + N queries
SELECT * FROM transactions WHERE user_id = ?;
-- Then in app: loop and query users, disputes, ledger

-- AFTER: Single optimized query
SELECT
  t.*,
  u.id, u.email, u.phone_number,
  d.id as dispute_id, d.status as dispute_status,
  l.entry_type, l.amount as ledger_amount
FROM transactions t
LEFT JOIN users u ON t.user_id = u.id
LEFT JOIN disputes d ON t.id = d.transaction_id
LEFT JOIN ledger_entries l ON t.id = l.transaction_id
WHERE t.user_id = ?
ORDER BY t.created_at DESC
LIMIT 100;
```

### Expected Outcomes

- ✅ 70% reduction in query count
- ✅ 10x faster transaction listing (500ms)
- ✅ 50% reduction in database CPU
- ✅ 60% reduction in memory usage
- ✅ Query execution plans documented
- ✅ Continuous monitoring in place

---

## Cross-Task Dependencies

```
#157 (Validation)
    ↓
    ├→ #156 (Rate Limiting) [validation input for limiter config]
    ├→ #159 (Query Opt) [validate query parameters]
    └→ #158 (Encryption) [validate before encryption]

#156 (Rate Limiting)
    ├→ Uses #157 (validated config)
    └→ Prevents #159 (excessive queries from abuse)

#159 (Query Optimization)
    └→ Improves #158 (encryption operations faster)

#158 (Encryption)
    └→ Uses #157 (validates encrypted data format)
```

---

## Testing Strategy

### Unit Tests

- Validator functions (150+ tests)
- Rate limiter logic (80+ tests)
- Encryption/decryption (60+ tests)
- Query optimization (100+ tests)

### Integration Tests

- End-to-end request validation
- Rate limiting across instances
- Encryption with database
- Query performance benchmarks

### Performance Tests

- Load testing with rate limiting
- Encryption overhead measurement
- Query plan optimization verification
- Latency P95/P99 tracking

---

## Rollout Plan

### Week 1: Validation + Rate Limiting

- Deploy #157 behind feature flag
- Deploy #156 with gradual rollout
- Monitor error rates

### Week 2: Finalize Validation

- Remove feature flags
- Full endpoint coverage
- Adjust limits based on metrics

### Week 3: Query Optimization

- Deploy optimizations per endpoint
- Monitor query times
- Benchmark improvements

### Week 4: Encryption

- Migrate historical data
- Deploy new field encryption
- Monitor audit logs

### Week 5: Hardening & Documentation

- Security review
- Performance optimization
- Documentation updates

---

## Monitoring & Metrics

### Dashboards

1. **Validation Dashboard**
   - Validation failure rate by endpoint
   - Most common validation errors
   - Field-level error distribution

2. **Rate Limiting Dashboard**
   - Requests blocked per endpoint
   - Top violators (IPs)
   - Whitelist effectiveness

3. **Encryption Dashboard**
   - Encryption/decryption latency
   - Key rotation status
   - Audit log volume

4. **Query Performance Dashboard**
   - Query execution times (P50/P95/P99)
   - N+1 query detection
   - Cache hit rates

---

## Success Criteria

| Task | Metric                   | Target          | Timeline |
| ---- | ------------------------ | --------------- | -------- |
| #157 | Endpoint coverage        | 100%            | Week 2   |
| #157 | Validation errors        | <1% of requests | Week 2   |
| #156 | Rate limit accuracy      | 99.9%           | Week 2   |
| #156 | False positives          | <0.1%           | Week 2   |
| #159 | Query count reduction    | 70%             | Week 3   |
| #159 | Transaction list latency | <500ms (P95)    | Week 3   |
| #158 | Data encryption          | 100% of PII     | Week 4   |
| #158 | Encryption latency       | <50ms per field | Week 4   |
