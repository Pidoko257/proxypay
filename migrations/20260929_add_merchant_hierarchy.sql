-- Migration: Add merchant hierarchy / sub-account support
-- Date: 2026-09-29

ALTER TABLE merchants ADD COLUMN IF NOT EXISTS parent_merchant_id UUID REFERENCES merchants(id) ON DELETE RESTRICT;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS hierarchy_level INTEGER NOT NULL DEFAULT 0;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS hierarchy_path TEXT;  -- materialized path like '/{root-id}/{parent-id}/{self-id}'
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS max_sub_accounts INTEGER DEFAULT 10;  -- limit sub-accounts per merchant

CREATE INDEX IF NOT EXISTS idx_merchants_parent_id ON merchants(parent_merchant_id);
CREATE INDEX IF NOT EXISTS idx_merchants_hierarchy_path ON merchants USING BTREE(hierarchy_path);
