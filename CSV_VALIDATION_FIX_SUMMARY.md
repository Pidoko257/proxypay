# CSV Validation Security Fix

## Issue

The CSV reconciliation endpoint (`POST /api/admin/reconcile`) was accepting CSV files without validating the header row schema before processing. This created two security/stability risks:

1. **Missing Schema Validation**: Invalid CSV structures were passed directly to `reconcileTransactions()` without validation
2. **Memory Exhaustion**: No limit on CSV row count allowed oversized uploads to consume excessive memory

## Solution

Added server-side content validation using Zod schema and row count limits:

### Changes Made

#### 1. **Added Zod Schema for CSV Headers** (`src/services/csvReconciliation.ts`)

```typescript
export const CSVHeaderSchema = z
  .object({
    reference_number: z.string().optional(),
    reference_id: z.string().optional(),
    provider_reference: z.string().optional(),
    amount: z.string(),
    status: z.string(),
    phone_number: z.string(),
    provider: z.string(),
  })
  .strict()
  .refine(
    (obj) => obj.reference_number || obj.reference_id || obj.provider_reference,
    { message: "At least one reference field required" },
  );
```

#### 2. **Row Count Limit**

```typescript
const MAX_CSV_ROWS = 50000;
```

Prevents memory exhaustion from oversized uploads. Enforced during CSV parsing.

#### 3. **Enhanced parseCSV Function**

The function now:

- Validates the header row on first data event
- Checks that all required columns exist in the CSV
- Validates that at least one reference field is present
- Enforces the 50,000 row limit
- Rejects the upload immediately if validation fails

#### 4. **Error Handling**

Validation errors are caught in the admin route's error handler and returned with appropriate HTTP error codes.

### Validation Rules

**Required Fields:**

- `amount` (required)
- `status` (required)
- `phone_number` (required)
- `provider` (required)

**Reference Fields (at least one required):**

- `reference_number`
- `reference_id`
- `provider_reference`

**Row Limit:**

- Maximum 50,000 rows per CSV file

### Error Responses

If CSV validation fails, the endpoint returns:

```json
{
  "code": "INVALID_INPUT",
  "message": "Reconciliation failed",
  "details": {
    "error": "Reconciliation failed",
    "message": "Missing required CSV column: amount"
  }
}
```

Possible error messages:

- `"Missing required CSV column: {column}"`
- `"CSV must contain at least one reference field: reference_number, reference_id, or provider_reference"`
- `"CSV file exceeds maximum allowed rows (50000)"`

## Testing Checklist

- [ ] Valid CSV with all required fields processes successfully
- [ ] CSV missing required column is rejected before reconciliation
- [ ] CSV missing all reference fields is rejected
- [ ] CSV with 50,000 rows processes successfully
- [ ] CSV with 50,001 rows is rejected
- [ ] Error messages are clear and actionable

## Implementation Details

### How It Works

1. **On CSV upload**, the `parseCSV()` function streams the CSV data
2. **On first row**, headers are validated against required fields
3. **Per row**, the row count is checked against the limit
4. **If validation fails**, stream is destroyed and error is rejected
5. **Error handler** in the admin route catches the error and returns it to the client

### Key Design Decisions

- **Stream processing**: Uses Node.js streams to process CSV data efficiently without loading entire file into memory upfront
- **Header validation on first row**: Fails fast without wasting time parsing invalid files
- **Zod integration**: Leverages existing Zod dependency for schema validation consistency
- **50,000 row limit**: Balances between supporting large reconciliations and preventing resource exhaustion

## Backwards Compatibility

✅ **Fully backwards compatible** - valid existing CSV files will continue to work without modification.

## Dependencies

- `zod` (already installed: ^4.3.6)
- `csv-parser` (already installed)
- Node.js `stream` module

No new external dependencies required.
