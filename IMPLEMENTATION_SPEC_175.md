# #175 Implementation Spec: Transaction Filtering & Search

**Priority**: 🔴 HIGH (Start First)  
**Effort**: 2-3 weeks  
**Team**: 1-2 developers  
**Blockers**: None

---

## Overview

Implement advanced filtering and search for transaction queries with performance optimization. This is the quick win that unblocks other features and provides immediate user value.

**Current State**: 60% complete (basic status/pagination filtering)  
**Target**: 100% with date range, amount range, full-text search, presets, and <500ms p95 latency

---

## Scope & Acceptance Criteria

### ✅ Completed (Maintain)

- [x] Status filtering (multiple statuses via comma-separated list)
- [x] Offset/limit pagination (max 1000 items)
- [x] Tag filtering
- [x] Metadata search
- [x] Note-based search (basic substring)
- [x] Reference number search

### ⏳ To Implement

- [ ] Date range filtering (startDate/endDate query params)
- [ ] Amount range filtering (minAmount/maxAmount)
- [ ] Full-text search on transaction notes (PostgreSQL FTS)
- [ ] Multi-column sorting (sortBy/sortOrder)
- [ ] Cursor-based keyset pagination
- [ ] Filtering presets (last7days, lastMonth, failed, pending, review)
- [ ] Saved filters (user-defined, persistent)
- [ ] Query performance optimization (<500ms p95)
- [ ] Comprehensive documentation with examples
- [ ] 50+ test cases

---

## API Changes

### New Query Parameters

```
GET /api/v1/transactions

NEW PARAMETERS:
  ?startDate=2026-07-01T00:00:00Z&endDate=2026-07-31T23:59:59Z
  ?minAmount=100&maxAmount=10000
  ?sortBy=amount,createdAt&sortOrder=DESC,ASC
  ?cursor=abc123def456   # Keyset pagination
  ?preset=last7days|lastMonth|failed|pending|review
  ?search=query         # Full-text search on notes
  ?limit=50&offset=0    # Existing: offset pagination

UNCHANGED:
  ?status=completed,failed    # Still works
  ?reference=REF-123          # Still works
  ?tags=urgent,manual         # Still works
```

### Response Schema

```json
{
  "data": [
    {
      "id": "txn_123",
      "referenceNumber": "REF-20260727-001",
      "type": "deposit",
      "amount": "5000",
      "phoneNumber": "+237612345678",
      "provider": "mtn",
      "status": "completed",
      "createdAt": "2026-07-27T10:30:00Z",
      "updatedAt": "2026-07-27T10:35:00Z"
    }
  ],
  "pagination": {
    "total": 1234,
    "limit": 50,
    "offset": 0,
    "hasMore": true,
    "cursor": "eyJpZCI6InR4bl9hYmMiLCJjcmVhdGVkQXQiOiIyMDI2LTA3LTI3VDA5OjMwOjAwWiJ9"
  },
  "filters": {
    "applied": {
      "status": ["completed", "failed"],
      "startDate": "2026-07-01T00:00:00Z",
      "endDate": "2026-07-31T23:59:59Z"
    }
  }
}
```

---

## Database Changes

### Required Index

```sql
-- Full-text search index on notes
CREATE INDEX CONCURRENTLY idx_transactions_notes_fts
  ON transactions USING GIN(to_tsvector('english', notes));

-- Multi-column index for common filters
CREATE INDEX CONCURRENTLY idx_transactions_user_date_amount
  ON transactions(user_id, created_at DESC, amount)
  WHERE status NOT IN ('cancelled', 'failed');

-- Amount range queries
CREATE INDEX CONCURRENTLY idx_transactions_amount
  ON transactions(amount)
  WHERE status = 'completed';
```

### Migration SQL

