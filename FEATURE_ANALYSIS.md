# ProxyPay Feature Requests Analysis & Roadmap

**Date:** July 27, 2026 | **Status:** Analysis Complete

---

## Executive Summary

This document analyzes four interconnected feature requests for ProxyPay, evaluating current state, dependencies, and implementation priorities. Key finding: **#175 (Transaction Filtering) has the lowest implementation effort but highest ROI and should be prioritized first**, while #172 (API Documentation) sets the foundation for all subsequent feature visibility.

---

## Feature Requests Overview

| #    | Title                           | Priority | Effort | Impact | Skills                |
| ---- | ------------------------------- | -------- | ------ | ------ | --------------------- |
| #172 | Comprehensive API Documentation | Medium   | High   | High   | Tech Writing, OpenAPI |
| #173 | Provider Health Monitoring      | High     | Medium | High   | Monitoring, Node.js   |
| #174 | KYC Document Verification       | High     | High   | High   | API Integration, KYC  |
| #175 | Transaction Filtering & Search  | High     | Low    | High   | API Design, SQL       |

---

## Feature-by-Feature Analysis

### #172: Comprehensive API Documentation

**Description:** Create comprehensive OpenAPI 3.0 specification with examples and automated deployment.

#### Current State (PARTIAL ✓)

- **OpenAPI Generator**: Basic generator exists at `src/openapi/generator.ts` (77 LOC)
- **Schema Files**: 10 schema files covering auth, transactions, KYC, vaults, fees, SEP-30, SEP-38, HTLC, prices, contacts
- **Path Definitions**: 10 path files with endpoint documentation (8,769 LOC total)
- **Coverage**: Partial—core endpoints documented but missing:
  - Webhook documentation and examples
  - Error response schemas
  - Security schemes (JWT, OAuth2, API keys)
  - Request/response examples for each endpoint
  - Authentication flow diagrams
  - Code examples (cURL, JavaScript, Python, Go)
  - Automated deployment pipeline

#### What Needs to Be Done

1. **Complete OpenAPI 3.0 spec** with all components:
   - Security schemes (Bearer JWT, OAuth2 client credentials, API keys)
   - Global error response definitions (400, 401, 403, 404, 429, 500)
   - Reusable response envelopes
   - Example values for all schemas
2. **Webhook Documentation**:
   - Webhook schema definitions
   - Event types catalog
   - Retry logic and delivery guarantees
   - Signature verification examples
   - Sample payloads for each event type

3. **Code Examples**:
   - cURL examples for each endpoint
   - JavaScript/Node.js SDK examples
   - Python examples
   - Go examples
   - Interactive request builder

4. **Deployment**:
   - Generate static OpenAPI JSON file
   - Deploy to CDN for versioning
   - Set up Swagger UI with custom styling
   - Create ReDoc alternative for better mobile experience

#### Acceptance Criteria Status

- ❌ Create OpenAPI 3.0 specification for all endpoints (70% complete)
- ❌ Document request/response schemas with examples (50% complete)
- ❌ Add authentication and security scheme documentation (0%)
- ❌ Include error response documentation (20%)
- ✓ Generate interactive API docs using Swagger UI (partial)
- ❌ Add webhook documentation and examples (0%)
- ❌ Create code examples for common workflows (0%)
- ❌ Set up automated documentation deployment (0%)

#### Dependencies

- None (can be developed independently)

#### Recommended Approach

1. Extend generator to include security schemes
2. Create comprehensive error schema definitions
3. Add webhook event definitions
4. Generate examples programmatically from test fixtures
5. Set up GitHub Actions for automated generation + deployment to Vercel/Netlify

---

### #173: Provider Health Monitoring

**Description:** Implement health monitoring for all mobile money providers with automatic failover and alerting.

#### Current State (PARTIAL ✓)

- **Health Check Service**: `src/services/mobilemoney/providers/healthCheck.ts` (351 LOC)
  - Implements `checkMobileMoneyHealth()` function
  - Supports MTN, Airtel, Orange
  - Configurable timeout and ping URLs
  - Redis-backed caching
- **Scheduled Job**: `src/jobs/providerHealthCheck.ts` (299 LOC)
  - Runs every 5 minutes via cron
  - Tracks provider status changes
  - PagerDuty integration for alerts
  - Circuit breaker management
