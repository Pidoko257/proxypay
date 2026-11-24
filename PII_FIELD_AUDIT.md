# PII Field Encryption Audit

## Overview

This document audits PII field encryption across the codebase to ensure:
1. All PII fields in `PII_FIELDS` are actually encrypted before storage
2. Database column names match the PII field names
3. All call sites that handle PII use the encryption/decryption middleware

## PII Fields Definition

**Location**: `src/middleware/piiEncryption.ts`

```typescript
export const PII_FIELDS = ["name", "address", "id_number", "email", "phone_number"] as const;
```

### Field Coverage (GDPR/CCPA)

| Field | Type | Coverage | Tables |
|-------|------|----------|--------|
| `name` | Personal identifier | ✅ GDPR/CCPA | merchants, users |
| `address` | Location data | ✅ GDPR/CCPA | merchants |
| `id_number` | Government ID | ✅ GDPR/CCPA | (potential) |
| `email` | Contact/identifier | ✅ GDPR/CCPA | users, merchants |
| `phone_number` | Contact/identifier | ✅ GDPR/CCPA | users, merchants, transactions |

## Database Schema - PII Fields

### Users Table
- `phone_number` (VARCHAR/TEXT) - encrypted
- `email` (VARCHAR/TEXT) - encrypted, nullable
- Schema: `src/migrations/001_initial_schema.sql`, `003_add_2fa_support.sql`, `007_add_user_email.sql`

### Merchants Table
- `name` (VARCHAR 255) - should be encrypted
- `email` (VARCHAR 255) - encrypted, unique index
- `phone_number` (VARCHAR 20) - encrypted
- `address` (TEXT) - should be encrypted, nullable
- Schema: `src/migrations/20260601_create_merchants_table.sql`

### Transactions Table
- `phone_number` (VARCHAR/TEXT) - encrypted
- Schema: `src/migrations/001_initial_schema.sql`

## Call Site Audit

### Encryption/Decryption Usage

The following locations use the PII encryption middleware:

1. **Middleware** (`src/middleware/piiEncryption.ts`)
   - `encryptPiiFields(row)` - encrypts PII fields before INSERT/UPDATE
   - `decryptPiiFields(row)` - decrypts PII fields after SELECT
   - Per-user variants: `encryptPiiFieldsForUser()`, `decryptPiiFieldsForUser()`

2. **Tests** (`src/tests/encryption.test.ts`)
   - Comprehensive tests for encryption/decryption
   - Tests for both global-key and per-user-key variants

### Database Access Points

Identified call sites that handle PII fields:

1. **User Management**
   - `src/routes/twoFactorRoutes.ts`: SELECT phone_number FROM users
   - `src/routes/statements.ts`: SELECT phone_number FROM users
   - `src/auth/sso.ts`: INSERT phone_number into users
   - `src/auth/oidc.ts`: INSERT phone_number into users

2. **Merchant Management**
   - `src/models/merchant.ts`: 
     - `create()`: INSERT name, email, phone_number, address
     - `createMany()`: Batch INSERT with same fields
     - `findByEmail()`: SELECT * WHERE email
     - `update()`: UPDATE name, address, etc.

3. **Transaction Processing**
   - `src/routes/transactions.ts`: UPDATE phone_number

4. **Email Outbox**
   - `src/models/emailOutbox.ts`: Stores recipient_email (should consider encryption)

## Field Name Verification

### Mapping: Code → Database Columns

| Code Field | Database Column | Table | Status |
|------------|-----------------|-------|--------|
| `name` | `name` | merchants | ✅ Match |
| `email` | `email` | users, merchants | ✅ Match |
| `phoneNumber` (camelCase) | `phone_number` (snake_case) | users, merchants, transactions | ⚠️ **Case mismatch** |
| `address` | `address` | merchants | ✅ Match |

**⚠️ Note**: `phoneNumber` in TypeScript/camelCase vs `phone_number` in DB/snake_case. The middleware uses the database column name (`phone_number`).

## Data Migration Status

### Script: `src/scripts/encrypt-existing-data.ts`

Encrypts existing plaintext PII values:

- ✅ `transactions.phone_number`
- ✅ `transactions.stellar_address`
- ✅ `transactions.notes`
- ✅ `users.phone_number` (NEW)
- ✅ `users.email` (NEW)
- ✅ `merchants.phone_number` (NEW)
- ✅ `merchants.email` (NEW)

**Usage**: `npm run encrypt:existing-data` or `npx tsx src/scripts/encrypt-existing-data.ts`

### Schema Migration: `migrations/20261101_encrypt_email_phone_pii.sql`

Marks email and phone_number columns as PII for audit/documentation purposes.

## Recommendations

### Immediate Actions

1. ✅ **DONE**: Added `email` and `phone_number` to `PII_FIELDS`
2. ✅ **DONE**: Updated `encrypt-existing-data.ts` to handle users and merchants
3. ✅ **DONE**: Created schema migration with PII column comments

### Next Steps

1. **Review Merchant Fields**
   - `merchants.name` and `merchants.address` are not in `PII_FIELDS` but should be encrypted
   - Recommendation: Add `merchants.name` and `merchants.address` to PII_FIELDS in a follow-up

2. **Verify Call Sites**
   - Review `src/models/merchant.ts`: Ensure all merchant CRUD operations use encryption middleware
   - Review `src/routes/twoFactorRoutes.ts`: Ensure phone_number is decrypted when read
   - Review `src/models/emailOutbox.ts`: Consider encrypting `recipient_email`

3. **Deployment Checklist**
   - Backup database before running migration
   - Deploy code with updated `PII_FIELDS` first
   - Run data migration: `npm run encrypt:existing-data`
   - Verify no plaintext PII in database post-migration
   - Test all authentication flows (SSO, 2FA, merchant onboarding)

4. **Search Indexing**
   - Email is searchable (unique index on merchants.email)
   - After encryption, consider tokenization for search if needed
   - Use deterministic encryption or separate searchable token column

5. **Field Name Consistency**
   - Consider normalizing `phoneNumber` → `phone_number` throughout codebase
   - Or ensure consistent conversion in TypeScript models

## Compliance Notes

- **GDPR**: Phone and email are personal data; encryption at rest is required
- **CCPA**: Same classification; encryption with per-user keys provides better breach isolation
- **PCI DSS**: Not directly applicable (no payment card data), but alignment with security best practices

## References

- Encryption utilities: `src/utils/encryption.ts`
- PII middleware: `src/middleware/piiEncryption.ts`
- Data migration: `src/scripts/encrypt-existing-data.ts`
- Schema migrations: `migrations/008_encrypt_pii_fields.sql`, `migrations/20261101_encrypt_email_phone_pii.sql`