```sql
-- 1. Add FTS column if not exists
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS
  notes_ts tsvector GENERATED ALWAYS AS
  (to_tsvector('english', COALESCE(notes, ''))) STORED;

-- 2. Create indexes (executed above)

-- 3. Create saved_filters table
CREATE TABLE IF NOT EXISTS saved_transaction_filters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name varchar(255) NOT NULL,
  description text,
  filters jsonb NOT NULL,
  is_default boolean DEFAULT false,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now(),
  UNIQUE(user_id, name)
);

CREATE INDEX idx_saved_filters_user_id ON saved_transaction_filters(user_id);
```

---

## Implementation Plan

### Week 1: Core Filtering

#### Task 1.1: Update Query Builder

**File**: `src/models/transaction.ts`

```typescript
interface TransactionFilters {
  // Existing
  statuses?: TransactionStatus[];
  tags?: string[];
  metadata?: Record<string, unknown>;
  referenceNumber?: string;

  // NEW
  startDate?: Date;
  endDate?: Date;
  minAmount?: number;
  maxAmount?: number;
  searchQuery?: string;
}

class TransactionQueryBuilder {
  private filters: Partial<TransactionFilters> = {};

  dateRange(start: Date, end: Date): this {
    this.filters.startDate = start;
    this.filters.endDate = end;
    return this;
  }

  amountRange(min: number, max: number): this {
    this.filters.minAmount = min;
    this.filters.maxAmount = max;
    return this;
  }

  fullTextSearch(query: string): this {
    this.filters.searchQuery = query;
    return this;
  }

  build(): { sql: string; params: any[] } {
    const where: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (this.filters.startDate) {
      where.push(`created_at >= $${paramIndex++}`);
      params.push(this.filters.startDate);
    }
    if (this.filters.endDate) {
      where.push(`created_at <= $${paramIndex++}`);
      params.push(this.filters.endDate);
    }
    if (this.filters.minAmount) {
      where.push(`amount::numeric >= $${paramIndex++}`);
      params.push(this.filters.minAmount);
    }
    if (this.filters.maxAmount) {
      where.push(`amount::numeric <= $${paramIndex++}`);
      params.push(this.filters.maxAmount);
    }
    if (this.filters.searchQuery) {
      where.push(`notes_ts @@ plainto_tsquery('english', $${paramIndex++})`);
      params.push(this.filters.searchQuery);
    }

    return { sql: where.join(" AND "), params };
  }
}
```

#### Task 1.2: Update Filter Middleware

**File**: `src/utils/transactionFilters.ts`

```typescript
export interface TransactionFilters {
  // ... existing
  startDate?: string;
  endDate?: string;
  minAmount?: number;
  maxAmount?: number;
  search?: string;
}

export const validateTransactionFilters = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const {
      status,
      limit = 50,
      offset = 0,
      startDate,
      endDate,
      minAmount,
      maxAmount,
      search,
    } = req.query;

    // Validate dates (ISO-8601)
    if (startDate && isNaN(Date.parse(startDate as string))) {
      return res.status(400).json({
        error: "Invalid startDate",
        message: "Use ISO-8601 format (2026-07-27T00:00:00Z)",
      });
    }

    // Validate amounts (positive integers)
    const minAmountNum = minAmount
      ? parseInt(minAmount as string, 10)
      : undefined;
    if (minAmount && (isNaN(minAmountNum!) || minAmountNum! < 0)) {
      return res.status(400).json({
        error: "Invalid minAmount",
        message: "minAmount must be a positive number",
      });
    }

    // Attach filters
    (req as any).transactionFilters = {
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
      minAmount: minAmountNum,
      maxAmount: maxAmount ? parseInt(maxAmount as string, 10) : undefined,
      search: search as string | undefined,
      // ... existing filters
    };

    next();
  } catch (error) {
    res.status(500).json({
      error: "Error validating filters",
      message: (error as Error).message,
    });
  }
};
```

#### Task 1.3: Write Tests (30+ cases)

**File**: `tests/utils/transactionFilters.test.ts`

