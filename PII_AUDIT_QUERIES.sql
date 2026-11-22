-- PII Encryption Audit Queries
-- Use these to verify that sensitive fields are properly encrypted

-- WARNING: Running these queries on production may reveal plaintext PII.
-- Only run in secure environments with proper access controls.

-- ============================================================================
-- 1. CHECK FOR PLAINTEXT EMAILS (should return 0 rows)
-- ============================================================================
-- Email format: user@domain.com (contains @, plaintext pattern)
-- Encrypted emails: versionX:hexstring:hexstring:hexstring (no @)

SELECT id, email, 'ALERT: PLAINTEXT EMAIL' as alert_type
FROM users
WHERE email IS NOT NULL 
  AND email ~ '@'  -- PostgreSQL regex: contains @
  AND NOT email ~ ':+:'  -- NOT encrypted format (contains colons)
LIMIT 100;

SELECT id, email, 'ALERT: PLAINTEXT EMAIL' as alert_type
FROM merchants
WHERE email IS NOT NULL 
  AND email ~ '@'
  AND NOT email ~ ':+:'
LIMIT 100;

-- ============================================================================
-- 2. CHECK FOR PLAINTEXT PHONE NUMBERS (should return 0 rows)
-- ============================================================================
-- Phone patterns: +237XXXXXXXXX, 06XXXXXXXX, etc. (contains digits)
-- Encrypted phones: versionX:hexstring:hexstring:hexstring (hex only)

SELECT id, phone_number, 'ALERT: PLAINTEXT PHONE' as alert_type
FROM users
WHERE phone_number IS NOT NULL 
  AND phone_number !~ ':+'  -- NOT encrypted (no colons)
  AND phone_number ~ '[0-9]'  -- Contains digits (plaintext indicator)
LIMIT 100;

SELECT id, phone_number, 'ALERT: PLAINTEXT PHONE' as alert_type
FROM merchants
WHERE phone_number IS NOT NULL 
  AND phone_number !~ ':+'
  AND phone_number ~ '[0-9]'
LIMIT 100;

SELECT id, phone_number, 'ALERT: PLAINTEXT PHONE' as alert_type
FROM transactions
WHERE phone_number IS NOT NULL 
  AND phone_number !~ ':+'
  AND phone_number ~ '[0-9]'
LIMIT 100;

-- ============================================================================
-- 3. ENCRYPTION STATUS SUMMARY
-- ============================================================================

-- Users table encryption status
WITH email_status AS (
  SELECT 
    COUNT(*) as total_rows,
    SUM(CASE WHEN email IS NULL THEN 1 ELSE 0 END) as null_emails,
    SUM(CASE WHEN email ~ ':+:' THEN 1 ELSE 0 END) as encrypted_emails,
    SUM(CASE WHEN email IS NOT NULL AND email !~ ':+:' THEN 1 ELSE 0 END) as plaintext_emails
  FROM users
),
phone_status AS (
  SELECT 
    COUNT(*) as total_rows,
    SUM(CASE WHEN phone_number IS NULL THEN 1 ELSE 0 END) as null_phones,
    SUM(CASE WHEN phone_number ~ ':+:' THEN 1 ELSE 0 END) as encrypted_phones,
    SUM(CASE WHEN phone_number IS NOT NULL AND phone_number !~ ':+:' THEN 1 ELSE 0 END) as plaintext_phones
  FROM users
)
SELECT 'users' as table_name,
       e.total_rows,
       e.null_emails as null_emails,
       e.encrypted_emails as encrypted_emails,
       e.plaintext_emails as plaintext_emails,
       p.encrypted_phones as encrypted_phones,
       p.plaintext_phones as plaintext_phones
FROM email_status e, phone_status p;

