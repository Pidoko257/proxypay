-- Rollback: 20261119_add_users_dashboard_config

ALTER TABLE users DROP COLUMN IF EXISTS dashboard_config;