```typescript
describe("TransactionFilters", () => {
  describe("Date Range Filtering", () => {
    it("should filter by date range", async () => {
      // Setup: Insert transactions on different dates
      // Execute: Query with startDate and endDate
      // Verify: Only transactions in range returned
    });

    it("should reject invalid ISO-8601 dates", () => {
      // Verify: 400 response
    });
  });

  describe("Amount Range Filtering", () => {
    it("should filter by amount range", async () => {
      // Setup: Insert transactions with different amounts
      // Execute: Query with minAmount/maxAmount
      // Verify: Only transactions in range returned
    });

    it("should handle zero minAmount", () => {
      // Edge case: minAmount = 0
    });
  });

  describe("Full-Text Search", () => {
    it("should search notes via full-text", async () => {
      // Setup: Create transactions with notes
      // Execute: Query with search="keyword"
      // Verify: Matching transactions returned
    });

    it("should be case-insensitive", () => {
      // Verify: "Payment" matches "PAYMENT"
    });
  });
});
```

### Week 2: Advanced Features

#### Task 2.1: Multi-Column Sorting

**File**: `src/models/transaction.ts`

```typescript
interface SortOptions {
  field: "amount" | "createdAt" | "updatedAt" | "status";
  direction: "ASC" | "DESC";
}

function buildSortClause(sorts: SortOptions[]): string {
  return sorts
    .map((s) => `${fieldToColumn(s.field)} ${s.direction}`)
    .join(", ");
}

// Usage:
// ?sortBy=createdAt,amount&sortOrder=DESC,ASC
```

#### Task 2.2: Keyset Pagination (Cursor)

**File**: `src/models/transaction.ts`

```typescript
function encodeCursor(row: { id: string; createdAt: Date }): string {
  return Buffer.from(
    JSON.stringify({ id: row.id, createdAt: row.createdAt.toISOString() }),
  ).toString("base64");
}

function decodeCursor(cursor: string): { id: string; createdAt: Date } {
  const decoded = Buffer.from(cursor, "base64").toString("utf-8");
  const parsed = JSON.parse(decoded);
  return { id: parsed.id, createdAt: new Date(parsed.createdAt) };
}

// In query builder:
if (cursorAfter) {
  const { createdAt, id } = decodeCursor(cursorAfter);
  where.push(`(created_at, id) > ($1, $2)`);
  params.push(createdAt, id);
}
```

#### Task 2.3: Saved Filters

**File**: `src/routes/v1/transactions.ts` (new endpoint)

```typescript
// POST /api/v1/transactions/filters
router.post("/filters", authenticateToken, async (req, res) => {
  const { name, description, filters } = req.body;

  const result = await queryWrite(
    `INSERT INTO saved_transaction_filters 
     (user_id, name, description, filters) 
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [req.user.id, name, description, JSON.stringify(filters)],
  );

  res.json(result.rows[0]);
});

// GET /api/v1/transactions/filters
router.get("/filters", authenticateToken, async (req, res) => {
  const result = await queryRead(
    `SELECT * FROM saved_transaction_filters 
     WHERE user_id = $1 
     ORDER BY created_at DESC`,
    [req.user.id],
  );

  res.json(result.rows);
});

// GET /api/v1/transactions/filters/:filterId
router.get("/filters/:filterId", authenticateToken, async (req, res) => {
  const result = await queryRead(
    `SELECT * FROM saved_transaction_filters 
     WHERE id = $1 AND user_id = $2`,
    [req.params.filterId, req.user.id],
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: "Filter not found" });
  }

  // Apply saved filter to list query
  const filters = result.rows[0].filters;
  // ... redirect to list with filters
});
```

#### Task 2.4: Presets

**File**: `src/utils/transactionFilters.ts`

```typescript
interface FilterPreset {
  name: "last7days" | "lastMonth" | "failed" | "pending" | "review";
  filters: Partial<TransactionFilters>;
}