-- Merchants table encryption status
WITH email_status AS (
  SELECT 
    COUNT(*) as total_rows,
    SUM(CASE WHEN email IS NULL THEN 1 ELSE 0 END) as null_emails,
    SUM(CASE WHEN email ~ ':+:' THEN 1 ELSE 0 END) as encrypted_emails,
    SUM(CASE WHEN email IS NOT NULL AND email !~ ':+:' THEN 1 ELSE 0 END) as plaintext_emails
  FROM merchants
),
phone_status AS (
  SELECT 
    COUNT(*) as total_rows,
    SUM(CASE WHEN phone_number IS NULL THEN 1 ELSE 0 END) as null_phones,
    SUM(CASE WHEN phone_number ~ ':+:' THEN 1 ELSE 0 END) as encrypted_phones,
    SUM(CASE WHEN phone_number IS NOT NULL AND phone_number !~ ':+:' THEN 1 ELSE 0 END) as plaintext_phones
  FROM merchants
)
SELECT 'merchants' as table_name,
       e.total_rows,
       e.null_emails as null_emails,
       e.encrypted_emails as encrypted_emails,
       e.plaintext_emails as plaintext_emails,
       p.encrypted_phones as encrypted_phones,
       p.plaintext_phones as plaintext_phones
FROM email_status e, phone_status p;

-- Transactions table encryption status (phone_number only)
SELECT 'transactions' as table_name,
       COUNT(*) as total_rows,
       SUM(CASE WHEN phone_number IS NULL THEN 1 ELSE 0 END) as null_phones,
       SUM(CASE WHEN phone_number ~ ':+:' THEN 1 ELSE 0 END) as encrypted_phones,
       SUM(CASE WHEN phone_number IS NOT NULL AND phone_number !~ ':+:' THEN 1 ELSE 0 END) as plaintext_phones
FROM transactions;

-- ============================================================================
-- 4. VERIFY ENCRYPTION FORMAT
-- ============================================================================
-- Expected format after encryption: VERSION:IV:CIPHERTEXT:AUTHTAG
-- Each component is hex-encoded (0-9, a-f)

-- Sample encrypted values
SELECT 'Sample encrypted emails from users' as check_type,
       email as sample_value,
       LENGTH(email) as length,
       CASE 
         WHEN email ~ ':+:' THEN 'Valid format'
         ELSE 'Invalid format'
       END as format_check
FROM users
WHERE email IS NOT NULL
  AND email ~ ':+:'
LIMIT 5;

SELECT 'Sample encrypted phones from merchants' as check_type,
       phone_number as sample_value,
       LENGTH(phone_number) as length,
       CASE 
         WHEN phone_number ~ ':+:' THEN 'Valid format'
         ELSE 'Invalid format'
       END as format_check
FROM merchants
WHERE phone_number IS NOT NULL
  AND phone_number ~ ':+:'
LIMIT 5;

-- ============================================================================
-- 5. FIND ROWS WITH MISSING ENCRYPTION
-- ============================================================================
-- Returns all rows where PII fields exist but are not encrypted

SELECT 
  'users' as table_name,
  id,
  CASE WHEN email IS NOT NULL AND email !~ ':+:' THEN 'email' END as unencrypted_field,
  email as field_value
FROM users
WHERE email IS NOT NULL AND email !~ ':+:'
UNION ALL
SELECT 
  'merchants' as table_name,
  id,
  CASE WHEN email IS NOT NULL AND email !~ ':+:' THEN 'email' END as unencrypted_field,
  email as field_value
FROM merchants
WHERE email IS NOT NULL AND email !~ ':+:'
ORDER BY table_name, id;

-- ============================================================================
-- 6. DISTRIBUTION OF ENCRYPTED vs PLAINTEXT (High Level)
-- ============================================================================

