-- Migration: 20260625_enable_rls_tenant_isolation
-- Description: Add organization_id to tenant-scoped tables and enable Row-Level
--              Security (RLS) so queries for one tenant cannot return data for
--              another, even if application-level filtering is bypassed.
--
-- Tables affected: transactions, api_keys, merchant_webhooks, kyc_documents
--
-- The application must call:
--   SET LOCAL app.current_tenant_id = '<org-uuid>';
-- inside a transaction before issuing any DML on these tables.

-- ─── 1. organisations table (root of tenancy) ────────────────────────────────
CREATE TABLE IF NOT EXISTS organisations (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ─── 2. Add organization_id to each tenant-scoped table ──────────────────────

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organisations(id);

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organisations(id);

ALTER TABLE merchant_webhooks
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organisations(id);

ALTER TABLE kyc_documents
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organisations(id);

-- Indexes for efficient RLS policy evaluation
CREATE INDEX IF NOT EXISTS idx_transactions_org     ON transactions     (organization_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_org         ON api_keys         (organization_id);
CREATE INDEX IF NOT EXISTS idx_merchant_webhooks_org ON merchant_webhooks (organization_id);
CREATE INDEX IF NOT EXISTS idx_kyc_documents_org    ON kyc_documents    (organization_id);

-- ─── 3. Enable RLS on each table ─────────────────────────────────────────────

ALTER TABLE transactions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys         ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE kyc_documents    ENABLE ROW LEVEL SECURITY;

-- Force RLS for table owners too (prevents privilege-escalation bypass)
ALTER TABLE transactions      FORCE ROW LEVEL SECURITY;
ALTER TABLE api_keys          FORCE ROW LEVEL SECURITY;
ALTER TABLE merchant_webhooks FORCE ROW LEVEL SECURITY;
ALTER TABLE kyc_documents     FORCE ROW LEVEL SECURITY;

-- ─── 4. Helper function: read current tenant from session variable ────────────

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS UUID AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', TRUE), '')::UUID;
$$ LANGUAGE sql STABLE;

-- ─── 5. RLS policies ─────────────────────────────────────────────────────────
-- Each policy applies to ALL operations (SELECT, INSERT, UPDATE, DELETE).
-- Rows without organization_id are visible only when no tenant is set
-- (e.g. migrations / seeds running without a tenant context).

-- transactions
DROP POLICY IF EXISTS tenant_isolation ON transactions;
CREATE POLICY tenant_isolation ON transactions
  USING     (organization_id = current_tenant_id())
  WITH CHECK (organization_id = current_tenant_id());

-- api_keys
DROP POLICY IF EXISTS tenant_isolation ON api_keys;
CREATE POLICY tenant_isolation ON api_keys
  USING     (organization_id = current_tenant_id())
  WITH CHECK (organization_id = current_tenant_id());

-- merchant_webhooks
DROP POLICY IF EXISTS tenant_isolation ON merchant_webhooks;
CREATE POLICY tenant_isolation ON merchant_webhooks
  USING     (organization_id = current_tenant_id())
  WITH CHECK (organization_id = current_tenant_id());

-- kyc_documents
DROP POLICY IF EXISTS tenant_isolation ON kyc_documents;
CREATE POLICY tenant_isolation ON kyc_documents
  USING     (organization_id = current_tenant_id())
  WITH CHECK (organization_id = current_tenant_id());

-- ─── Down migration ───────────────────────────────────────────────────────────
-- To rollback:
-- ALTER TABLE transactions      DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE api_keys          DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE merchant_webhooks DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE kyc_documents     DISABLE ROW LEVEL SECURITY;
-- DROP POLICY IF EXISTS tenant_isolation ON transactions;
-- DROP POLICY IF EXISTS tenant_isolation ON api_keys;
-- DROP POLICY IF EXISTS tenant_isolation ON merchant_webhooks;
-- DROP POLICY IF EXISTS tenant_isolation ON kyc_documents;
-- ALTER TABLE transactions      DROP COLUMN IF EXISTS organization_id;
-- ALTER TABLE api_keys          DROP COLUMN IF EXISTS organization_id;
-- ALTER TABLE merchant_webhooks DROP COLUMN IF EXISTS organization_id;
-- ALTER TABLE kyc_documents     DROP COLUMN IF EXISTS organization_id;
-- DROP FUNCTION IF EXISTS current_tenant_id();
-- DROP TABLE IF EXISTS organisations;