- **Circuit Breaker**: `src/utils/circuitBreaker.ts` (216 LOC)
  - Automatic failover on consecutive failures
  - State machine (Closed → Open → Half-Open)
  - Per-provider configuration
- **Metrics**: Provider metrics middleware and Prometheus export

#### What Needs to Be Done

1. **Dashboard Implementation**:
   - Real-time provider status UI
   - Historical uptime charts
   - SLA compliance tracking
   - Incident timeline

2. **Enhanced Alerting**:
   - SMS alerts for critical outages
   - Email summaries
   - Slack notifications
   - Webhook-based custom alerts

3. **Historical Analysis**:
   - Persist health check results to database
   - Generate availability reports
   - Trend analysis (performance degradation detection)
   - Root cause analysis helpers

4. **Failover Strategy**:
   - Automatic provider switching
   - Load balancing across healthy providers
   - Manual override capability
   - Fallback provider configuration

#### Acceptance Criteria Status

- ✓ Create health check endpoints for each provider (100%)
- ✓ Implement periodic health checks (100%)
- ❌ Track provider uptime and SLA compliance (30%)
- ❌ Create provider status dashboard (0%)
- ✓ Implement automatic failover (80%)
- ✓ Send alerts (70% via PagerDuty)
- ✓ Log health check results (80%)
- ❌ Create historical availability reports (0%)

#### Dependencies

- None (can be developed independently)
- Recommended to complete BEFORE #174 (for KYC provider health checks)

#### Recommended Approach

1. Create database tables for health check history
2. Extend health check job to persist results
3. Build admin dashboard endpoint
4. Implement SLA calculation service
5. Add report generation for stakeholders

---

### #174: KYC Document Verification

**Description:** Integrate third-party KYC provider to automate document verification workflow.

#### Current State (PARTIAL ✓)

- **KYC Service**: `src/services/kyc.ts` (508 LOC)
  - Entrust Identity Verification integration (was Onfido)
  - Applicant creation and management
  - Document upload to S3
  - Workflow runs and status tracking
- **Database Model**: `src/models/complianceDocument.ts` (302 LOC)
  - Stores verification results with audit trail
  - Document archival support
  - Facet tracking (facial recognition, document quality)
- **KYC Routes**: `src/routes/kycRoutes.ts` (297 LOC)
  - Document upload endpoints
  - Visibility controls
  - KYC status endpoints
- **Webhook Handler**: Partial webhook support in KYC controller

#### What Needs to Be Done

1. **Webhook Integration**:
   - Implement webhook handler for status updates
   - Signature verification
   - Idempotency handling
   - Event type routing

2. **Retry Logic**:
   - Exponential backoff for failed verifications
   - Dead letter queue for permanent failures
   - Manual retry trigger endpoint

3. **Manual Review Queue**:
   - Dashboard for flagged cases
   - Admin tools for manual review
   - Appeal workflow for rejected users
   - Tier upgrade requests

4. **Test Coverage**:
   - Mock KYC provider for testing
   - Webhook test simulator
   - Document validation tests
   - Edge case handling

#### Acceptance Criteria Status

- ✓ Integrate with KYC provider API (90% - Entrust integrated)
- ✓ Implement document upload workflow (80%)
- ✓ Store verification results with audit trail (100%)
- ❌ Implement retry logic for failed verifications (0%)
- ❌ Add webhook support for verification status updates (30%)
- ❌ Create verification status dashboard (0%)
- ❌ Implement manual review queue (0%)
- ❌ Add comprehensive test coverage (20%)

#### Dependencies

- **Depends on:** #173 (health checks for KYC provider)
- **Required for:** #175 (transaction filtering needs KYC tier for rate limits)

#### Recommended Approach

1. Build webhook infrastructure (verifier, queue processor)
2. Create database tables for retry history
3. Implement retry job with exponential backoff
4. Build admin dashboard for manual reviews
5. Add comprehensive test suite with fixtures

---

### #175: Transaction Filtering & Search

**Description:** Implement advanced filtering and search for transaction queries with performance optimization.

#### Current State (PARTIAL ✓)

- **Filter Utils**: `src/utils/transactionFilters.ts` (156 LOC)
  - Status filtering (multiple statuses supported)
  - Pagination with limit/offset
  - Reference number search
  - Basic sortable structure