const PRESETS: Record<string, FilterPreset["filters"]> = {
  last7days: {
    startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
  },
  lastMonth: {
    startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  },
  failed: {
    statuses: [TransactionStatus.Failed, TransactionStatus.Cancelled],
  },
  pending: {
    statuses: [TransactionStatus.Pending, TransactionStatus.Review],
  },
  review: {
    statuses: [TransactionStatus.Review, TransactionStatus.Dispute],
  },
};

export function applyPreset(preset: string): Partial<TransactionFilters> {
  return PRESETS[preset] || {};
}
```

### Week 3: Polish & Performance

#### Task 3.1: Performance Testing

**File**: `benchmarks/transaction-filtering.js`

```javascript
import http from "k6/http";
import { check } from "k6";

export let options = {
  vus: 50,
  duration: "5m",
  thresholds: {
    http_req_duration: ["p(95)<500", "p(99)<1000"],
    http_req_failed: ["rate<0.1"],
  },
};

export default function () {
  // Scenario 1: Date range + sorting
  let res1 = http.get(
    "http://localhost:3000/api/v1/transactions" +
      "?startDate=2026-07-01T00:00:00Z" +
      "&endDate=2026-07-31T23:59:59Z" +
      "&sortBy=amount&sortOrder=DESC" +
      "&limit=50",
  );

  check(res1, {
    "status is 200": (r) => r.status === 200,
    "response time < 500ms": (r) => r.timings.duration < 500,
  });

  // Scenario 2: Full-text search
  let res2 = http.get(
    "http://localhost:3000/api/v1/transactions" + "?search=refund&limit=100",
  );

  check(res2, {
    "full-text search works": (r) => r.status === 200,
    "response time < 500ms": (r) => r.timings.duration < 500,
  });
}
```

#### Task 3.2: Query Optimization

Run EXPLAIN ANALYZE:

```sql
-- Check query plans for common filter combinations
EXPLAIN ANALYZE
SELECT * FROM transactions
WHERE user_id = $1
  AND created_at >= $2
  AND created_at <= $3
  AND amount::numeric >= $4
  AND amount::numeric <= $5
ORDER BY created_at DESC
LIMIT 50;

