-- Rollback: 20260428000001_create_exchange_rate_buffers
DROP TRIGGER IF EXISTS erb_updated_at ON exchange_rate_buffers;
DROP FUNCTION IF EXISTS update_erb_updated_at();
DROP TABLE IF EXISTS exchange_rate_buffer_audit;
DROP TABLE IF EXISTS exchange_rate_buffers;