SELECT 
  'users' as table_name,
  'phone_number' as column_name,
  COUNT(*) as total,
  SUM(CASE WHEN phone_number IS NULL THEN 1 ELSE 0 END) as null_count,
  SUM(CASE WHEN phone_number ~ ':+:' THEN 1 ELSE 0 END) as encrypted_count,
  SUM(CASE WHEN phone_number IS NOT NULL AND phone_number !~ ':+:' THEN 1 ELSE 0 END) as plaintext_count,
  ROUND(100.0 * SUM(CASE WHEN phone_number ~ ':+:' THEN 1 ELSE 0 END) / 
        NULLIF(COUNT(*), 0), 2) as encryption_percent
FROM users
UNION ALL
SELECT 
  'users' as table_name,
  'email' as column_name,
  COUNT(*) as total,
  SUM(CASE WHEN email IS NULL THEN 1 ELSE 0 END) as null_count,
  SUM(CASE WHEN email ~ ':+:' THEN 1 ELSE 0 END) as encrypted_count,
  SUM(CASE WHEN email IS NOT NULL AND email !~ ':+:' THEN 1 ELSE 0 END) as plaintext_count,
  ROUND(100.0 * SUM(CASE WHEN email ~ ':+:' THEN 1 ELSE 0 END) / 
        NULLIF(COUNT(*), 0), 2) as encryption_percent
FROM users
UNION ALL
SELECT 
  'merchants' as table_name,
  'phone_number' as column_name,
  COUNT(*) as total,
  SUM(CASE WHEN phone_number IS NULL THEN 1 ELSE 0 END) as null_count,
  SUM(CASE WHEN phone_number ~ ':+:' THEN 1 ELSE 0 END) as encrypted_count,
  SUM(CASE WHEN phone_number IS NOT NULL AND phone_number !~ ':+:' THEN 1 ELSE 0 END) as plaintext_count,
  ROUND(100.0 * SUM(CASE WHEN phone_number ~ ':+:' THEN 1 ELSE 0 END) / 
        NULLIF(COUNT(*), 0), 2) as encryption_percent
FROM merchants
UNION ALL
SELECT 
  'merchants' as table_name,
  'email' as column_name,
  COUNT(*) as total,
  SUM(CASE WHEN email IS NULL THEN 1 ELSE 0 END) as null_count,
  SUM(CASE WHEN email ~ ':+:' THEN 1 ELSE 0 END) as encrypted_count,
  SUM(CASE WHEN email IS NOT NULL AND email !~ ':+:' THEN 1 ELSE 0 END) as plaintext_count,
  ROUND(100.0 * SUM(CASE WHEN email ~ ':+:' THEN 1 ELSE 0 END) / 
        NULLIF(COUNT(*), 0), 2) as encryption_percent
FROM merchants
ORDER BY table_name, column_name;

-- ============================================================================
-- 7. VERIFY COLUMN COMMENTS (PII MARKERS)
-- ============================================================================

SELECT table_name, column_name, col_description((table_schema||'.'||table_name)::regclass, ordinal_position) as comment
FROM information_schema.columns
WHERE (
  (table_name IN ('users', 'merchants', 'transactions') AND column_name IN ('email', 'phone_number', 'name', 'address', 'id_number'))
)
ORDER BY table_name, ordinal_position;

-- ============================================================================
-- 8. RECOVERY: SHOW ROWS TO INVESTIGATE IF NEEDED
-- ============================================================================
-- Use this to find specific rows with potential issues

-- Show first user with email
SELECT id, email, phone_number, created_at, updated_at
FROM users
WHERE email IS NOT NULL
LIMIT 1;

-- Show first merchant with all PII
SELECT id, name, email, phone_number, address, created_at, updated_at
FROM merchants
WHERE email IS NOT NULL
LIMIT 1;

-- ============================================================================
-- NOTES:
-- ============================================================================
-- 1. Encrypted values match pattern: ':+:' (contain colons as separators)
-- 2. Plaintext emails contain '@' symbol
-- 3. Plaintext phones contain digits (0-9)
-- 4. NULL values are expected and OK (not counted as unencrypted)
-- 5. For sensitive rows, never output the actual values in logs
-- 6. If plaintext is found, run: npm run encrypt:existing-data