- **Transaction Model**: `src/models/transaction.ts` (878 LOC)
  - Cursor-based pagination support
  - Tag filtering
  - Metadata search
  - Note-based search
  - Idempotency key handling
  - Full transaction history query
- **Query Optimization**: Partial
  - Indexed columns on (user_id, status, created_at)
  - Read replica routing for list operations
  - Cache-aside pattern for stats

#### What Needs to Be Done

1. **Advanced Filtering**:
   - Date range filtering (startDate/endDate)
   - Amount range filtering (minAmount/maxAmount)
   - Provider filtering (already supported)
   - Status filtering (already supported)
   - Full-text search on notes
2. **Search Enhancements**:
   - Full-text indexing on notes and metadata
   - Phone number search
   - Stellar address search
   - Reference number prefix search

3. **Sorting & Pagination**:
   - Multi-column sorting
   - Cursor-based pagination (keyset pagination)
   - Offset pagination (already supported)
   - Sort order specification (ASC/DESC)

4. **Filtering Presets**:
   - Last 7 days preset
   - Failed transactions preset
   - Pending transactions preset
   - Custom saved filters

5. **Query Optimization**:
   - Analyze query plans
   - Add indexes for filtered columns
   - Query result caching
   - Pagination performance testing

6. **Testing & Documentation**:
   - Comprehensive test cases
   - API documentation with examples
   - Performance benchmarks
   - Query optimization guide

#### Acceptance Criteria Status

- ✓ Add filtering by status (100%)
- ❌ Add filtering by date range (0%)
- ❌ Add filtering by amount range (0%)
- ❌ Implement full-text search on notes (0%)
- ✓ Add sorting by multiple fields (partial - basic sorting exists)
- ✓ Implement pagination (100% - both cursor and offset)
- ❌ Add filtering presets (0%)
- ✓ Optimize queries for performance (partial)
- ❌ Create filtering documentation and examples (0%)
- ❌ Add comprehensive test coverage (20%)

#### Dependencies

- None (can be developed independently)

#### Recommended Approach

1. Add date range and amount range filters to query builder
2. Implement full-text search with PostgreSQL FTS
3. Create saved filter storage
4. Add query performance analysis
5. Build comprehensive test suite with performance benchmarks

---

## Implementation Roadmap

### Recommended Priority Order

```
Priority 1: #175 (Transaction Filtering)
  └─ Why: Lowest effort, immediate user impact, foundation for other features
  └─ Effort: 2-3 weeks
  └─ Blockers: None
  └─ Can parallel: All others

Priority 2: #172 (API Documentation)
  └─ Why: Enables developer adoption, foundation for SDKs
  └─ Effort: 3-4 weeks
  └─ Blockers: None (use #175 as example in docs)
  └─ Can parallel: #173, #174

Priority 3: #173 (Provider Health Monitoring)
  └─ Why: Operational excellence, medium effort, high reliability impact
  └─ Effort: 2-3 weeks
  └─ Blockers: None
  └─ Enables: Better #174 implementation

Priority 4: #174 (KYC Document Verification)
  └─ Why: Complex, highest effort, but critical for compliance
  └─ Effort: 3-4 weeks
  └─ Blockers: Optional dependency on #173
  └─ Depends on: #173 for health monitoring KYC provider
```

### Timeline Estimate (Team of 2-3 developers)

| Phase     | Features              | Duration       | End Date       |
| --------- | --------------------- | -------------- | -------------- |
| Phase 1   | #175                  | 2-3 weeks      | Week of Aug 3  |
| Phase 2   | #172, #173 (parallel) | 3-4 weeks      | Week of Aug 24 |
| Phase 3   | #174                  | 3-4 weeks      | Week of Sep 14 |
| **Total** | All 4 features        | **9-11 weeks** | Mid-September  |

---

## Resource Allocation

### Skill Requirements

| Feature | Skills                                | Team Size                   |
| ------- | ------------------------------------- | --------------------------- |
| #172    | OpenAPI, Technical Writing, UI/UX     | 1.5 (1 dev + 1 tech writer) |
| #173    | Monitoring, Node.js, DevOps           | 1-2 devs                    |
| #174    | API Integration, KYC/AML, Node.js     | 2 devs                      |
| #175    | Database, Query Optimization, Node.js | 1-2 devs                    |

