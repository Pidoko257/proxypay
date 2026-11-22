# Critical Security and Financial Precision Fixes

This document details four critical issues fixed in the ProxyPay withdrawal system to prevent race conditions, ensure financial accuracy, and improve audit logging.

## Overview of Issues

| Issue                      | File                                     | Severity | Impact                                |
| -------------------------- | ---------------------------------------- | -------- | ------------------------------------- |
| Race Condition in Withdraw | `transactionService.ts`                  | CRITICAL | Double-spend, negative balance        |
| Fee Configuration Race     | `transactionService.ts`                  | CRITICAL | Incorrect fee deduction, revenue loss |
| Missing Audit Logging      | `admin.ts`                               | HIGH     | Non-compliant logging, audit failure  |
| Floating-Point Precision   | `transactionService.ts`, `feeService.ts` | CRITICAL | Financial data corruption             |

---

## Issue 1: Race Condition in Withdrawal Method

### Problem

The `withdraw()` method read the balance at line 38 with `SELECT id, balance FROM users` but did not acquire an exclusive lock. Between the read and the write (UPDATE at line 56), another concurrent request could have withdrawn the same balance, causing:

- Double-spend vulnerability
- Negative balances
- Account inconsistencies

**Root Cause**: No `SELECT ... FOR UPDATE` lock was acquired before reading the balance.

### Solution

✅ **Status**: FIXED

Move all money-handling logic inside a PostgreSQL transaction and use `SELECT ... FOR UPDATE` to acquire an exclusive row lock:

```typescript
await client.query("BEGIN");

// Lock user row - no other transaction can modify this row until COMMIT/ROLLBACK
const user = await client.query(
  `SELECT id, balance FROM users WHERE id = $1 FOR UPDATE`,
  [payload.userId],
);

if (user.rows.length === 0) {
  throw new Error("User not found");
}

// ... balance checks ...

// Deduct from user balance atomically
const updateResult = await client.query(
  `UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance`,
  [totalDeduction, payload.userId],
);

await client.query("COMMIT");
```

### How It Works

1. `BEGIN` starts a PostgreSQL transaction
2. `SELECT ... FOR UPDATE` acquires an **exclusive row lock** on the user record
3. The lock is held until `COMMIT` or `ROLLBACK`
4. No other transaction can read (with `FOR UPDATE`), update, or delete this row during the lock
5. When the second concurrent request tries to run the same query, it **blocks** until the first transaction commits
6. The second request then reads the updated balance (after first deduction)
7. Both transactions complete successfully with correct balances

### Example: Concurrent Withdrawals

```
Time  | Thread 1                           | Thread 2
------+------------------------------------+------------------------------------
T0    | BEGIN                              |
T1    | SELECT ... FOR UPDATE (LOCK)       |
T2    | Checks balance: 1000               |
T3    | Deducts 105 (amount + fee)         |
T4    | Balance = 895                      |
T5    | COMMIT (releases lock)             |
T6    |                                    | BEGIN
T7    |                                    | SELECT ... FOR UPDATE (LOCK - now available)
T8    |                                    | Checks balance: 895 ✓
T9    |                                    | Deducts 105
T10   |                                    | Balance = 790 ✓
T11   |                                    | COMMIT
```

---

## Issue 2: Fee Configuration Race Condition

### Problem

Fee configuration was queried and fees were calculated **outside** the transaction lock (line 29):

```typescript
// BEFORE (BROKEN):
const fee = await this.calculateWithdrawalFee(amount, currency); // ← Outside transaction
const totalDeduction = amount + fee;

const client = await pool.connect();
await client.query("BEGIN");
// ...
```

If fee configuration changed between the fee calculation and the balance update, the deducted amount would not match what was shown to the user.

**Root Cause**: Fee lookup was not inside the transaction and not locked with `FOR UPDATE`.

### Solution

✅ **Status**: FIXED

Move fee lookup and calculation **inside** the transaction with `SELECT ... FOR UPDATE` lock:

```typescript
await client.query("BEGIN");

// Lock user row
const user = await client.query(
  `SELECT id, balance FROM users WHERE id = $1 FOR UPDATE`,
  [payload.userId],
);

// Lock fee configuration and fetch inside transaction
const feeResult = await this.calculateWithdrawalFeeWithLock(
  client,
  new Decimal(payload.amount),
  payload.currency,
);

const fee = feeResult.fee;
const totalDeduction = feeResult.totalDeduction;

// Now both user balance AND fee configuration are locked
await client.query("COMMIT");
```

