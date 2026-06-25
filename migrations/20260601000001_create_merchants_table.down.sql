-- Rollback: 20260601000001_create_merchants_table
DROP TABLE IF EXISTS merchant_batch_jobs;
DROP TRIGGER IF EXISTS merchants_updated_at ON merchants;
DROP FUNCTION IF EXISTS update_merchants_updated_at();
DROP TABLE IF EXISTS merchants;
