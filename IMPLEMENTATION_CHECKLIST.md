# Implementation Checklist - ProxyPay Security & Performance

## Quick Reference

**Total Duration:** 5 weeks  
**Tasks:** 4 interconnected initiatives  
**Team Size:** 3-4 senior engineers  
**Risk Level:** Medium (staged rollout mitigates)

---

## Task #157: Input Validation - 2 weeks

### Week 1: Framework & Core Validators

- [ ] Create directory structure
  - [ ] `src/middleware/validators/`
  - [ ] `src/middleware/validators/__tests__/`

- [ ] Implement custom validators (`custom.ts`)
  - [ ] Phone number validator (international + provider-specific)
  - [ ] Stellar address validators (G-, M-, muxed accounts)
  - [ ] Currency amount validators (XLM, XAF)
  - [ ] Email + password validators
  - [ ] UUID + date validators
  - [ ] Provider/status/tier enums
  - [ ] API key format validator
  - [ ] Country code validator
  - [ ] Cross-field validators (amount ranges, phone+provider)
  - [ ] ID number + bank account validators
  - [ ] Composite validators with tests

- [ ] Define request schemas (`schemas.ts`)
  - [ ] Auth schemas (register, login, 2FA)
  - [ ] Transaction schemas (deposit, withdraw, list, cancel, dispute)
  - [ ] KYC schemas (submit KYC)
  - [ ] Vault schemas (create, transfer)
  - [ ] Dispute schemas (create)
  - [ ] Admin schemas (API key, user management, bulk operations)

- [ ] Implement error formatting (`errorFormatter.ts`)
  - [ ] Zod error formatter
  - [ ] Consistent response structure
  - [ ] Field-level error details
  - [ ] Audit logging for failures

- [ ] Create middleware factories (`index.ts`)
  - [ ] `validateBody()` factory
  - [ ] `validateQuery()` factory
  - [ ] `validateParams()` factory
  - [ ] `validateRequest()` for multi-source

- [ ] Unit tests for validators
  - [ ] Phone validator edge cases (10+ tests)
  - [ ] Stellar address formats (10+ tests)
  - [ ] Amount validators with limits (10+ tests)
  - [ ] Cross-field validation (5+ tests)
  - [ ] Custom validators (40+ tests total)

### Week 2: Integration & Full Coverage

- [ ] Integrate into auth routes
  - [ ] POST /api/auth/register
  - [ ] POST /api/auth/login
  - [ ] POST /api/auth/2fa/enable
  - [ ] POST /oauth/token

- [ ] Integrate into transaction routes
  - [ ] POST /api/transactions/deposit
  - [ ] POST /api/transactions/withdraw
  - [ ] GET /api/transactions (with query validation)
  - [ ] POST /api/transactions/:id/cancel
  - [ ] POST /api/transactions/:id/dispute
  - [ ] POST /api/transactions/bulk

- [ ] Integrate into KYC routes
  - [ ] POST /api/kyc/submit
  - [ ] GET /api/kyc/status

- [ ] Integrate into vault routes
  - [ ] POST /api/vaults
  - [ ] GET /api/vaults
  - [ ] POST /api/vaults/:id/transfer

- [ ] Integrate into dispute routes
  - [ ] GET /api/disputes
  - [ ] PUT /api/disputes/:id

- [ ] Integrate into admin routes
  - [ ] POST /api/admin/api-keys
  - [ ] PUT /api/admin/users/:id
  - [ ] POST /api/admin/bulk-operations

- [ ] SEP protocol endpoints (if applicable)
  - [ ] POST /sep10/auth
  - [ ] GET /sep12/customer
  - [ ] POST /sep24/transactions
  - [ ] POST /sep31/transactions

- [ ] Integration tests
  - [ ] Valid request passes validation
  - [ ] Invalid request returns 400
  - [ ] Error details are in response
  - [ ] Audit log records validation failure

- [ ] Documentation
  - [ ] API documentation for error responses
  - [ ] Developer guide for adding validators
  - [ ] Examples of validation usage

