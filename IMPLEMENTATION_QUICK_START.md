# Quick Start: Email & Phone Number PII Encryption

## What Changed

Email addresses and phone numbers are now encrypted in the database, just like name, address, and ID number.

**Before**: Email and phone in plaintext → GDPR/CCPA violation  
**After**: Email and phone encrypted at rest → Compliant

## Files Modified

1. **`src/middleware/piiEncryption.ts`** (1 line changed)
   - `PII_FIELDS` now includes `"email"` and `"phone_number"`

2. **`src/scripts/encrypt-existing-data.ts`** (200+ lines added)
   - New functions to encrypt existing plaintext emails and phones in users and merchants tables

3. **`src/tests/encryption.test.ts`** (150+ lines added)
   - Comprehensive tests for email/phone encryption with various formats and edge cases

4. **`migrations/20261101_encrypt_email_phone_pii.sql`** (new file)
   - Schema migration marking columns as PII for audit trail

## Deployment Steps

### Step 1: Review & Test (Dev/Staging)
```bash
# Review changes
git log --oneline -1  # Should show PII encryption fix commit

# Run encryption tests (verify they pass)
npm test -- src/tests/encryption.test.ts --testNamePattern="Email and Phone"
```

### Step 2: Backup Production Database
```bash
# Before running migration, backup:
npm run backup:create
```

### Step 3: Deploy Code
```bash
# Deploy updated code with new PII_FIELDS definition
git push origin main
# (or your deployment process)
```

### Step 4: Run Data Migration
```bash
# Encrypts existing plaintext emails and phones
npm run encrypt:existing-data

# Output should show something like:
# User phone number migration complete: 1234 encrypted, 56 already encrypted, 0 errors
# User email migration complete: 2345 encrypted, 123 already encrypted, 0 errors
# Merchant phone number migration complete: 567 encrypted, 89 already encrypted, 0 errors
# Merchant email migration complete: 890 encrypted, 234 already encrypted, 0 errors
```

### Step 5: Run Schema Migration
```bash
# Applies schema comments marking columns as PII
npm run migrate:up
```

### Step 6: Verify
```bash
# Test that everything still works:
# 1. Try logging in (tests phone_number decryption)
# 2. Create a merchant (tests email/phone encryption on write)
# 3. View merchant profile (tests email/phone decryption on read)

# Check for any errors in application logs
# Should NOT see: "PII decryption failed"
```

## Code Impact for Developers

**Good news**: If your code already uses the middleware, it now handles email and phone automatically.

### ✅ Already Protected (No Changes Needed)
```typescript
// This now encrypts email and phone_number too:
const encrypted = encryptPiiFields(row);
await db.insert(encrypted);

// This now decrypts email and phone_number too:
const result = await db.query(...);
const decrypted = decryptPiiFields(result.rows[0]);
// decrypted.email and decrypted.phone_number are now plaintext
```

### ⚠️ Direct Database Access (Need Review)
```typescript
// BAD: Reads encrypted data without decryption
const rows = await db.query("SELECT email, phone_number FROM merchants WHERE id = $1", [id]);
// rows[0].email is encrypted ❌

// GOOD: Encrypts before writing
const row = { email: "user@example.com", phone_number: "+237671234567" };
const encrypted = encryptPiiFields(row);
await db.query("INSERT INTO merchants (...) VALUES ($1, $2, ...)", [encrypted.email, encrypted.phone_number, ...]);
// ✅
```

## Troubleshooting

### "PII decryption failed" Error
- Application tried to read encrypted data without decryption
- **Solution**: Wrap the database result with `decryptPiiFields()`

### Data Migration Fails
```bash
# Re-run with debugging:
DB_ENCRYPTION_KEY=$(echo $DB_ENCRYPTION_KEY) npm run encrypt:existing-data

# Check error logs for specific rows that failed
# Fix the issue, re-run (skips already-encrypted rows)
```

### Some Emails/Phones Still Show Plaintext
- Run the data migration again (idempotent, skips already-encrypted)
- Verify `DB_ENCRYPTION_KEY` environment variable is set correctly

## Verification Checklist

- [ ] Code changes reviewed
- [ ] Database backed up
- [ ] Data migration ran successfully (check logs)
- [ ] Schema migration applied
- [ ] User login works (phone decryption)
- [ ] Merchant creation works (email/phone encryption)
- [ ] Merchant profile view works (email/phone decryption)
- [ ] No "decryption failed" errors in logs
- [ ] Spot check database: no plaintext emails (use audit queries)

## Documentation

For detailed information, see:
- **Full Summary**: `PII_ENCRYPTION_FIX_SUMMARY.md`
- **Audit Report**: `PII_FIELD_AUDIT.md`
- **Code**: `src/middleware/piiEncryption.ts`
- **Tests**: `src/tests/encryption.test.ts` (search for "Email and Phone")

## Questions?

Refer to the **Troubleshooting** section in `PII_ENCRYPTION_FIX_SUMMARY.md` for more details.

---

**Status**: ✅ Ready for production deployment  
**Risk Level**: Low (backward-compatible, data-preserving)  
**Rollback**: Reversible (down migration provided)
