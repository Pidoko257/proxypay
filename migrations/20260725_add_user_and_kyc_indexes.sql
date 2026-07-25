-- Migration: 20260725_add_user_and_kyc_indexes
-- Issue: #169 - Create Database Indexing Strategy
-- Description: Add missing indexes for user lookup, KYC status queries,
--              and composite transaction-user patterns identified via slow-query analysis.
--
-- All production-critical indexes use CONCURRENTLY to avoid table locks.
-- Safe to re-run: IF NOT EXISTS guards every statement.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. User email lookup (encrypted column — partial index on non-NULL rows)
--    Speeds up: auth login by email, UserModel.findByEmail(),
--               admin search, webhook delivery address lookup.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email
  ON users (email)
  WHERE email IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. User KYC status (workflow state: pending / approved / rejected)
--    Speeds up: KYC admin dashboard filtering, kycTierUpgradeService,
--               compliance queries WHERE kyc_status = 'pending'.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_kyc_status
  ON users (kyc_status)
  WHERE kyc_status IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. User account status (active / frozen / suspended)
--    Speeds up: checkAccountStatus middleware, admin active-user queries,
--               freeze/suspend operations.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_status
  ON users (status);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. User creation date (admin pagination, user growth reports)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_created_at
  ON users (created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Composite: (kyc_level, created_at DESC)
--    Speeds up: KYC admin list filtered by tier sorted newest-first,
--               kycTierUpgradeJob batch processing (oldest unverified first).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_kyc_level_created
  ON users (kyc_level, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Composite: (status, created_at DESC)
--    Speeds up: admin active/suspended user lists with date ordering.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_status_created
  ON users (status, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Transaction (user_id, status) composite
--    Speeds up: user dashboard "show only pending/failed",
--               daily limit enforcement (count pending per user),
--               fraud detection (count failed for user in window).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_user_status
  ON transactions (user_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Covering index: (user_id, status, created_at DESC) + INCLUDE columns
--    Satisfies the most common user-dashboard query via index-only scan:
--      SELECT id, type, amount, provider, status, created_at
--      FROM transactions
--      WHERE user_id = $1 AND status = $2
--      ORDER BY created_at DESC LIMIT $3 OFFSET $4
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_user_status_created_covering
  ON transactions (user_id, status, created_at DESC)
  INCLUDE (id, type, amount, provider, reference_number, updated_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Transaction type filter (deposit vs withdraw)
--    Speeds up: export routes filtering by type, SEP-06/31 deposit queries.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_type
  ON transactions (type);

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. Composite: (user_id, type, created_at DESC)
--     Speeds up: user deposit/withdrawal history split views.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_user_type_created
  ON transactions (user_id, type, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK SCRIPT (run each DROP individually if needed):
-- DROP INDEX CONCURRENTLY IF EXISTS idx_users_email;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_users_kyc_status;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_users_status;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_users_created_at;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_users_kyc_level_created;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_users_status_created;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_transactions_user_status;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_transactions_user_status_created_covering;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_transactions_type;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_transactions_user_type_created;