- [ ] Deployment
  - [ ] Deploy behind feature flag
  - [ ] Gradual rollout to 10% → 50% → 100%
  - [ ] Monitor validation error rates
  - [ ] Adjust thresholds if needed

---

## Task #156: Rate Limiting - 2 weeks

### Week 1: Engine & Configuration

- [ ] Create directory structure
  - [ ] `src/middleware/rateLimiters/`
  - [ ] `src/middleware/rateLimiters/__tests__/`

- [ ] Implement rate limiting engines (`engine.ts`)
  - [ ] Fixed Window limiter
  - [ ] Sliding Window limiter
  - [ ] Token Bucket limiter
  - [ ] Redis integration (atomic operations)
  - [ ] Fail-open behavior on Redis error
  - [ ] TTL management

- [ ] Configure all endpoints (`config.ts`)
  - [ ] Auth endpoints (5-7 configs)
  - [ ] Transaction endpoints (7-8 configs)
  - [ ] KYC endpoints (2 configs)
  - [ ] Vault endpoints (2 configs)
  - [ ] Dispute endpoints (2 configs)
  - [ ] SEP protocol endpoints (4 configs)
  - [ ] Admin endpoints (2 configs)
  - [ ] Data export endpoints (sensitive, strict limits)

- [ ] Implement IP whitelist (`whitelist.ts`)
  - [ ] Redis-backed whitelist
  - [ ] CIDR range support
  - [ ] IP/range add/remove
  - [ ] List all whitelisted
  - [ ] Initialize from env var

- [ ] Create middleware factory (`index.ts`)
  - [ ] `createRateLimitMiddleware()` factory
  - [ ] Response headers (X-RateLimit-\*)
  - [ ] Retry-After header
  - [ ] 429 Too Many Requests response

- [ ] Implement logging (`logger.ts`)
  - [ ] Log rate limit violations
  - [ ] Include client IP, endpoint, identifier
  - [ ] Track top offenders
  - [ ] Alert on sustained abuse

- [ ] Unit tests
  - [ ] Fixed window algorithm (5+ tests)
  - [ ] Sliding window algorithm (5+ tests)
  - [ ] Token bucket algorithm (5+ tests)
  - [ ] Whitelist functionality (5+ tests)
  - [ ] Redis error handling (3+ tests)

### Week 2: Integration & Monitoring

- [ ] Integrate into route handlers
  - [ ] Auth routes (all 4 endpoints)
  - [ ] Transaction routes (all 6 endpoints)
  - [ ] KYC routes (both endpoints)
  - [ ] Vault routes (all 3 endpoints)
  - [ ] Dispute routes (all 2 endpoints)
  - [ ] Admin routes (all endpoints)
  - [ ] SEP routes (all 4 endpoints)

- [ ] Implement metrics (`metrics.ts`)
  - [ ] Counter: total rate limit checks
  - [ ] Counter: violations by endpoint
  - [ ] Histogram: check duration
  - [ ] Counter: top offender IPs

- [ ] Create monitoring dashboard
  - [ ] Violations by endpoint (chart)
  - [ ] Top offender IPs (table)
  - [ ] Whitelist effectiveness (metric)
  - [ ] False positive rate (metric)

- [ ] Integration tests
  - [ ] Request under limit passes
  - [ ] Request over limit returns 429
  - [ ] Whitelisted request bypasses limit
  - [ ] Headers set correctly
  - [ ] Violation is logged
  - [ ] Distributed rate limiter works (multiple instances)

- [ ] Performance testing
  - [ ] Rate limit check latency <5ms
  - [ ] No performance degradation under load
  - [ ] Horizontal scaling works

- [ ] Deployment
  - [ ] Deploy with default limits
  - [ ] Monitor for false positives
  - [ ] Adjust limits based on metrics
  - [ ] Enable alerts on abuse

---

## Task #159: Query Optimization - 2-3 weeks

### Week 1: Analysis & Optimization

- [ ] Create directory structure
  - [ ] `src/services/queryOptimizer.ts`
  - [ ] `src/services/dataLoader.ts`
  - [ ] `src/services/queryCache.ts`
  - [ ] `src/middleware/queryMonitoring.ts`