-- Verify index usage
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM transactions
WHERE notes_ts @@ plainto_tsquery('english', 'payment')
LIMIT 50;
```

#### Task 3.3: Integration Tests

**File**: `tests/routes/transactions.filtering.test.ts`

```typescript
describe("Transaction Filtering API", () => {
  it("should filter by date range", async () => {
    const res = await request(app).get("/api/v1/transactions").query({
      startDate: "2026-07-01T00:00:00Z",
      endDate: "2026-07-31T23:59:59Z",
    });

    expect(res.status).toBe(200);
    expect(
      res.body.data.every(
        (t) => new Date(t.createdAt) >= new Date("2026-07-01"),
      ),
    ).toBe(true);
  });

  it("should combine multiple filters", async () => {
    const res = await request(app).get("/api/v1/transactions").query({
      startDate: "2026-07-01T00:00:00Z",
      minAmount: 1000,
      maxAmount: 50000,
      status: "completed,review",
    });

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it("should support keyset pagination", async () => {
    // Get first page
    let res1 = await request(app)
      .get("/api/v1/transactions")
      .query({ limit: 10 });

    expect(res1.body.pagination.cursor).toBeDefined();

    // Get next page using cursor
    let res2 = await request(app)
      .get("/api/v1/transactions")
      .query({ cursor: res1.body.pagination.cursor, limit: 10 });

    // Verify no overlap
    const ids1 = res1.body.data.map((t) => t.id);
    const ids2 = res2.body.data.map((t) => t.id);
    expect(ids1.every((id) => !ids2.includes(id))).toBe(true);
  });
});
```

#### Task 3.4: Documentation

**File**: `docs/TRANSACTION_FILTERING.md` (new)

```markdown
# Transaction Filtering & Search API

## Quick Examples

### Filter by Date Range

\`\`\`bash
curl https://api.proxypay.io/api/v1/transactions \
 -H "Authorization: Bearer $TOKEN" \
 -G \
 --data-urlencode 'startDate=2026-07-01T00:00:00Z' \
 --data-urlencode 'endDate=2026-07-31T23:59:59Z'
\`\`\`

### Filter by Amount Range

\`\`\`bash
curl https://api.proxypay.io/api/v1/transactions \
 -H "Authorization: Bearer $TOKEN" \
 -G \
 --data-urlencode 'minAmount=1000' \
 --data-urlencode 'maxAmount=50000'
\`\`\`

### Full-Text Search

\`\`\`bash
curl https://api.proxypay.io/api/v1/transactions \
 -H "Authorization: Bearer $TOKEN" \
 -G \
 --data-urlencode 'search=refund'
\`\`\`

### Multi-Column Sorting

\`\`\`bash
curl https://api.proxypay.io/api/v1/transactions \
 -H "Authorization: Bearer $TOKEN" \
 -G \
 --data-urlencode 'sortBy=createdAt,amount' \
 --data-urlencode 'sortOrder=DESC,ASC'
\`\`\`

### Cursor-Based Pagination

\`\`\`bash

# First page

curl https://api.proxypay.io/api/v1/transactions \
 -H "Authorization: Bearer $TOKEN" \
 -G --data-urlencode 'limit=50'

# Next page (using cursor from response)

curl https://api.proxypay.io/api/v1/transactions \
 -H "Authorization: Bearer $TOKEN" \
 -G \
 --data-urlencode 'cursor=eyJpZCI6InR4bl9hYmMiLCJjcmVhdGVkQXQiOiIyMDI2LTA3LTI3VDA5OjMwOjAwWiJ9' \
 --data-urlencode 'limit=50'
\`\`\`

### Use Presets

\`\`\`bash

# Last 7 days

curl https://api.proxypay.io/api/v1/transactions?preset=last7days

# Failed transactions

curl https://api.proxypay.io/api/v1/transactions?preset=failed

# Pending review

curl https://api.proxypay.io/api/v1/transactions?preset=review
\`\`\`

## Reference

See `/docs` endpoint or [API Reference](./API_REFERENCE.md)
```

---

## Testing Checklist

```
✓ Unit Tests (30+ cases)
  ✓ Date range validation (invalid dates, timezone handling)
  ✓ Amount range validation (negative, decimals, edge cases)
  ✓ Full-text search (case sensitivity, special chars)
  ✓ Sorting (multiple columns, both directions)
  ✓ Pagination (cursor encoding/decoding, overlaps)

✓ Integration Tests (15+ scenarios)
  ✓ Combined filters (date + amount + search)
  ✓ Performance with large result sets
  ✓ Read replica routing
  ✓ Cache invalidation
  ✓ Concurrent requests

✓ Load Tests (k6)
  ✓ p95 < 500ms (50 concurrent users)
  ✓ p99 < 1000ms
  ✓ Error rate < 0.1%

✓ Documentation
  ✓ API examples (cURL, JS, Python, Go)
  ✓ Query parameter reference
  ✓ Response schema examples
  ✓ Common workflows
```

---

## Success Criteria

- [x] All filters working (date, amount, search, sorting)
- [x] p95 query latency < 500ms
- [x] Error rate < 0.1% under load
- [x] 50+ passing tests
- [x] API documented with examples
- [x] Zero breaking changes (backward compatible)

---

## Deployment Checklist

- [ ] Create database migration
- [ ] Create/verify indexes
- [ ] Deploy to staging
- [ ] Run full test suite
- [ ] Performance testing (k6)
- [ ] Deploy to production
- [ ] Monitor metrics
- [ ] Announce to users (blog post / release notes)

---

**Estimated Completion**: 3 weeks from start  
**Current Status**: Ready to start  
**Owner**: [Assign Developer]
