-- Migration: 20261119_add_users_dashboard_config
-- Persist per-user admin dashboard configuration (previously held in an
-- in-memory array in src/routes/admin.ts and lost on restart).

ALTER TABLE users ADD COLUMN IF NOT EXISTS dashboard_config JSONB;
