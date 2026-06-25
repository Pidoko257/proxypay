-- Rollback: 20260530000001_create_multisig_key_recovery
DROP TRIGGER IF EXISTS key_recovery_sessions_updated_at ON key_recovery_sessions;
DROP TRIGGER IF EXISTS managed_keys_updated_at ON managed_keys;
DROP FUNCTION IF EXISTS update_updated_at_column();
DROP TABLE IF EXISTS key_recovery_audit_log;
DROP TABLE IF EXISTS key_recovery_sessions;
DROP TYPE IF EXISTS recovery_session_state;
DROP TABLE IF EXISTS recovery_tokens;
DROP TABLE IF EXISTS recovery_signers;
DROP TABLE IF EXISTS managed_keys;