### Recommended Team Composition

- **Developer A**: #175 → #172 (foundations)
- **Developer B**: #173 → #174 (infrastructure)
- **Developer C** (optional): #172 (documentation) or #174 (KYC complexity)

---

## Risk Analysis

### #172 (API Documentation)

- **Risk**: Documentation drift as API evolves
- **Mitigation**: Automate schema generation from Zod schemas; enforce docs in CI/CD

### #173 (Provider Health Monitoring)

- **Risk**: False positives in health checks causing unnecessary failovers
- **Mitigation**: Configurable thresholds; manual override capability; incident deduping

### #174 (KYC Document Verification)

- **Risk**: Webhook delivery failure loses status updates
- **Mitigation**: Implement webhook outbox pattern; scheduled polling fallback

### #175 (Transaction Filtering)

- **Risk**: Complex queries cause performance degradation
- **Mitigation**: Query result caching; LIMIT enforcement; index analysis in CI/CD

---

## Success Metrics

| Feature | KPI                         | Target                           |
| ------- | --------------------------- | -------------------------------- |
| #172    | API docs coverage           | 100% of endpoints                |
| #172    | Adoption (SDK downloads)    | 50% increase in 2 months         |
| #173    | Provider uptime             | > 99.5% reported SLA             |
| #173    | Incident response time      | < 5 min PagerDuty trigger        |
| #174    | KYC verification time       | < 2 hours average                |
| #174    | Manual review rate          | < 5% of submissions              |
| #175    | Query performance p95       | < 500ms                          |
| #175    | User engagement (filtering) | 40% of list requests use filters |

---

## Dependencies Matrix

```
#175 Transaction Filtering
  ├─ No direct dependencies
  └─ Enables: Better UX for #174 (filter by KYC status)

#172 API Documentation
  ├─ No hard dependencies
  ├─ Improved by: #175, #173, #174 (more features to document)
  └─ Enables: Developer adoption

#173 Provider Health Monitoring
  ├─ No direct dependencies
  ├─ Recommended before: #174
  └─ Enables: Better #174 monitoring

#174 KYC Document Verification
  ├─ Optional dependency: #173 (health checks for KYC provider)
  └─ Integrates with: #175 (filter by KYC tier)
```

---

## Detailed Implementation Checklist

### #175: Transaction Filtering (Weeks 1-3)

```
Week 1 - Core Filtering
- [ ] Add date range filter to query builder
- [ ] Add amount range filter to query builder
- [ ] Add full-text search on notes via PostgreSQL FTS
- [ ] Update API schema to include new filters
- [ ] Write unit tests (50+ cases)

Week 2 - Advanced Features
- [ ] Implement multi-column sorting
- [ ] Create saved filter storage (database schema)
- [ ] Add filter presets (last 7 days, failed, pending)
- [ ] Implement cursor-based keyset pagination
- [ ] Performance test queries (target < 500ms p95)

Week 3 - Polish
- [ ] Query plan analysis and index optimization
- [ ] Caching strategy for popular filters
- [ ] Comprehensive integration tests
- [ ] API documentation with examples
- [ ] Load testing (k6 scenarios)
```

### #172: API Documentation (Weeks 4-7)

```
Week 4 - OpenAPI Spec
- [ ] Add security schemes (JWT, OAuth2, API key)
- [ ] Create global error response schemas
- [ ] Add webhook event definitions (20+ event types)
- [ ] Create example values for all schemas
- [ ] Generate static OpenAPI JSON

Week 5 - Code Examples
- [ ] cURL examples for all endpoints
- [ ] JavaScript/Node.js examples
- [ ] Python examples
- [ ] Go examples
- [ ] Example request library setup

Week 6 - Webhooks
- [ ] Webhook documentation
- [ ] Signature verification examples
- [ ] Retry policy documentation
- [ ] Event delivery guarantees
- [ ] Sample webhook handler code

Week 7 - Deployment
- [ ] Set up Swagger UI with custom branding
- [ ] Deploy to Vercel/Netlify
- [ ] Set up GitHub Actions for CI/CD
- [ ] Create API versioning strategy
- [ ] Redirect old docs (if applicable)
```

### #173: Provider Health Monitoring (Weeks 5-7)

