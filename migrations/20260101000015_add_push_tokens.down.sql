-- Rollback: 20260101000015_add_push_tokens
DROP TRIGGER IF EXISTS push_tokens_updated_at ON push_tokens;
DROP FUNCTION IF EXISTS update_push_tokens_updated_at();
DROP TABLE IF EXISTS push_tokens;