The fee lookup now uses:

```typescript
private async calculateWithdrawalFeeWithLock(
  client: any,
  amount: Decimal,
  currency: string,
): Promise<{ fee: Decimal; totalDeduction: Decimal }> {
  // Lock fee configuration row
  const result = await client.query(
    `SELECT fee_fixed, fee_percent FROM fee_configurations
     WHERE type = 'withdrawal' AND (currency = $1 OR currency = 'ALL')
     ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
    [currency],
  );

  // ... rest of fee calculation ...
}
```

### Benefits

- Fee configuration is locked for the duration of the transaction
- No concurrent admin can change fees while withdrawal is processing
- Deducted amount matches the calculated fee
- Audit trail shows exact fee used

---

## Issue 3: Admin Action Logging Not Captured by SIEM

### Problem

Admin action logs were written using `console.log`:

```typescript
// BEFORE (BROKEN):
console.log(`[ADMIN ACTION] ${action}`, { ... });
```

**Problems**:

- `console.log` output is printed to stdout but not captured by pino logger
- Logs are not sent to Loki/SIEM pipeline
- Logs are not queryable or auditable
- Regulatory compliance failure (non-repudiation requirement)

### Solution

✅ **Status**: FIXED

All admin actions now use the structured pino logger:

```typescript
// AFTER (FIXED):
logger.info(
  {
    adminId: (req as AuthRequest).user?.id,
    method: req.method,
    path: req.originalUrl,
    body: req.body,
    timestamp: new Date().toISOString(),
  },
  "[ADMIN ACTION]",
);
```

Error logging:

```typescript
logger.error(
  { error, userId: payload.userId, amount: payload.amount },
  "Withdrawal failed",
);
```

### Logger Configuration

The pino logger in `/workspaces/proxypay/src/utils/logger.ts`:

- Writes to stdout (always enabled)
- Sends to Loki via pino-loki transport (when LOKI_HOST is set)
- Redacts sensitive fields (passwords, tokens, keys)
- Includes structured metadata (service, instance_id, trace_id)
- Supports custom log levels (security, audit)

### Benefits

- ✓ Logs flow to SIEM (Loki/Grafana)
- ✓ Logs are queryable by action, actor, timestamp
- ✓ Logs are audit-trail compatible
- ✓ Regulatory compliance (audit logs retention)
- ✓ Automatic redaction of sensitive fields

---

## Issue 4: Floating-Point Precision in Financial Calculations

### Problem

Money handling used JavaScript's `parseFloat()` and floating-point arithmetic:

```typescript
// BEFORE (BROKEN):
const currentBalance = parseFloat(user.rows[0].balance || "0");
const fee = parseFloat(config.fee_fixed || "0");
const percentFee = amount * parseFloat(config.fee_percent || "0.01");

// This causes precision loss:
// 0.1 + 0.2 === 0.30000000000000004 (not 0.3!)
// Math.max(0.5, amount * 0.01) can lose precision
// parseFloat(fee.toFixed(2)) is not safe
```

**Root Cause**: JavaScript's `Number` type is a 64-bit IEEE 754 floating-point, unsuitable for financial calculations.

### Solution

✅ **Status**: FIXED

Added `decimal.js` dependency and use `Decimal` for all monetary calculations:

```typescript
import Decimal from "decimal.js";

// AFTER (FIXED):
const currentBalance = new Decimal(user.rows[0].balance || "0");
const amount = new Decimal(payload.amount);

// Percentage calculation with precision
const fixedFee = new Decimal(config.fee_fixed || "0");
const percentFee = amount.times(new Decimal(config.fee_percent || "0.01"));

// Comparison with precision
if (currentBalance.lessThan(totalDeduction)) {
  throw new Error("Insufficient balance");
}

// Round to cents (2 decimal places)
fee = fee.toDecimalPlaces(2);

// Return as number only after all calculations complete
return fee.toNumber();
```

### Math Examples - Why This Matters

#### Example 1: 0.1 + 0.2 = 0.3?

```javascript
// JavaScript (broken):
0.1 + 0.2 === 0.3; // false! Result is 0.30000000000000004
0.1 + 0.2 === 0.30000000000000004; // true

// Decimal.js (fixed):
new Decimal("0.1").plus("0.2").equals("0.3"); // true
```

#### Example 2: Fee Calculation Precision

```javascript
// JavaScript (broken):
const amount = 100.5;
const feePercent = 2.5;
const fee = amount * (feePercent / 100); // 2.512500000000001
parseFloat(fee.toFixed(2)); // 2.51 (but only by accident)

