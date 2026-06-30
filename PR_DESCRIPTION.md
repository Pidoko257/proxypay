# Bulk Transaction Status Query API

## Summary

Adds a `POST /api/v1/transactions/status-batch` endpoint that accepts up to 100 transaction IDs and returns their statuses in a single response, using a single SQL `WHERE id = ANY(...)` query for optimal performance.

## Acceptance Criteria

- ✅ Endpoint accepts an array of up to 100 transaction IDs in the request body
- ✅ Single SQL query fetches all requested transactions using `WHERE id = ANY(...)`
- ✅ Response is a map of `{ transactionId: status }` for quick lookup
- ✅ Transaction IDs not belonging to the requesting org return `null` in the map (not an error)

## Implementation

### Model (`src/models/transaction.ts`)
- Added `findByIds(ids, userId?)` — single query with `WHERE id = ANY($1)`, scoped to `userId` when provided, returns `{ id, status }[]`

### Controller (`src/controllers/transactionController.ts`)
- Added `statusBatchHandler` — validates request body with Zod (`array(uuid).min(1).max(100)`), queries via model, builds `{ [id]: status | null }` response map
- IDs not found or not owned by the requesting user return `null` (not an error)

### Route (`src/routes/v1/transactions.ts`)
- `POST /status-batch` — requires auth, quick timeout, v1 API version

### OpenAPI
- Registered `StatusBatchRequest` and `StatusBatchResponse` schemas
- Registered the `POST /api/v1/transactions/status-batch` path with full documentation

closes #112
