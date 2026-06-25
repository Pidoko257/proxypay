-- Rollback: 20260101000001_initial_schema
DROP TRIGGER IF EXISTS users_updated_at ON users;
DROP FUNCTION IF EXISTS update_users_updated_at();
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS users;