// Decimal.js (fixed):
const amount = new Decimal("100.5");
const fee = amount.times(new Decimal("2.5").dividedBy(100)); // 2.5125
const rounded = fee.toDecimalPlaces(2); // 2.51 (precise)
```

#### Example 3: Balance Comparison Error

```javascript
// JavaScript (broken):
const balance = 1000.1;
const deduction = 500.05 + 500.05; // 1000.1000000000001
if (balance >= deduction) {
  // false! Should be true!
  // Insufficient balance error (incorrect!)
}

// Decimal.js (fixed):
const balance = new Decimal("1000.1");
const deduction = new Decimal("500.05").plus("500.05"); // 1000.1
if (balance.greaterThanOrEqualTo(deduction)) {
  // true!
  // Sufficient balance (correct!)
}
```

### Changes Made

#### `transactionService.ts`

- Added `import Decimal from "decimal.js"`
- Moved fee calculation inside transaction
- All balance calculations use Decimal
- Final return values converted to Number only

#### `feeService.ts`

- Added `import Decimal from "decimal.js"`
- `calculateFee()` method uses Decimal throughout
- All comparisons use Decimal methods (`.lessThan()`, `.greaterThan()`)
- Results rounded to 2 decimal places (cents) using `.toDecimalPlaces(2)`

### Installation

```bash
npm install decimal.js
npm install --save-dev @types/decimal.js  # Optional TypeScript types
```

### Benefits

- ✓ Precise monetary calculations
- ✓ Consistent rounding (always to cents)
- ✓ No accumulation of floating-point errors
- ✓ Audit trail shows exact amounts
- ✓ Regulatory compliance (financial accuracy)

---

## Combined Effect: Complete Security Fix

All four issues are fixed together in the `withdraw()` method:

```typescript
async withdraw(payload: { userId: string; amount: number; ... }) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");  // Start transaction

    // ISSUE 1 FIX: Lock user row
    const user = await client.query(
      `SELECT id, balance FROM users WHERE id = $1 FOR UPDATE`,
      [payload.userId],
    );

    // ISSUE 4 FIX: Use Decimal for precision
    const currentBalance = new Decimal(user.rows[0].balance || "0");

    // ISSUE 2 FIX: Lock fee config inside transaction
    const feeResult = await this.calculateWithdrawalFeeWithLock(
      client,
      new Decimal(payload.amount),
      payload.currency,
    );

    // ... balance checks with Decimal precision ...

    // UPDATE and COMMIT
    await client.query("COMMIT");

    return { success: true, ... };
  } catch (error) {
    await client.query("ROLLBACK");

    // ISSUE 3 FIX: Structured logging for SIEM
    logger.error(
      { error, userId: payload.userId, amount: payload.amount },
      "Withdrawal failed",
    );

    throw error;
  } finally {
    client.release();
  }
}
```

---

## Testing Recommendations

### Unit Tests

- Test Decimal precision with edge cases (0.1 + 0.2, etc.)
- Test fee rounding to cents
- Test balance comparisons

### Integration Tests

- Test concurrent withdrawals from same account
- Test fee configuration changes during withdrawal
- Test rollback on insufficient balance

### Load Tests

- Stress test with high concurrency
- Monitor for double-spend or negative balances
- Verify all withdrawals are logged

### Audit Tests

- Verify all admin actions appear in SIEM logs
- Verify log structure is correct for queries
- Verify sensitive fields are redacted

---

## Deployment Notes

1. **Database**: No schema changes required. `SELECT ... FOR UPDATE` is standard SQL.
2. **Dependencies**: Added `decimal.js` to `package.json`
3. **Backward Compatibility**: No breaking changes to API
4. **Logging**: Ensure LOKI_HOST is set for SIEM integration

---

## Verification Checklist

- [ ] `npm install decimal.js` succeeds
- [ ] Code compiles without errors
- [ ] All transaction tests pass
- [ ] Concurrent withdrawal tests pass
- [ ] Admin logs appear in SIEM
- [ ] Decimal precision tests pass
- [ ] No console.log in production code
- [ ] Fee configuration is locked in transaction

---

## References

- [PostgreSQL SELECT FOR UPDATE](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)
- [Decimal.js Documentation](https://mikemcl.github.io/decimal.js/)
- [IEEE 754 Floating Point](https://en.wikipedia.org/wiki/Double-precision_floating-point_format)
- [PII Logger Configuration](./src/utils/logger.ts)
