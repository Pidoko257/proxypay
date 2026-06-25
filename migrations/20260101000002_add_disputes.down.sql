-- Rollback: 20260101000002_add_disputes
DROP TRIGGER IF EXISTS disputes_updated_at ON disputes;
DROP FUNCTION IF EXISTS update_disputes_updated_at();
DROP TABLE IF EXISTS dispute_notes;
DROP TABLE IF EXISTS disputes;