- [ ] Implement query analyzer (`queryOptimizer.ts`)
  - [ ] EXPLAIN-based analysis
  - [ ] N+1 pattern detection
  - [ ] Sequential scan identification
  - [ ] Index usage checking
  - [ ] Slow query extraction from pg_stat_statements
  - [ ] Missing index suggestions

- [ ] Identify N+1 queries in codebase
  - [ ] Transaction listing
  - [ ] User transaction history
  - [ ] Dispute lookups
  - [ ] Ledger entry queries
  - [ ] Document queries
  - [ ] Audit log queries

- [ ] Implement DataLoader (`dataLoader.ts`)
  - [ ] User loader
  - [ ] Dispute loader
  - [ ] Ledger entry loader
  - [ ] Transaction loader
  - [ ] Configurable batch scheduling

- [ ] Create optimized queries (SQL)
  - [ ] Transaction list with JOINs
  - [ ] User transactions with relationships
  - [ ] Dispute batching
  - [ ] Ledger entry batching
  - [ ] Pagination queries

- [ ] Unit tests for DataLoader
  - [ ] Batch loading works (5+ tests)
  - [ ] Results mapped correctly (3+ tests)
  - [ ] Error handling (2+ tests)

- [ ] Query performance tests
  - [ ] Compare old vs new query performance
  - [ ] Verify result correctness
  - [ ] Benchmark improvements

### Week 2: Caching & Indexes

- [ ] Implement query caching (`queryCache.ts`)
  - [ ] Redis-backed cache
  - [ ] TTL configuration
  - [ ] Tag-based invalidation
  - [ ] Cache hit/miss logging
  - [ ] Batch operations

- [ ] Identify cache opportunities
  - [ ] Transaction lists (60s TTL)
  - [ ] User stats (5m TTL)
  - [ ] KYC status (24h TTL)
  - [ ] Vault details (15m TTL)
  - [ ] Exchange rates (1m TTL)

- [ ] Create index optimization SQL (`migrations/011_add_query_indexes.sql`)
  - [ ] Composite indexes (transactions user+date)
  - [ ] Partial indexes (pending transactions)
  - [ ] BRIN indexes (time-series data)
  - [ ] GIN indexes (JSONB fields)
  - [ ] Review existing indexes for removal

- [ ] Apply indexes to database
  - [ ] Use CONCURRENTLY to avoid locks
  - [ ] Verify index creation succeeded
  - [ ] Run ANALYZE

- [ ] Implement query monitoring (`queryMonitoring.ts`)
  - [ ] Slow query detection (>100ms threshold)
  - [ ] Query logging with duration
  - [ ] Metrics emission

- [ ] Query caching tests
  - [ ] Cache stores results (2+ tests)
  - [ ] Cache invalidation works (3+ tests)
  - [ ] Tag-based invalidation works (2+ tests)
  - [ ] Cache miss calls original query (1+ test)

### Week 3: Performance Validation

- [ ] End-to-end tests
  - [ ] Verify all queries optimized
  - [ ] No N+1 patterns remain
  - [ ] Cache hit rates >70%
  - [ ] Response times improved 10x

- [ ] Performance benchmarks
  - [ ] Transaction listing: 5s → 500ms
  - [ ] User transactions: 2s → 200ms
  - [ ] Query count: 301 → 4
  - [ ] Memory usage: -60%
  - [ ] Database CPU: -50%

- [ ] Documentation
  - [ ] Optimization patterns guide
  - [ ] Query best practices
  - [ ] Caching strategy
  - [ ] Monitoring guide

- [ ] Deployment
  - [ ] Deploy indexes (non-blocking)
  - [ ] Deploy optimized queries
  - [ ] Monitor performance metrics
  - [ ] Adjust cache TTLs if needed

---

## Task #158: End-to-End Encryption - 3 weeks

### Week 1: Infrastructure & Key Management

- [ ] Create directory structure
  - [ ] `src/crypto/keyManagement.ts`
  - [ ] `src/crypto/auditLog.ts`
  - [ ] `src/models/encrypted.ts`