```
Week 5 - Database & History
- [ ] Create health_checks table
- [ ] Create index on (provider, created_at)
- [ ] Implement persistence in health check job
- [ ] Add SLA calculation service
- [ ] Write tests for SLA logic

Week 6 - Dashboard & Alerts
- [ ] Create /api/admin/provider-health endpoint
- [ ] Build Slack notification integration
- [ ] Build SMS alert integration
- [ ] Implement alert deduping
- [ ] Write integration tests

Week 7 - Reporting
- [ ] Generate monthly uptime reports
- [ ] Create historical trend analysis
- [ ] Implement root cause analysis helpers
- [ ] Add performance degradation detection
- [ ] Write comprehensive documentation
```

### #174: KYC Document Verification (Weeks 8-11)

```
Week 8 - Webhooks & Retry
- [ ] Implement webhook signature verification
- [ ] Create webhook queue table
- [ ] Implement retry logic (exponential backoff)
- [ ] Create DLQ for permanent failures
- [ ] Write webhook handler tests

Week 9 - Manual Review Queue
- [ ] Create manual_review_queue table
- [ ] Build admin dashboard endpoint
- [ ] Implement approval/rejection workflow
- [ ] Create tier upgrade request system
- [ ] Add tier downgrade on rejection

Week 10 - Testing & Mocking
- [ ] Create mock KYC provider
- [ ] Write webhook test simulator
- [ ] Implement test fixture library
- [ ] Write edge case tests (20+ scenarios)
- [ ] Performance test document uploads

Week 11 - Documentation
- [ ] Write KYC integration guide
- [ ] Document webhook events
- [ ] Create troubleshooting guide
- [ ] Write compliance documentation
- [ ] Create operator runbook
```

---

## Code Architecture Recommendations

### #175: Transaction Filtering

```typescript
// New: QueryBuilder pattern for composable filters
class TransactionQueryBuilder {
  private filters: FilterClause[] = [];

  dateRange(start: Date, end: Date) {
    /* ... */
  }
  amountRange(min: number, max: number) {
    /* ... */
  }
  fullTextSearch(query: string) {
    /* ... */
  }
  status(...statuses: TransactionStatus[]) {
    /* ... */
  }
  sortBy(field: string, direction: "ASC" | "DESC") {
    /* ... */
  }
  build(): { sql: string; params: any[] } {
    /* ... */
  }
}
```

### #172: API Documentation

```typescript
// Extend existing generator
interface OpenAPIExtension {
  components: {
    schemas: Record<string, OpenAPISchema>;
    responses: Record<string, OpenAPIResponse>;
    securitySchemes: Record<string, SecurityScheme>;
  };
  webhooks: WebhookDefinition[];
  examples: ExamplePayload[];
}
```

### #173: Provider Health Monitoring

```typescript
interface ProviderHealthRecord {
  provider: ProviderName;
  timestamp: Date;
  status: "up" | "down";
  responseTime: number | null;
  errorReason?: string;
}

interface SLAReport {
  provider: ProviderName;
  period: DateRange;
  uptime: number; // 0-100
  totalIncidents: number;
  avgResponseTime: number;
}
```

### #174: KYC Document Verification

```typescript
interface KYCVerificationEvent {
  id: string;
  userId: string;
  workflowId: string;
  status: KYCStatus;
  timestamp: Date;
  metadata: {
    retryCount: number;
    lastError?: string;
    manualReview?: boolean;
  };
}
```

---

## Open Questions & Assumptions

### #172

- **Q**: Should docs include deprecated API versions?
- **A**: Yes, maintain 2 previous versions

### #173

- **Q**: SLA target per provider?
- **A**: Negotiated with each provider; default 99.5%

### #174

- **Q**: Support multiple KYC providers?
- **A**: Architecture allows it; implement Entrust first

### #175

- **Q**: Full-text search on ALL transaction fields?
- **A**: Start with notes and phone number; expand based on usage

---

## Next Steps

1. **Approve roadmap** with stakeholders
2. **Allocate team** based on skill matrix
3. **Create tickets** in GitHub Issues with detailed specifications
4. **Set up infrastructure** (databases, queues, monitoring)
5. **Begin Phase 1** (#175) with spikes in parallel tracking

---

**Prepared by:** AI Assistant  
**Review Status:** Pending stakeholder approval  
**Last Updated:** July 27, 2026