- [ ] Implement key management (`keyManagement.ts`)
  - [ ] Master key generation
  - [ ] Per-user key derivation (HKDF)
  - [ ] Field-specific key derivation
  - [ ] Key metadata storage in Redis
  - [ ] Key rotation checking
  - [ ] Active/rotated/inactive status
  - [ ] List active keys

- [ ] Enhance encryption engine (`encryption.ts`)
  - [ ] AES-256-GCM encryption
  - [ ] Per-user key support
  - [ ] Batch encrypt/decrypt operations
  - [ ] Version tracking
  - [ ] Auth tag validation

- [ ] Implement audit logging (`auditLog.ts`)
  - [ ] Log all decryption access
  - [ ] Include requestor ID + role
  - [ ] Track success/failure
  - [ ] IP address + user agent
  - [ ] Get audit trail for user
  - [ ] Detect suspicious access patterns

- [ ] Unit tests for encryption
  - [ ] Encrypt/decrypt consistency (2+ tests)
  - [ ] Unique ciphertexts (1+ test)
  - [ ] Tampering detection (1+ test)
  - [ ] Wrong key failure (1+ test)
  - [ ] Batch operations (2+ tests)

- [ ] Unit tests for key management
  - [ ] Key derivation deterministic (1+ test)
  - [ ] Key rotation status (2+ tests)
  - [ ] Metadata storage/retrieval (2+ tests)

- [ ] Unit tests for audit logging
  - [ ] Log entry creation (1+ test)
  - [ ] Get audit trail (1+ test)
  - [ ] Suspicious access detection (1+ test)

### Week 2: ORM Integration & Migration

- [ ] Implement field decorator (`models/encrypted.ts`)
  - [ ] @Encrypted() decorator
  - [ ] encryptUserData() function
  - [ ] decryptUserData() function
  - [ ] Batch encryption/decryption
  - [ ] Handle null/undefined values

- [ ] Create database migration (`010_encrypt_pii_data.sql`)
  - [ ] Create pii_audit_log table
  - [ ] Add encrypted\_\* columns to users
  - [ ] Backup plaintext data (30-day retention)
  - [ ] Create indexes on audit log

- [ ] Data migration script
  - [ ] Read plaintext PII from backup
  - [ ] Encrypt each field with user key
  - [ ] Store encrypted JSON in new columns
  - [ ] Verify all records migrated
  - [ ] Delete plaintext backup after verification

- [ ] Integration tests
  - [ ] Encrypt/decrypt through ORM (2+ tests)
  - [ ] Batch operations (1+ test)
  - [ ] Database round-trip (1+ test)
  - [ ] Audit trail created (1+ test)

- [ ] Migration validation
  - [ ] Run on staging environment
  - [ ] Verify no data loss
  - [ ] Test rollback procedure
  - [ ] Document migration steps

### Week 3: Deployment & Hardening

- [ ] Pre-deployment checks
  - [ ] All PII fields identified
  - [ ] Encryption/decryption tested
  - [ ] Audit logging verified
  - [ ] Performance acceptable (<50ms)
  - [ ] Rollback procedure documented

- [ ] Deployment (zero-downtime)
  - [ ] Deploy new code (handles both old/new)
  - [ ] Run data migration (background job)
  - [ ] Verify encryption/decryption working
  - [ ] Monitor audit logs
  - [ ] Verify no decryption errors

- [ ] Post-deployment verification
  - [ ] All PII encrypted in database
  - [ ] Audit log contains all accesses
  - [ ] Decryption latency acceptable
  - [ ] Backup retention cleaned up

- [ ] Documentation
  - [ ] Encryption architecture
  - [ ] Key management procedures
  - [ ] Key rotation playbook
  - [ ] Emergency decryption process
  - [ ] Audit trail interpretation

- [ ] Key rotation setup
  - [ ] Scheduled rotation (90 days)
  - [ ] Automated key derivation update
  - [ ] Re-encryption of old data
  - [ ] Monitoring of rotation process

---

## General Tasks (All Phases)

- [ ] Testing infrastructure
  - [ ] Unit test framework (Jest - already in use)
  - [ ] Integration test setup
  - [ ] Load testing setup (k6 - already in use)
  - [ ] Mock setup for external dependencies

- [ ] CI/CD integration
  - [ ] Tests run on every commit
  - [ ] Coverage requirements enforced
  - [ ] Linting checks pass
  - [ ] No security issues in dependencies

- [ ] Documentation
  - [ ] API documentation updated
  - [ ] Developer guide updated
  - [ ] Security guide updated
  - [ ] Operations guide updated
  - [ ] Runbook created for each task

- [ ] Team training
  - [ ] Walkthrough of validation middleware
  - [ ] Walkthrough of rate limiting
  - [ ] Walkthrough of query optimization
  - [ ] Walkthrough of encryption architecture

- [ ] Monitoring setup
  - [ ] Validation error dashboard
  - [ ] Rate limit violations dashboard
  - [ ] Query performance dashboard
  - [ ] Encryption access dashboard
  - [ ] Alerts configured

---

## Deployment Checklist

### Pre-Deployment

- [ ] Code reviewed by 2+ engineers
- [ ] All tests passing locally
- [ ] Coverage maintained/improved
- [ ] No breaking changes
- [ ] Documentation updated
- [ ] Stakeholders notified

### Deployment Steps

- [ ] Merge to main branch
- [ ] CI pipeline passes
- [ ] Deploy to staging
- [ ] Run smoke tests on staging
- [ ] Rollback procedure tested
- [ ] Deploy to production
- [ ] Monitor error rates
- [ ] Verify functionality

### Post-Deployment

- [ ] New metrics established
- [ ] Alert thresholds tuned
- [ ] No incident reports
- [ ] Performance improvement verified
- [ ] Documentation updated with results

---

## Success Criteria

### #157 Validation

- [ ] 100% of endpoints have validation
- [ ] Validation error rate <1%
- [ ] Error responses consistent
- [ ] Field-level errors in response
- [ ] Audit trail complete

### #156 Rate Limiting

- [ ] All endpoints rate limited
- [ ] Rate limit accuracy >99.9%
- [ ] Check latency <5ms
- [ ] False positive rate <0.1%
- [ ] Horizontal scaling works

### #159 Query Optimization

- [ ] 70% reduction in query count
- [ ] 10x faster transaction listing
- [ ] 50% reduction in database CPU
- [ ] Cache hit rate >70%
- [ ] No data corruption

### #158 Encryption

- [ ] 100% of PII encrypted
- [ ] Encryption latency <50ms
- [ ] Complete audit trail
- [ ] Key rotation automated
- [ ] GDPR compliant

---

## Risk Mitigation

| Task | Risk                       | Mitigation                    |
| ---- | -------------------------- | ----------------------------- |
| #157 | Validation too strict      | Feature flag, gradual rollout |
| #156 | Internal services blocked  | Comprehensive whitelist       |
| #159 | Corrupted query results    | Compare with old queries      |
| #158 | Data loss during migration | Backup before migration       |

---

## Rollback Procedures

### #157 Validation

```bash
# Disable validation middleware
VALIDATION_ENABLED=false
# Or revert commit
git revert <commit>
```

### #156 Rate Limiting

```bash
# Whitelist all traffic
RATE_LIMIT_WHITELIST_IPS=0.0.0.0/0
# Or revert commit
git revert <commit>
```

### #159 Query Optimization

```bash
# Keep old query paths as fallback
# Deploy rollback immediately
git revert <commit>
```

### #158 Encryption

```bash
# Use plaintext backup (30-day retention)
# Fall back to plaintext decryption
# Investigate and fix before retrying
```

---

## Questions?

- See **IMPLEMENTATION_PLAN.md** for strategy
- See **IMPLEMENTATION_DETAIL_VALIDATION.md** for #157
- See **IMPLEMENTATION_DETAIL_RATE_LIMITING.md** for #156
- See **IMPLEMENTATION_DETAIL_QUERY_OPTIMIZATION.md** for #159
- See **IMPLEMENTATION_DETAIL_ENCRYPTION.md** for #158
